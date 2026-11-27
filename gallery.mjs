import { dayType, regions, hostLanguage, dateKey } from './rest-days.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const galleryFile = name => readFileSync(new URL('./gallery/' + name, import.meta.url), 'utf8');
const messages = galleryFile('messages.json').replaceAll('<', '\\u003c');
const artworkTitles = galleryFile('artwork-titles.json').replaceAll('<', '\\u003c');
const guides = ['en','zh-CN','zh-TW','ja','de'].map(locale => {
  const name = locale === 'en' ? 'README.md' : 'README.' + locale + '.md';
  const markdown = readFileSync(new URL(name, import.meta.url), 'utf8')
    .replace(/^\[English\]\([^\n]+\n/m, '') // The dashboard already has a language selector.
    .replace(/^#{1,2} /gm, heading => '#' + heading);
  return '<template id="guide-' + locale + '">' + Bun.markdown.html(markdown) + '</template>';
}).join('');
const page = galleryFile('index.html').replace('<!--guides-->', () => guides).replace('/*calendar-script*/', () => galleryFile('calendar.js')).replace('<!--language-script-->', () =>
  '<script type="application/json" id="artwork-titles">' + artworkTitles + '</script><script type="application/json" id="translations">' + messages + '</script><script>' + galleryFile('language.js') + '</script>');
const icon = readFileSync(new URL('./page/icon.png', import.meta.url));
const allowedArtifact = /^\/(?:runs\/\d{8}-\d{6}|accounts\/[0-9a-f]{20}\/runs\/(?:\d{6,9}|\d{8}-\d{6}|(?:switch|manual)-[0-9a-f]{32}|sample-\d{1,12}))\/(?:original\.html|preview\.html|artwork\.svg|thumbnail\.(?:gif|png|mp4)|response\.txt)$/;
const pagePolicy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'";
const artPolicy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const localPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function timeValue(text) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) return NaN;
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

export function serveGallery(archive, { port = 18765, hostname = '0.0.0.0', onMonitoringChange, onQuietHoursChange } = {}) {
  // A sandboxed plugin page has an opaque origin. Only the page carrying this
  // capability may read the status cross-origin, without reloading its previews.
  const embeddedKey = crypto.randomUUID();
  const managementKey = crypto.randomUUID();
  return Bun.serve({
    port, hostname, reusePort: false, development: false, maxRequestBodySize: 131072,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      const isLocal = localHosts.has(url.hostname) && localPeers.has(server.requestIP(req)?.address);
      const control = /^\/api\/accounts\/([0-9a-f]{20})\/(monitoring|check)$/.exec(path);
      const statusBody = () => archive.status(Date.now(), url.searchParams.get('summary') !== '1');
      if (control || path === '/api/quiet-hours' || path === '/api/language') {
        const origin = req.headers.get('Origin');
        const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
        if (origin === 'null') headers['Access-Control-Allow-Origin'] = 'null';
        if (req.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
        if (!isLocal || (origin && origin !== 'null' && origin !== url.origin)) return new Response(null, { status: 403, headers });
        const form = new URLSearchParams(await req.text());
        if (form.get('key') !== managementKey) return new Response(null, { status: 403, headers });
        if (path === '/api/language') {
          const language = form.get('language');
          if (!['system', 'zh-CN', 'zh-TW', 'en', 'ja', 'de'].includes(language)) return new Response(null, { status: 400, headers });
          let tag;
          try { tag = new Intl.Locale(form.get('locale') || hostLanguage).toString(); }
          catch { return new Response(null, { status: 400, headers }); }
          archive.setLanguage(language, tag);
          return new Response(null, { status: 204, headers });
        }
        if (!control) {
          const enabled = form.get('enabled');
          let rest = archive.restSchedule;
          if (form.has('restSchedule')) {
            try {
              const value = JSON.parse(form.get('restSchedule'));
              rest = { enabled: value.enabled, count: value.count, distribution: value.distribution, times: value.times };
            } catch { return new Response(null, { status: 400, headers }); }
          }
          let calendar;
          if (form.has('calendar')) {
            try { calendar = JSON.parse(form.get('calendar')); }
            catch { return new Response(null, { status: 400, headers }); }
            if (form.get('calendarBase') !== JSON.stringify(archive.info.calendar || {region:'auto',overrides:{}}))
              return new Response(null, { status: 409, headers });
          }
          if (!['true', 'false'].includes(enabled) || !archive.setQuietHours({ enabled: enabled === 'true',
            start: timeValue(form.get('start')), end: timeValue(form.get('end')) }, Date.now(), rest, calendar)) return new Response(null, { status: 400, headers });
          onQuietHoursChange?.();
          return Response.json(statusBody(), { headers });
        }
        if (control[2] === 'check') {
          const token = form.get('requestId');
          if (!/^[a-f0-9]{32}$/.test(token || '')) return new Response(null, { status: 400, headers });
          if (!archive.requestManual(control[1], token)) return new Response(null, { status: 409, headers });
          onMonitoringChange?.();
          return Response.json(archive.status(Date.now(), false), { status: 202, headers });
        }
        const paused = form.get('paused');
        if (paused !== 'true' && paused !== 'false') return new Response(null, { status: 400, headers });
        const changed = (archive.info.monitoringFromSlot?.[control[1]] === null) !== (paused === 'true');
        if (!archive.setMonitoringPaused(control[1], paused === 'true')) return new Response(null, { status: 404, headers });
        if (changed) onMonitoringChange?.();
        return Response.json({ ...statusBody(), monitoringChanged: changed, switchCheckRequested: changed && paused === 'false' }, { headers });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
      let body, type, policy = pagePolicy, status = 200, cache = 'no-store';
      const extra = {};
      const rawText = path.endsWith('/response.txt') && allowedArtifact.test(path);
      // Old plugin pages navigated their frame directly to the text file.
      // Keep that bookmark readable with the same in-gallery return controls.
      if (rawText && (req.headers.get('Accept') || '').includes('text/html') &&
          (req.headers.get('Sec-Fetch-Mode') || 'navigate') === 'navigate') {
        const run = [...archive.records.values()].find(r => r.responseText === path);
        if (run) {
          const up = '../'.repeat(path.split('/').length - 2);
          const embed = req.headers.get('Sec-Fetch-Dest') === 'document' ? '' : 'embedded=1&';
          return new Response(null, { status: 302, headers: { 'Cache-Control': 'no-store',
            Location: up + '?' + embed + 'source=' + encodeURIComponent(run.id) + '#' + encodeURIComponent(run.accountId || 'history') } });
        }
      }
      if ((path.startsWith('/api/') || rawText) && req.headers.get('Origin') === 'null') {
        if (url.searchParams.get('view') !== embeddedKey) {
          return new Response(null, { status: 403, headers: { 'Access-Control-Allow-Origin': 'null', 'Cache-Control': 'no-store' } });
        }
        extra['Access-Control-Allow-Origin'] = 'null';
        extra['Vary'] = 'Origin';
      }
      if (path === '/api/calendar') {
        const month = url.searchParams.get('month') || '';
        const region = url.searchParams.get('region') || 'auto';
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || (region !== 'auto' && !regions.includes(region)))
          return new Response(null, { status: 400, headers: extra });
        const [year,m] = month.split('-').map(Number);
        const dates = [];
        for (let d=1; d<=new Date(year,m,0).getDate(); d++) {
          const at = new Date(year,m-1,d,12);
          dates.push({date:dateKey(at), ...dayType(at,region==='auto'?archive.autoRegion():region)});
        }
        body = JSON.stringify(dates); type = 'application/json; charset=utf-8';
      } else if (path === '/api/runs') {
        const group = url.searchParams.get('account');
        const filter = url.searchParams.get('filter') || 'all';
        const limit = Number(url.searchParams.get('limit') ?? 12);
        if (!(group === 'history' || archive.info.accounts.some(account => account.id === group)) ||
            !['all','success','failed','running'].includes(filter) || !Number.isInteger(limit) || limit < 1 || limit > 100)
          return new Response(null, { status: 400, headers: extra });
        const result = archive.historyPage(group, filter, url.searchParams.get('cursor'), limit);
        if (!result) return new Response(null, { status: 400, headers: extra });
        body = JSON.stringify(result); type = 'application/json; charset=utf-8';
      } else if (path.startsWith('/api/runs/')) {
        let id;
        try { id = decodeURIComponent(path.slice('/api/runs/'.length)); }
        catch { return new Response(null, { status: 400, headers: extra }); }
        const run = archive.records.get(id);
        if (!run) return new Response(null, { status: 404, headers: extra });
        body = JSON.stringify(archive.publicRun(run, true)); type = 'application/json; charset=utf-8';
      } else if (path === '/api/status') {
        body = JSON.stringify(statusBody()); type = 'application/json; charset=utf-8';
      } else if (path === '/' || path === '/index.html') {
        body = page; type = 'text/html; charset=utf-8';
        if (url.searchParams.get('embedded') === '1') {
          const snapshot = JSON.stringify(archive.status(Date.now(), false)).replaceAll('<', '\\u003c');
          body = body.replace('<!--snapshot-->', () => '<script type="application/json" id="snapshot" data-view="' + embeddedKey + '">' + snapshot + '</script>');
          policy = pagePolicy.replaceAll("'self'", "'self' http://127.0.0.1:" + port);
        }
        if (isLocal) {
          const language = archive.info.language;
          const preference = ['zh-CN', 'zh-TW', 'en', 'ja', 'de'].includes(language) ? language : 'system';
          body = body.replace('<!--local-language-->', '<meta name="local-language" content="' + preference + '">');
          body = body.replace('<!--monitor-control-->', '<meta name="monitor-control" content="' + managementKey + '">');
          policy += "; frame-ancestors 'self' http://localhost:* http://127.0.0.1:* wails://localhost http://wails.localhost";
        }
      } else if (path === '/pelican-icon.png' || path === '/favicon.ico') {
        body = icon; type = 'image/png';
      } else if (path === '/favicon.svg') {
        return new Response(null, { status: 302, headers: { Location: './pelican-icon.png' } });
      } else if (allowedArtifact.test(path)) {
        body = Bun.file(join(archive.root, path.slice(1)));
        if (!await body.exists()) return new Response(null, { status: 404 });
        if (path.endsWith('.mp4')) {
          type = 'video/mp4';
          extra['Accept-Ranges'] = 'bytes';
          const range = req.headers.get('Range');
          if (range) {
            const size = body.size;
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            const start = match?.[1] ? Number(match[1]) : Math.max(0, size - Number(match?.[2]));
            const end = match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
            if (!match || (!match[1] && !match[2]) || start > end || start >= size) {
              return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
            }
            extra['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
            body = body.slice(start, end + 1);
            status = 206;
          }
        } else type = path.endsWith('.png') ? 'image/apng' : path.endsWith('.gif') ? 'image/gif' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
        policy = artPolicy;
        if (type === 'video/mp4' || type.startsWith('image/')) cache = 'private, max-age=3600';
      } else return new Response(null, { status: 404 });
      return new Response(req.method === 'HEAD' ? null : body, { status, headers: { ...extra,
        'Content-Type': type, 'Content-Length': String(body instanceof Blob ? body.size : Buffer.byteLength(body)),
        'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': policy
      }});
    }
  });
}
