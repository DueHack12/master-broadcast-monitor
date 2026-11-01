/**
 * Where and how this copy is running: from a source checkout with
 * `node server.js`, or as a packaged app (a Node single executable — the
 * Windows .exe, macOS .app or Linux binary) that carries the dashboard inside
 * itself and has no folder of its own for settings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The `node:sea` module when running packaged, otherwise null. */
export const sea = (() => {
  try {
    const s = createRequire(import.meta.url)('node:sea');
    return s.isSea() ? s : null;
  } catch { return null; }
})();

export const packaged = !!sea;

/** The source checkout's root. Meaningless when packaged. */
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The bundler fills __BM_VERSION__ in; from source, package.json is the truth.
/* global __BM_VERSION__ */
export const VERSION = typeof __BM_VERSION__ !== 'undefined'
  ? __BM_VERSION__
  : JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Folder holding config.json and data/, unless --config / --data say otherwise.
 *
 * From source: the checkout, as always. Packaged: a config.json sitting next
 * to the executable wins (a self-contained copy on a USB stick); otherwise
 * Documents/Broadcast Monitor, which is easy to find and survives replacing
 * the .exe with a newer one.
 */
export function defaultHome() {
  if (!packaged) return ROOT;
  const beside = path.dirname(process.execPath);
  if (fs.existsSync(path.join(beside, 'config.json'))) return beside;
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(docs) ? docs : os.homedir(), 'Broadcast Monitor');
}

/** A file shipped with the app: from the executable when packaged, from the checkout otherwise. */
export function readAsset(rel) {
  if (sea) {
    try { return Buffer.from(sea.getAsset(rel)); } catch { return null; }
  }
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file) : null; } catch { return null; }
}

/** Open a URL or folder with the system's default handler. Best effort. */
export function openExternal(target) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
    : process.platform === 'darwin' ? ['open', [target]]
      : ['xdg-open', [target]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch { /* nothing to open it with */ }
}
