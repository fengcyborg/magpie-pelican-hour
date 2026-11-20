import { createHash } from 'node:crypto';

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
  return Math.floor((at + 480 * minute) / day) * day - 480 * minute;
}

export function dayType(at) {
  const date = new Date(at + 480 * minute);
  const rules = calendars[date.getUTCFullYear()];
  const md = (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  const weekend = [0,6].includes(date.getUTCDay());
  if (rules?.workdays.includes(md)) return { rest: false, label: '调休补班日', official: true };
  if (rules?.holidays.some(([first,last]) => first <= md && md <= last)) return { rest: true, label: '节假日', official: true };
  return { rest: weekend, label: weekend ? '周末休息日' : '工作日', official: Boolean(rules) };
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
  if (settings.distribution === 'custom') return [...settings.times].sort((a,b) => a-b);
  const ranges = availableRanges(quiet);
  const total = ranges.reduce((sum,[a,b]) => sum+b-a,0);
  const seed = createHash('sha256').update(accountId+'@'+startOfDay).digest();
  // Choose from the central half of each equal slice of available time. The
  // account/day seed keeps previews and restarts consistent without storing draws.
  return Array.from({length: settings.count}, (_,i) => {
    const first = Math.floor(i*total/settings.count);
    const width = Math.floor((i+1)*total/settings.count)-first;
    const edge = Math.floor(width/4);
    const ordinal = first + edge + seed.readUInt32BE(i*4) % (width-2*edge);
    const [a,b] = ranges[0];
    return ordinal < b-a ? a+ordinal : ranges[1][0]+ordinal-(b-a);
  });
}
