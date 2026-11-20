import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { effort, extractArtwork, hour, inputSha256, model, prompt, quietWindow, sha256 } from './archive.mjs';

import { dayType, minute } from './rest-days.mjs';

const run = promisify(execFile);
const qualifiedModel = 'codex/' + model;

async function magpieExecutable(pid) {
  if (process.platform === 'linux') return realpath('/proc/' + pid + '/exe');
  const { stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 });
  const binary = stdout.trim();
  if (!isAbsolute(binary)) throw new Error('无法定位当前喜鹊的可执行文件');
  return binary;
}

export async function listAccounts(gateway, signal) {
  const cli = await magpieExecutable(gateway.pid);
  let stdout;
  try {
    ({ stdout } = await run(cli, ['accounts', 'codex', '--json'], { signal, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }));
  } catch { throw new Error('喜鹊未能列出 Codex 官方订阅账号'); }
  const entries = new Map();
  for (const row of JSON.parse(stdout)) {
    if (row.agent !== 'codex') continue;
    const login = row.user?.trim();
    if (!login) throw new Error('喜鹊返回了缺少登录标识的账号');
    const id = sha256('codex:' + login.toLowerCase()).slice(0, 20);
    const name = row.alias || login.slice(0, 2) + '…' + id.slice(-4);
    entries.set(id, { login, active: row.active, account: { id, name, enabled: row.on === true, present: true } });
  }
  return [...entries.values()];
}

function localEndpoint(addr) {
  const url = new URL('http://' + addr);
  if (url.hostname === '0.0.0.0' || url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (url.hostname === '[::]') url.hostname = '[::1]';
  if (!/^(?:127\.\d+\.\d+\.\d+|\[::1\])$/.test(url.hostname) || !url.port || url.username || url.password) {
    throw new Error('喜鹊网关需要本机回环地址');
  }
  return new URL('/v1/responses', url);
}

function safeReason(value) {
  return String(value || '').replace(/[\w.+-]+@[\w.-]+/g, '该账号')
    .replace(/Bearer\s+\S+|sk-[\w-]+|eyJ[\w.-]+/gi, '[隐藏]').slice(0, 240);
}

export function requestGeneration(gateway, login, runId, signal) {
  const url = localEndpoint(gateway.addr);
  const body = Buffer.from(JSON.stringify({ model: qualifiedModel, reasoning: { effort }, input: prompt,
    store: false, stream: false }));
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(20 * 60000);
    const req = request(url, { method: 'POST', agent: false, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: {
      'Content-Type': 'application/json', 'Content-Length': body.length, 'User-Agent': 'PelicanHour/2.0',
      'X-Magpie-Account': encodeURIComponent(login).replaceAll('%40', '@'), 'X-Magpie-Session': 'pelican-' + runId
    }}, async res => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of res) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) throw new Error('响应超过 16 MiB');
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          let detail;
          try { detail = JSON.parse(raw)?.error?.message; } catch { /* Non-JSON gateway error. */ }
          throw new Error('喜鹊网关 HTTP ' + res.statusCode + ' ' + safeReason(detail));
        }
        if (res.headers['x-magpie-provider'] !== 'codex' || res.headers['x-magpie-model'] !== qualifiedModel) {
          throw new Error('网关未确认指定的 Codex 供应商和模型');
        }
        resolve(JSON.parse(raw));
      } catch (err) { reject(err); }
    });
    req.on('error', reject);
    req.end(body);
  });
}

