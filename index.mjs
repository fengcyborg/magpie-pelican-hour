import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Archive, dataDirectory } from './archive.mjs';
import { serveGallery } from './gallery.mjs';
import { createScheduler } from './monitor.mjs';

const gatewayFile = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie', 'gateway.json');
let timer, archive, server, dispatchDue, busy = false;
let tickRequested = false;

function wake() {
  if (busy) tickRequested = true;
  else void tick();
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const gateway = JSON.parse(readFileSync(gatewayFile, 'utf8'));
    // The desktop gateway and short-lived CLI commands load the same plugin.
    if (gateway.pid !== process.ppid) {
      if (server) { dispatchDue.dispose(); server.stop(true); server = null; archive = null; dispatchDue = null; }
      return;
    }
    if (!server) {
      const store = new Archive(dataDirectory());
      const listener = serveGallery(store, { onMonitoringChange: wake, onQuietHoursChange: () => {
        dispatchDue.refreshQuietHours();
        wake();
      } });
      try { store.recoverInterrupted(); }
      catch (err) { listener.stop(true); throw err; }
      archive = store;
      server = listener;
      dispatchDue = createScheduler(store);
    }
    await dispatchDue(gateway, wake);
  } catch (err) {
    if (archive) archive.saveInfo({ error: err.message });
    if (err.code !== 'ENOENT') console.error('[鹈鹕巡检]', err.message);
  } finally {
    busy = false;
    if (tickRequested) { tickRequested = false; queueMicrotask(wake); }
  }
}

export default async function pelicanMonitor() {
  if (!timer) {
    // gateway.json may be published after plugin loading on a cold app start.
    timer = setInterval(tick, 30000);
    timer.unref();
    setTimeout(tick, 500).unref();
  }
  return {};
}
