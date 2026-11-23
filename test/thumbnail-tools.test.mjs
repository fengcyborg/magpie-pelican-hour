import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, model } from '../archive.mjs';
import { serveGallery } from '../gallery.mjs';
import { createScheduler } from '../monitor.mjs';
import { findRecordingTools } from '../thumbnail-tools.mjs';

test('finds recording tools on PATH or at configured locations and handles either missing tool', () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican tools-'));
  const saved = Object.fromEntries(['PATH', 'CHROME_PATH', 'FFMPEG_PATH'].map(key => [key, process.env[key]]));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const chrome = join(root, suffix ? 'chrome.exe' : 'google-chrome');
  const ffmpeg = join(root, 'ffmpeg' + suffix);
  try {
    writeFileSync(chrome, '', { mode: 0o700 });
    writeFileSync(ffmpeg, '', { mode: 0o700 });
    process.env.PATH = root;
    delete process.env.CHROME_PATH;
    delete process.env.FFMPEG_PATH;
    expect(findRecordingTools()).toEqual({ chrome, ffmpeg });
    process.env.PATH = '';
    process.env.CHROME_PATH = chrome;
    process.env.FFMPEG_PATH = ffmpeg;
    expect(findRecordingTools()).toEqual({ chrome, ffmpeg });
    process.env.FFMPEG_PATH = join(root, 'missing-encoder');
    expect(findRecordingTools()).toBeNull();
    process.env.FFMPEG_PATH = ffmpeg;
    process.env.CHROME_PATH = join(root, 'missing-browser');
    expect(findRecordingTools()).toBeNull();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('a scripted run without a recorder still serves its animated preview after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-live-preview-'));
  const account = { id: 'a'.repeat(20), name: 'Preview', enabled: true, present: true };
  const source = '<html><body><svg><circle id="bird" r="8"/></svg><script>function draw(time){document.getElementById("bird").setAttribute("cx",time%100);requestAnimationFrame(draw)}requestAnimationFrame(draw)</script></body></html>';
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: source }] }]
  }, { headers: { 'x-magpie-provider': 'codex', 'x-magpie-model': 'codex/' + model } }) });
  const store = new Archive(root);
  const scheduler = createScheduler(store, async () => [{ account, login: account.id }]);
  const prior = process.env.CHROME_PATH;
  let gallery;
  try {
    process.env.CHROME_PATH = join(root, 'absent');
    store.saveInfo({ accounts: [account] });
    store.setMonitoringPaused(account.id, true);
    store.setMonitoringPaused(account.id, false);
    await scheduler({ addr: '127.0.0.1:' + gateway.port });
    const currentRun = () => [...store.records.values()][0];
    for (let attempt = 0; attempt < 200 && currentRun()?.status === 'running'; attempt++) await Bun.sleep(5);
    expect(currentRun()?.status).toBe('success');
    const restored = new Archive(root);
    const [run] = restored.status().runs;
    expect(run.thumbnailVideo).toBeUndefined();
    expect(run.thumbnail).toBeUndefined();
    gallery = serveGallery(restored, { hostname: '127.0.0.1', port: 0 });
    const response = await fetch(new URL(run.preview, gallery.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts;');
    expect(await response.text()).toContain('requestAnimationFrame(draw)');
  } finally {
    scheduler.dispose();
    gateway.stop(true);
    gallery?.stop(true);
    if (prior === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