function isEscapedMarkup(text) {
  return /^\s*(?:<!doctype[^>]*>\s*)?<(?:html|svg)\b[^>]*\s[\w:-]+\s*=\s*\\["']/i.test(text) ||
    /^<!doctype[^>]*>\\(?:r\\n|n|r)/i.test(text);
}

function completeDocument(text) {
  for (const match of text.matchAll(/(?:<!doctype\s+html\b|<html\b).*?<\/html\s*>/gis)) {
    const prefix = text.slice(text.lastIndexOf('\n', match.index - 1) + 1, match.index).trimStart();
    if (prefix.startsWith('{')) continue;
    if (/<svg\b/i.test(match[0]) && !isEscapedMarkup(match[0])) return match[0];
  }
  return null;
}

export function htmlDocument(answer) {
  for (const match of answer.matchAll(/^(\x60{3,}|~{3,})(?:html)?[ \t]*\r?\n(.*?)^\1[ \t]*\r?$/gims)) {
    const fragment = match[2];
    if (/^\s*</.test(fragment) && /<svg\b/i.test(fragment) && !isEscapedMarkup(fragment)) return fragment;
  }
  const direct = completeDocument(answer);
  if (direct) return direct;
  // A model may print tool arguments containing a complete file in a command
  // string. Decode JSON exactly once and read only the document as text.
  let latest = null;
  for (const line of answer.split('\n')) {
    const json = line.trim();
    if (!json.startsWith('{') || !/<(?:!doctype|html)\b/i.test(json)) continue;
    let args;
    try { args = JSON.parse(json); } catch { continue; }
    for (const value of [args.cmd, args.command, args.content]) {
      if (typeof value === 'string') latest = completeDocument(value) || latest;
    }
  }
  if (latest) return latest;
  throw new Error('模型回复中没有找到完整 HTML 文档');
}

async function probe(archive, gateway, entry, now, check, signal) {
  const slot = Math.floor(now / hour);
  const { account, login } = entry;
  const key = check?.key ?? slot;
  const id = account.id + '-' + key;
  if (archive.records.has(id) || (check?.trigger !== 'resume' && !archive.canMonitor(account.id, slot))) return;
  const url = '/accounts/' + account.id + '/runs/' + key;
  const folder = join(archive.root, url.slice(1));
  const path = join(folder, 'run.json');
  const meta = { id, accountId: account.id, source: 'magpie', experimentMode: 'independent',
    title: '鹈鹕骑自行车', status: 'running', stage: '喜鹊正在请求模型',
    startedAt: new Date(now).toISOString(), finishedAt: null, slot, model, reasoningEffort: effort,
    trigger: check?.trigger || 'scheduled', requestedAt: check?.requestedAt,
    inputPrompt: prompt, inputSha256, note: '' };
  archive.saveRun(path, meta);
  try {
    if (!account.present || !account.enabled) throw new Error(account.present ? '供应商账号已停用，无法发起检测' : '供应商账号已移除，无法发起检测');
    const reply = await requestGeneration(gateway, login, id, signal);
    signal.throwIfAborted();
    const answer = (reply.output || []).filter(item => item.type === 'message').flatMap(item =>
      (item.content || []).filter(part => part.type === 'output_text').map(part => part.text)).join('\n');
    writeFileSync(join(folder, 'response.txt'), answer, { mode: 0o600 });
    meta.responseText = url + '/response.txt';
    meta.responseId = reply.id;
    if (reply.status !== 'completed' || reply.error) throw new Error('模型未完成输出（' + reply.status + '）');
    const document = htmlDocument(answer);
    writeFileSync(join(folder, 'original.html'), document, { mode: 0o600 });
    Object.assign(meta, { original: url + '/original.html', sourceHtmlSha256: sha256(document), stage: '正在提取并保存 SVG' });
    archive.saveRun(path, meta);
    const { svg, preview, title } = extractArtwork(document);
    if (title) meta.title = title;
    writeFileSync(join(folder, 'artwork.svg'), svg + '\n', { mode: 0o600 });
    writeFileSync(join(folder, 'preview.html'), preview, { mode: 0o600 });
    if (/<script\b|\sonload\s*=/i.test(document)) {
      try {
        const recorder = fileURLToPath(new URL('./render-thumbnail.mjs', import.meta.url));
        await run(process.execPath, [recorder, folder], { timeout: 120000 });
        meta.thumbnailVideo = url + '/thumbnail.mp4';
        meta.thumbnail = url + '/thumbnail.png';
      } catch {
        // The SVG and full interactive original remain available when recording is unavailable.
        console.error('[鹈鹕巡检] 缩略动画未生成', id);
      }
    }
    Object.assign(meta, { svg: url + '/artwork.svg', preview: url + '/preview.html', bytes: Buffer.byteLength(svg),
      status: 'success', stage: '已生成并保存' });
  } catch (err) {
    Object.assign(meta, signal.aborted
      ? { status: 'interrupted', stage: '检测中断', note: signal.reason.message }
      : { status: 'failed', stage: '检测失败', note: safeReason(err.message) });
  }
  meta.finishedAt = new Date().toISOString();
  archive.saveRun(path, meta);
}

export function createScheduler(archive, discover = listAccounts, clock = Date.now) {
  const running = new Set();
  let controller = new AbortController(), timer, deadline, onBoundary;
  function refreshQuietHours(now = clock()) {
    const window = quietWindow(archive.quietHours, now);
    const quiet = window && window.start <= now;
    if (quiet && !controller.signal.aborted) controller.abort(new Error('进入免打扰时段，已中断检测'));
    if (!quiet && controller.signal.aborted) controller = new AbortController();
    const boundary = window ? (quiet ? window.end : window.start) : null;
    if (boundary !== deadline) {
      clearTimeout(timer);
      deadline = boundary;
      if (boundary !== null) timer = setTimeout(() => {
        deadline = null;
        refreshQuietHours();
        onBoundary?.();
      }, boundary - now).unref();
    }
    return controller.signal;
  }
  async function dispatchDue(gateway, wake) {
    onBoundary = wake;
    let now = clock();
    archive.planDispatches(now);
    const signal = refreshQuietHours(now);
    if (signal.aborted) return;
    const plans = archive.info.nextByAccount;
    const due = running.size < 3 && Object.entries(plans).some(([id, time]) => time <= now && !running.has(id));
    const inventorySlot = Math.floor(Date.parse(archive.info.inventoryAt) / hour);
    const switchDue = running.size < 3 && archive.info.switchChecks?.some(check => !running.has(check.accountId));
    if (!due && !switchDue && inventorySlot === Math.floor(now / hour) && !archive.info.error) return;

    // Refresh account availability at the hour boundary and before a dispatch.
    let entries;
    try { entries = await discover(gateway, signal); }
    catch (err) { if (signal.aborted) return; throw err; }
    now = clock();
    if (refreshQuietHours(now).aborted || signal.aborted) return;
    const accounts = entries.map(e => e.account);
    const present = new Set(accounts.map(a => a.id));
    const removed = archive.info.accounts.filter(a => !present.has(a.id)).map(a => ({ ...a, enabled: false, present: false }));
    archive.planDispatches(now, { accounts: [...accounts, ...removed], inventoryAt: new Date(now).toISOString(),
      defaultAccountId: archive.info.defaultAccountId || entries.find(e => e.active)?.account.id || accounts[0]?.id, error: '' });

    let started = false;
    function launch(entry, check) {
      const id = entry.account.id;
      const start = clock();
      if (refreshQuietHours(start).aborted || signal.aborted || running.has(id) || running.size >= 3) return;
      if (check?.trigger !== 'resume' && Math.floor(start / hour) !== Math.floor(now / hour)) return;
      running.add(id);
      started = true;
      // probe persists the run before sending. Other accounts can start on a
      // later tick while this account is waiting for its reply.
      void probe(archive, gateway, entry, start, check, signal)
        .catch(err => { console.error('[鹈鹕巡检]', id, err.message); })
        .finally(() => {
          running.delete(id);
          if (archive.info.switchChecks?.length && archive.records.has(id + '-' + (check?.key ?? Math.floor(now / hour)))) wake?.();
        });
    }
    const checks = archive.info.switchChecks || [];
    for (const check of checks) {
      if (archive.records.has(check.accountId + '-' + check.key)) continue;
      const entry = entries.find(e => e.account.id === check.accountId) || { account: { id: check.accountId, present: false } };
      launch(entry, check);
    }
    const next = archive.info.nextByAccount;
    const ready = entries.filter(e => next[e.account.id] <= now).sort((a, b) => next[a.account.id] - next[b.account.id]);
    for (const entry of ready) {
      const at = next[entry.account.id];
      const sample = archive.restSchedule.enabled && dayType(at).rest;
      launch(entry, sample ? { key: 'sample-'+Math.floor(at/minute), trigger: 'rest-sample',
        requestedAt: new Date(at).toISOString() } : undefined);
    }
    // A persisted run is the receipt for a switch check. A restart in between
    // the two writes consumes that receipt without sending the request again.
    const remaining = checks.filter(check => !archive.records.has(check.accountId + '-' + check.key));
    const changes = {};
    if (remaining.length !== checks.length) changes.switchChecks = remaining;
    if (started) changes.lastDispatchAt = now;
    archive.planDispatches(now, changes);
  }
  dispatchDue.refreshQuietHours = refreshQuietHours;
  dispatchDue.dispose = () => { clearTimeout(timer); controller.abort(new Error('插件已停止')); };
  return dispatchDue;
}
