import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { minute, midnight, localMinute, dateKey, dayType, defaultCalendar, validCalendar, hostLanguage, languageRegion, regions, sampleMinutes, defaultRestSchedule, validRestSchedule } from './rest-days.mjs';

export const hour = 3600000;
const defaultQuietHours = Object.freeze({ enabled: false, start: 23 * 60, end: 7 * 60 });

// A local civil day can have 23 or 25 hours at a daylight-saving transition.
function inQuietPeriod(settings, at) {
  const d = new Date(at);
  const m = d.getHours()*60 + d.getMinutes();
  return settings.start < settings.end ? m >= settings.start && m < settings.end : m >= settings.start || m < settings.end;
}
export function quietWindow(settings, now) {
  if (!settings?.enabled) return null;
  let base = midnight(now);
  // A repeated hour can contain two separate quiet windows. Resolve boundaries
  // on the real timeline on transition days, including skipped wall-clock times.
  if (new Date(localMinute(base,-1440)).getTimezoneOffset() !== new Date(localMinute(base,2880)).getTimezoneOffset()) {
    let start = Math.floor(now/minute)*minute;
    if (inQuietPeriod(settings,start)) {
      while (inQuietPeriod(settings,start-minute)) start -= minute;
    } else {
      while (!inQuietPeriod(settings,start)) start += minute;
    }
    let end = Math.max(start,Math.floor(now/minute)*minute)+minute;
    while (inQuietPeriod(settings,end)) end += minute;
    return {start,end};
  }
  if (localMinute(base, settings.start) > now) base = localMinute(base, -1440);
  const window = day => ({
    start: localMinute(day, settings.start),
    end: localMinute(day, settings.end + (settings.end < settings.start ? 1440 : 0))
  });
  const current = window(base);
  return now < current.end ? current : window(localMinute(base, 1440));
}

function scheduledTime(slot, first, low, high, quiet) {
  if (!quiet?.enabled) return slot * hour + randomInt(low, high + 1) * minute;
  // Include tomorrow's corresponding hour for narrow daily availability.
  for (let offset = 0; offset <= 24; offset++) {
    const base = (slot + offset) * hour;
    const allowed = [];
    for (let m = offset ? 1 : first; m <= 59; m++) {
      const at = base + m * minute;
      if (!inQuietPeriod(quiet, at)) allowed.push(m);
    }
    if (!allowed.length) continue;
    const preferred = offset ? allowed : allowed.filter(m => m >= low && m <= high);
    const choices = preferred.length ? preferred : allowed;
    return base + choices[randomInt(choices.length)] * minute;
  }
  return null;
}
export const model = 'gpt-6.2-astra';
export const effort = 'xhigh';
export const prompt = readFileSync(new URL('./input.txt', import.meta.url), 'utf8').replace(/[\r\n]+$/, '');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const inputSha256 = sha256(prompt);
if (inputSha256 !== 'b916e0387805188bb37af03d537c4fa30e571efaeecf70a62cde653ca0fb1866') {
  throw new Error('插件固定提示词校验失败');
}

