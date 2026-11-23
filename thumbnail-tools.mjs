import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

function executable(paths) {
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return resolve(path);
    } catch { continue; }
  }
  return null;
}

export function findRecordingTools() {
  const env = process.env;
  const dirs = (env.PATH || '').split(delimiter).filter(isAbsolute);
  const windows = process.platform === 'win32';
  const names = windows ? ['chrome.exe', 'chromium.exe'] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  const browsers = dirs.flatMap(dir => names.map(name => join(dir, name)));
  if (process.platform === 'darwin') {
    for (const apps of [join(homedir(), 'Applications'), '/Applications']) {
      for (const name of ['Google Chrome', 'Chromium']) browsers.push(join(apps, name + '.app', 'Contents', 'MacOS', name));
    }
    const brewDirs = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean).map(prefix => join(prefix, 'bin'));
    dirs.push(...brewDirs);
    browsers.push(...brewDirs.flatMap(dir => names.map(name => join(dir, name))));
  } else if (windows) {
    for (const root of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      browsers.push(join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  }
  const chrome = executable(env.CHROME_PATH ? [env.CHROME_PATH] : browsers);
  const ffmpeg = executable(env.FFMPEG_PATH ? [env.FFMPEG_PATH] : dirs.map(dir => join(dir, windows ? 'ffmpeg.exe' : 'ffmpeg')));
  return chrome && ffmpeg ? { chrome, ffmpeg } : null;
}
