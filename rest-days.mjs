import { createHash } from 'node:crypto';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const regionalCalendars = JSON.parse(readFileSync(new URL('./calendars.json', import.meta.url), 'utf8'));
export const regions = ['CN', ...Object.keys(regionalCalendars)].sort();
export const defaultCalendar = Object.freeze({ region: 'auto', overrides: {} });
export function hostLocale() {
  // A GUI app on macOS may start with a C/POSIX shell locale.
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 1500 });
      const first = output.match(/[a-z]{2,3}(?:-[A-Za-z0-9]+)*/i)?.[0];
      if (first) {
        const language = new Intl.Locale(first);
        if (language.region) return language.toString();
        const format = execFileSync('/usr/bin/defaults', ['read','-g','AppleLocale'], {encoding:'utf8',timeout:1500});
        const region = new Intl.Locale(format.trim().split('@')[0].replaceAll('_','-')).region;
        return new Intl.Locale(language,{region}).toString();
      }
    } catch { /* Fall back to the host runtime. */ }
  } else if (process.platform === 'linux') {
    const config = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const files = [join(config, 'locale.conf')];
    if (/^[\w.-]+$/.test(process.env.USER || '')) files.push(join('/var/lib/AccountsService/users', process.env.USER));
    for (const file of files) {
      try {
        const values = Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/^(Language|LANGUAGE|LC_ALL|LC_MESSAGES|LANG)=["']?([^"'#\s]+)/gm)]
          .map(match => [match[1], match[2]]));
        const tag = (values.Language || values.LANGUAGE || values.LC_ALL || values.LC_MESSAGES || values.LANG || '').split(/[:.@]/)[0];
        if (tag) return new Intl.Locale(tag.replaceAll('_', '-')).toString();
      } catch { continue; }
    }
  } else if (process.platform === 'win32') {
    try {
      const tag = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '[System.Globalization.CultureInfo]::CurrentUICulture.Name'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
      return new Intl.Locale(tag).toString();
    } catch { /* Fall back to the host runtime. */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}
export const hostLanguage = hostLocale();
export function languageRegion(tag) {
  try { return new Intl.Locale(tag).maximize().region || 'CN'; }
  catch { return 'CN'; }
}
export function dateKey(at) {
  const d = new Date(at);
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}
export function validCalendar(value) {
  if (!value || !(value.region === 'auto' || regions.includes(value.region)) ||
      !value.overrides || typeof value.overrides !== 'object' || Array.isArray(value.overrides)) return false;
  return Object.entries(value.overrides).every(([date, type]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['rest','work'].includes(type)) return false;
    const time = Date.parse(date + 'T12:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === date;
  });
}
export function localMinute(start, minutes) {
  const d = new Date(start);
  return d.setHours(0, minutes, 0, 0);
}

export const minute = 60000;
export const day = 1440 * minute;
export const defaultRestSchedule = Object.freeze({ enabled: false, count: 3, distribution: 'even', times: [] });

// State Council General Office notices 国办发明电〔2025〕7号 and 〔2026〕10号.
// Ranges are inclusive. Explicit make-up workdays take precedence over weekends.
const calendars = {
  2026: {
    holidays: [[101,103],[215,223],[404,406],[501,505],[619,621],[925,927],[1001,1007]],
    workdays: [104,214,228,509,920,1010]
  },
  2027: {
    holidays: [[101,103],[205,213],[403,405],[501,505],[609,609],[915,915],[1001,1007]],
    workdays: [131,214,508,926,1009]
  }
};

export function midnight(at) {
  return localMinute(at, 0);
}

export function dayType(at, region = 'CN', overrides = {}) {
  const date = new Date(at);
  const year = date.getFullYear();
  const md = (date.getMonth()+1)*100 + date.getDate();
  const regional = regionalCalendars[region];
  const cn = region === 'CN' && calendars[year];
  const rules = regional?.years[year];
  const official = Boolean(cn || rules);
  const override = overrides[dateKey(at)];
  if (override) return { rest: override === 'rest', label: override === 'rest' ? '自定休息日' : '自定工作日', official };
  if (cn?.workdays?.includes(md) || rules?.work.includes(md)) return { rest: false, label: '调休补班日', official };
  if (cn?.holidays?.some(([a,b]) => a <= md && md <= b) || rules?.rest.includes(md)) return { rest: true, label: '节假日', official };
  const rest = (regional?.weekend || [0,6]).includes(date.getDay());
  return { rest, label: rest ? '周末休息日' : '工作日', official };
}

function availableRanges(quiet) {
  if (!quiet.enabled) return [[0,1440]];
  if (quiet.start > quiet.end) return [[quiet.end,quiet.start]];
  return [[0,quiet.start],[quiet.end,1440]];
}

export function validRestSchedule(settings, quiet) {
  if (!settings || typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.count) ||
      settings.count < 1 || settings.count > 8 || !Array.isArray(settings.times)) return false;
  const ranges = availableRanges(quiet);
  if (settings.distribution === 'even') return settings.times.length === 0 &&
    (!settings.enabled || ranges.reduce((sum,[a,b]) => sum+b-a,0) >= settings.count);
  if (settings.distribution !== 'custom' || settings.times.length !== settings.count ||
      new Set(settings.times).size !== settings.count) return false;
  return settings.times.every(m => Number.isInteger(m) && m >= 0 && m < 1440 &&
    (!settings.enabled || ranges.some(([a,b]) => a <= m && m < b)));
}

export function sampleMinutes(settings, quiet, startOfDay, accountId) {
  const offsetChanges = new Date(startOfDay).getTimezoneOffset() !== new Date(localMinute(startOfDay,1440)).getTimezoneOffset();
  const exists = m => {
    const clock = new Date(localMinute(startOfDay,m));
    return clock.getHours()*60 + clock.getMinutes() === m;
  };
  if (settings.distribution === 'custom') return settings.times.filter(m => !offsetChanges || exists(m)).sort((a,b) => a-b);
  const ranges = availableRanges(quiet);
  const validMinutes = offsetChanges ? ranges.flatMap(([a,b]) => Array.from({length:b-a},(_,i)=>a+i).filter(exists)) : null;
  const total = validMinutes?.length ?? ranges.reduce((sum,[a,b]) => sum+b-a,0);
  const count = Math.min(settings.count,total);
  const seed = createHash('sha256').update(accountId+'@'+startOfDay).digest();
  // Choose from the central half of each equal slice of available time. The
  // account/day seed keeps previews and restarts consistent without storing draws.
  return Array.from({length: count}, (_,i) => {
    const first = Math.floor(i*total/count);
    const width = Math.floor((i+1)*total/count)-first;
    const edge = Math.floor(width/4);
    const ordinal = first + edge + seed.readUInt32BE(i*4) % (width-2*edge);
    if (validMinutes) return validMinutes[ordinal];
    const [a,b] = ranges[0];
    return ordinal < b-a ? a+ordinal : ranges[1][0]+ordinal-(b-a);
  });
}