export function dataDirectory() {
  const parent = process.env.XDG_DATA_HOME || (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support') : join(homedir(), '.local', 'share'));
  return join(parent, 'magpie-pelican');
}

function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function writeJSON(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

function directories(root) {
  try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

const publicFields = ['id', 'accountId', 'source', 'title', 'status', 'stage', 'startedAt', 'finishedAt', 'note',
  'experimentMode', 'inputSha256', 'model', 'reasoningEffort', 'original', 'preview', 'svg', 'bytes',
  'responseText', 'thumbnail', 'thumbnailVideo', 'sourceHtmlSha256', 'trigger', 'requestedAt'];

export class Archive {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.info = readJSON(join(root, 'monitor.json'), { accounts: [] });
    this.records = new Map();
    this.paths = new Map();
    this.lastResumeAt = new Map();
    this.dailyChecks = new Map();
    const load = (path) => {
      const run = readJSON(path, null);
      if (run) {
        if (run.original) {
          const media = name => run.original.replace(/original\.html$/, name);
          const has = name => existsSync(join(dirname(path), name));
          if (has('thumbnail.mp4')) run.thumbnailVideo = media('thumbnail.mp4');
          if (has('thumbnail.png')) run.thumbnail = media('thumbnail.png');
          else if (has('thumbnail.gif')) run.thumbnail = media('thumbnail.gif');
        }
        this.rememberRun(path, run);
      }
    };
    // Prefer the account-attributed copy when old bookmarks and the account archive coexist.
    for (const id of directories(join(root, 'runs'))) load(join(root, 'runs', id, 'run.json'));
    for (const account of directories(join(root, 'accounts'))) {
      const runs = join(root, 'accounts', account, 'runs');
      for (const id of directories(runs)) load(join(runs, id, 'run.json'));
    }
  }

  saveInfo(changes) {
    const next = { ...this.info, ...changes };
    writeJSON(join(this.root, 'monitor.json'), next);
    this.info = next;
  }

  // Missing entries follow the hourly schedule. Null pauses an account, and a
  // numeric slot is the first hour eligible after the user resumes it.
  canMonitor(id, slot) {
    const from = this.info.monitoringFromSlot?.[id];
    return from !== null && (from === undefined || slot >= from);
  }

  get quietHours() {
    return this.info.quietHours || defaultQuietHours;
  }

  get restSchedule() {
    return this.info.restSchedule || defaultRestSchedule;
  }

  autoRegion(info = this.info) {
    const systemChanged = (!info.language || info.language === 'system') && info.languageHost !== hostLanguage;
    return languageRegion(systemChanged ? hostLanguage : info.calendarLocale || hostLanguage);
  }

  calendarRegion(info = this.info) {
    const region = info.calendar?.region;
    return region && region !== 'auto' ? region : this.autoRegion(info);
  }

  classify(at, info = this.info) {
    return dayType(at, this.calendarRegion(info), info.calendar?.overrides);
  }

  setLanguage(language, tag, now = Date.now()) {
    if (this.info.language === language && this.info.calendarLocale === tag && this.info.languageHost === hostLanguage) return;
    const changes = { language, calendarLocale: tag, languageHost: hostLanguage };
    if (this.restSchedule.enabled && this.calendarRegion() !== this.calendarRegion({ ...this.info, ...changes })) {
      changes.nextByAccount = {};
    }
    this.planDispatches(now, changes);
  }

  setQuietHours(settings, now = Date.now(), rest = this.restSchedule, calendar = this.info.calendar || defaultCalendar) {
    const { enabled, start, end } = settings;
    if (typeof enabled !== 'boolean' || [start, end].some(t => !Number.isInteger(t) || t < 0 || t >= 1440) || start === end) return false;
    if (!validCalendar(calendar) || !validRestSchedule(rest, settings)) return false;
    const previous = this.quietHours;
    const quietChanged = enabled !== previous.enabled || start !== previous.start || end !== previous.end;
    const restChanged = JSON.stringify(this.restSchedule) !== JSON.stringify(rest);
    const calendarChanged = JSON.stringify(this.info.calendar || defaultCalendar) !== JSON.stringify(calendar);
    if (quietChanged || restChanged || calendarChanged) {
      // Reconsider plans postponed by the previous window when it is edited.
      const nextByAccount = { ...this.info.nextByAccount };
      for (const [id, at] of Object.entries(nextByAccount)) {
        if ((quietChanged && previous.enabled) || (restChanged && (this.classify(at).rest || this.classify(now).rest)) || (rest.enabled && (this.classify(at).rest !== this.classify(at,{...this.info,calendar}).rest || this.classify(now).rest !== this.classify(now,{...this.info,calendar}).rest))) delete nextByAccount[id];
      }
      this.planDispatches(now, { quietHours: { enabled, start, end }, restSchedule: rest, calendar, nextByAccount });
    }
    return true;
  }

  planDispatches(now, changes = {}) {
    const info = { ...this.info, ...changes };
    // Discard unstarted final checks from older versions and cancelled resumes.
    const queued = info.switchChecks || [];
    const checks = queued.filter(check => check.trigger === 'resume' && info.monitoringFromSlot?.[check.accountId] !== null);
    if (checks.length !== queued.length) changes = { ...changes, switchChecks: checks };
    const nextByAccount = {};
    const waitingToStart = new Set(checks.map(check => check.accountId));
    for (const { id, enabled, present } of info.accounts) {
      const from = info.monitoringFromSlot?.[id];
      if (!enabled || !present || from === null || waitingToStart.has(id)) continue;
      const at = this.nextDispatch(id, now, info, from || 0);
      if (at !== null) nextByAccount[id] = at;
    }
    if (Object.keys(changes).length || JSON.stringify(info.nextByAccount) !== JSON.stringify(nextByAccount)) {
      this.saveInfo({ ...changes, nextByAccount });
    }
  }

  nextHourly(id, now, info, from, until = Infinity, since = -Infinity) {
    const slot = Math.floor(now / hour);
    const quiet = info.quietHours || defaultQuietHours;
    // Older versions finished the entire hour in a single batch.
    const resumed = this.lastResumeAt.get(id) ?? -Infinity;
    const used = this.records.has(id + '-' + slot) || Math.floor(resumed / hour) === slot || (!info.nextByAccount && info.completedSlot === slot);
    let target = Math.max(slot + Number(used), from || 0);
    const due = info.nextByAccount?.[id];
    if (Number.isSafeInteger(due) && Math.floor(due / hour) >= target && due < until && due >= since) {
      const window = quietWindow(quiet, now);
      const conflicts = window && (quietWindow(quiet, due).start <= due || (window.start <= now && due <= now));
      if (!conflicts) {
        return due;
      }
    }
    let earliest = target === slot ? Math.floor((now % hour) / minute) + 1 : 1;
    if (Math.floor(since / hour) === target) earliest = Math.max(earliest, Math.ceil((since % hour)/minute));
    if (earliest > 59) { target++; earliest = 1; }
    const previous = this.records.get(id + '-' + (target - 1));
    const started = previous ? Math.max(Date.parse(previous.startedAt), resumed) : resumed;
    const first = earliest;
    let latest = 59;
    if (Math.floor(started / hour) === target - 1) {
      const previousMinute = Math.floor((started % hour) / minute);
      if (previousMinute + 10 >= earliest) {
        earliest = Math.max(earliest, previousMinute - 10);
        latest = Math.min(latest, previousMinute + 10);
      }
    }
    return scheduledTime(target, first, earliest, latest, quiet);
  }

  nextDispatch(id, now, info, from) {
    const rest = info.restSchedule || defaultRestSchedule;
    if (!rest.enabled) return this.nextHourly(id, now, info, from);
    const quiet = info.quietHours || defaultQuietHours;
    const firstDay = midnight(Math.max(now, from * hour));
    // No plan can be more than two normal weekends away, even with an
    // hourly window that only permits minute zero.
    for (let start = firstDay, n = 0; n < 15; start = localMinute(start,1440), n++) {
      const end = localMinute(start,1440);
      if (!this.classify(start,info).rest) {
        const at = this.nextHourly(id, now, info, Math.max(from, Math.floor(start/hour)), end, start);
        if (at !== null && at < end) return at;
        continue;
      }
      if ((this.dailyChecks.get(id+'@'+start) || 0) >= rest.count) continue;
      const points = sampleMinutes(rest, quiet, start, id);
      for (let i=0; i<points.length; i++) {
        const at = localMinute(start,points[i]);
        if (at < from*hour || this.records.has(id+'-sample-'+Math.floor(at/minute))) continue;
        if (at >= Math.floor(now/minute)*minute) return at;
        // A busy queue may still use its saved appointment. Never replay a
        // previous window after sleep, across a quiet period, or on another date.
        const window = quietWindow(quiet, at);
        const expires = Math.min(at+hour, localMinute(start, points[i+1] ?? 1440), window?.start ?? Infinity);
        if (at === info.nextByAccount?.[id] && now < expires) return at;
      }
    }
    return null;
  }

  setMonitoringPaused(id, paused, now = Date.now()) {
    if (!this.info.accounts.some(a => a.id === id && a.present)) return false;
    const settings = this.info.monitoringFromSlot || {};
    if ((settings[id] === null) !== paused) {
      const switchChecks = (this.info.switchChecks || []).filter(check => check.accountId !== id);
      if (!paused) switchChecks.push({ key: 'switch-' + randomUUID().replaceAll('-', ''), accountId: id,
        trigger: 'resume', requestedAt: new Date(now).toISOString() });
      // Commit the setting and its one-off check together, including across a restart.
      this.planDispatches(now, { monitoringFromSlot: { ...settings, [id]: paused ? null : Math.floor(now / hour) + 1 },
        switchChecks });
    }
    return true;
  }

  saveRun(path, run) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeJSON(path, run);
    this.rememberRun(path, run);
  }

  rememberRun(path, run) {
    if (!this.records.has(run.id) && run.source === 'magpie' && ['scheduled','rest-sample'].includes(run.trigger)) {
      const key = run.accountId+'@'+midnight(Date.parse(run.startedAt));
      this.dailyChecks.set(key, (this.dailyChecks.get(key) || 0)+1);
    }
    this.records.set(run.id, { ...run });
    this.paths.set(run.id, path);
    if (run.trigger === 'resume') {
      this.lastResumeAt.set(run.accountId, Math.max(Date.parse(run.startedAt), this.lastResumeAt.get(run.accountId) || 0));
    }
  }

  recoverInterrupted() {
    // Called only after acquiring the gallery's exclusive listening port.
    for (const run of this.records.values()) {
      if (run.source === 'magpie' && run.status === 'running') {
        this.saveRun(this.paths.get(run.id), { ...run, status: 'interrupted', stage: '运行中断',
          note: '喜鹊插件在本次检测完成前退出', finishedAt: new Date().toISOString() });
      }
    }
  }

  status(now = Date.now()) {
    const { accounts, defaultAccountId, lastDispatchAt, error } = this.info;
    const sorted = [...this.records.values()].sort((a,b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const runs = [], legacyRuns = [];
    for (const r of sorted) {
      const dest = r.accountId || r.experimentMode === 'independent' ? runs : legacyRuns;
      dest.push(Object.fromEntries(publicFields.filter(k => k in r).map(k => [k, r[k]])));
    }
    const rest = this.restSchedule;
    const today = this.classify(now);
    let previewDay = midnight(now);
    for (let n=0; n<370 && !this.classify(previewDay).rest; n++) previewDay = localMinute(previewDay,1440);
    const hasPreview = this.classify(previewDay).rest;
    const ordered = accounts.map(a => ({ ...a, monitoringPaused: this.info.monitoringFromSlot?.[a.id] === null,
      restSampleMinutes: hasPreview && rest.enabled && a.enabled && a.present && this.info.monitoringFromSlot?.[a.id] !== null
        ? sampleMinutes(rest, this.quietHours, previewDay, a.id) : [],
      pendingSwitchChecks: (this.info.switchChecks || []).filter(check => check.accountId === a.id).length,
      nextDispatchAt: this.info.nextByAccount?.[a.id] ?? null }))
      .sort((a,b) => Number(b.id === defaultAccountId) - Number(a.id === defaultAccountId) ||
      a.name.localeCompare(b.name, 'zh-CN'));
    const scheduled = ordered.map(a => a.nextDispatchAt).filter(Number.isFinite);
    const window = quietWindow(this.quietHours, now);
    return { name: '鹈鹕巡检', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, prompt, model, reasoningEffort: effort,
      runtime: 'magpie-plugin', intervalMinutes: rest.enabled && today.rest ? null : 60, scheduleStatus: 'active', defaultAccountId, accounts: ordered,
      restSchedule: rest, calendar: this.info.calendar || defaultCalendar, calendarRegion: this.calendarRegion(), autoRegion: this.autoRegion(), regions, todayKey: dateKey(now), calendarDay: today, restPreviewDay: previewDay,
      quietHours: this.quietHours, quietUntil: window && now >= window.start ? window.end : null,
      lastDispatchAt: lastDispatchAt ?? null, nextDispatchAt: scheduled.length ? Math.min(...scheduled) : null,
      monitorError: error || '', runs, legacyRuns, serverTime: new Date(now).toISOString(), pollSeconds: 5 };
  }
}

const previewStyle = readFileSync(new URL('./preview.css', import.meta.url), 'utf8');

export function extractArtwork(source) {
  // Mark the first parsed SVG. Scripts, comments and nested SVGs can contain misleading markup.
  const marker = '<!--' + randomUUID() + '-->';
  let found = false;
  const titleParts = [];
  const marked = new HTMLRewriter().on('head > title', { text(chunk) { titleParts.push(chunk.text); } }).on('svg', { element(el) {
    if (found) return;
    found = true;
    el.before(marker, { html: true });
    el.after(marker, { html: true });
  }}).transform(source);
  const [before, scene, after] = marked.split(marker);
  if (!found || after === undefined || !/(?:<\/svg\s*>|\/>)$/i.test(scene)) {
    throw new Error('原始 HTML 中没有完整的 SVG 元素');
  }
  const css = [];
  new HTMLRewriter().on('style', { text(node) { css.push(node.text); if (node.lastInTextNode) css.push('\n'); } })
    .transform(before + after);
  const styles = css.join('').replaceAll(']]>', ']]]]><![CDATA[>');
  let rootWritten = false;
  const svg = new HTMLRewriter().on('svg', { element(el) {
    if (rootWritten) return;
    rootWritten = true;
    if (!el.hasAttribute('xmlns')) el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (styles.trim()) el.prepend('<style><![CDATA[' + styles + ']]></style>', { html: true });
  }}).on('*', { element(el) {
    // HTML uses the first occurrence. An SVG served as XML must have unique attributes.
    const first = new Map();
    const repeated = new Set();
    for (const [name, value] of el.attributes) {
      if (first.has(name)) repeated.add(name);
      else first.set(name, value);
    }
    for (const name of repeated) {
      while (el.hasAttribute(name)) el.removeAttribute(name);
      el.setAttribute(name, first.get(name));
    }
  }}).transform(scene);
  const preview = before + '<style>' + previewStyle + '</style>' +
    scene.replace(/^<svg\b/i, '$& data-pelican-scene=""') + after;
  const title = titleParts.join('').replace(/\s+/g, ' ').trim();
  return { svg, preview, title };
}
