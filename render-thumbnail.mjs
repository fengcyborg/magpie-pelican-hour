// Capture the archived artwork once so thumbnail playback needs no frame scripts.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const execute = promisify(execFile);

const folder = process.argv[2];
const source = await readFile(join(folder, 'preview.html'));
const profile = await mkdtemp(join(tmpdir(), 'pelican-preview-'));
const stem = join(folder, '.thumbnail-' + process.pid);
const capture = stem + '-capture.mp4';
const clip = stem + '.mp4';
const fallback = stem + '.png';
const frameRate = 60;
const frameCount = frameRate * 6;
const url = 'https://preview.invalid/art';
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-extensions', '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const chromeClosed = once(chrome, 'close');
let seq = 0, buffer = '', encoder;
const calls = new Map();
const events = new Map();
function command(method, params = {}, sessionId) {
    if (chrome.exitCode !== null || chrome.signalCode) return Promise.reject(Error('Chrome 已退出'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
        calls.set(id, { resolve, reject });
        chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
}
chrome.stdio[4].setEncoding('utf8').on('data', part => {
    buffer += part;
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const waiter = calls.get(msg.id);
        if (waiter) {
            calls.delete(msg.id);
            if (msg.error) waiter.reject(Error(msg.error.message));
            else waiter.resolve(msg.result);
        } else {
            events.get(msg.method)?.(msg);
        }
    }
});
chrome.on('close', () => {
    for (const c of calls.values()) c.reject(Error('Chrome 已退出'));
    calls.clear();
});
const watchdog = setTimeout(() => { chrome.kill('SIGKILL'); encoder?.kill('SIGKILL'); }, 105000);
try {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => command(method, params, sessionId);
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 360, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    // Step the source animation at display-frame intervals, independently of capture speed.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + function captureClock() {
        let now = 0, nextId = 0;
        const epoch = Date.now(), callbacks = new Map(), managed = new WeakMap();
        performance.now = () => now;
        Date.now = () => epoch + Math.floor(now);
        window.requestAnimationFrame = cb => { callbacks.set(++nextId, cb); return nextId; };
        window.cancelAnimationFrame = id => callbacks.delete(id);
        window.stepThumbnail = time => {
            now = time;
            const batch = [...callbacks.keys()];
            for (const id of batch) {
                const cb = callbacks.get(id);
                if (cb) { callbacks.delete(id); cb(time); }
            }
            for (const svg of document.querySelectorAll('svg')) {
                if (!svg.ownerSVGElement) { svg.pauseAnimations(); svg.setCurrentTime(time / 1000); }
            }
            for (const anim of document.getAnimations()) {
                if (!managed.has(anim) && anim.playState === 'running') {
                    managed.set(anim, { start: time, offset: anim.currentTime || 0 });
                    anim.pause();
                }
                const base = managed.get(anim);
                if (base) anim.currentTime = base.offset + (time - base.start) * anim.playbackRate;
            }
        };
    }.toString() + ')()' });
    const loaded = new Promise(resolve => events.set('Page.loadEventFired', resolve));
    // Serve only this archived document to an isolated browser profile.
    events.set('Fetch.requestPaused', msg => {
        const { requestId, request } = msg.params;
        if (request.url === url && msg.params.resourceType === 'Document') {
            void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [
                { name: 'Content-Type', value: 'text/html; charset=UTF-8' },
                { name: 'Content-Security-Policy', value: "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'" }
            ], body: source.toString('base64') }).catch(() => {});
        } else void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Page.navigate', { url });
    await loaded;
    const ffmpeg = '/opt/homebrew/bin/ffmpeg';
    encoder = spawn(ffmpeg, ['-v','error','-y','-f','image2pipe','-framerate',String(frameRate),
        '-i','pipe:0','-an','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p',
        '-bf','0','-threads','2',capture], { stdio:['pipe','ignore','inherit'] });
    const encoded = once(encoder, 'close');
    let initial, changed = false;
    for (let i = 0; i < frameCount; i++) {
        const step = await send('Runtime.evaluate', { expression: 'window.stepThumbnail(' + i*1000/frameRate + ')' });
        if (step.exceptionDetails) throw Error('无法推进缩略动画');
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, optimizeForSpeed: true });
        if (i === 0) initial = data;
        else if (data !== initial) changed = true;
        if (!encoder.stdin.write(Buffer.from(data, 'base64'))) await once(encoder.stdin, 'drain');
    }
    encoder.stdin.end();
    const [code] = await encoded;
    if (code !== 0 || !changed) throw Error('未捕获到可播放的动画');
    // Pick a loop boundary near the starting pose. Compare a small central crop
    // so movement of the wheels and rider counts more than distant scenery.
    const width = 72, height = 48, pixels = width * height;
    const { stdout: raw } = await execute(ffmpeg, ['-v','error','-i',capture,'-vf',
        'crop=iw*0.75:ih*0.8,scale=' + width + ':' + height + ',format=gray','-f','rawvideo','-'],
        { encoding: 'buffer', maxBuffer: pixels * (frameCount + 1) });
    let best = frameCount - 1, bestError = Infinity;
    for (let frame = frameRate * 3; frame < frameCount; frame++) {
        let error = 0;
        for (let k = 0; k < pixels; k++) error += Math.abs(raw[k] - raw[frame*pixels+k]);
        if (error < bestError) { bestError = error; best = frame; }
    }
    await execute(ffmpeg, ['-v','error','-y','-i',capture,'-frames:v',String(best),'-c:v','copy','-movflags','+faststart',clip]);
    // Browsers that block even muted inline video can still animate an image.
    await execute(ffmpeg, ['-v','error','-y','-i',clip,'-filter_complex',
        'fps=30,scale=440:264,split[a][b];[a]palettegen=max_colors=224[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        '-plays','0','-f','apng',fallback]);
    await rename(fallback, join(folder, 'thumbnail.png'));
    await rename(clip, join(folder, 'thumbnail.mp4'));
} finally {
    clearTimeout(watchdog);
    chrome.kill();
    encoder?.kill();
    await chromeClosed;
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    await Promise.all([capture, clip, fallback].map(path => rm(path, { force: true })));
}
