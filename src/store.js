import fs from 'node:fs';
import path from 'node:path';

/** Small JSON file helpers for the data/ folder. */

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Settings changed from the dashboard (today's sport, learned sport IDs).
 * Kept apart from config.json so the UI never rewrites a hand-edited file.
 */
export class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.values = { expectedSport: 'auto', vendorSportIds: {}, ...readJson(this.file, {}) };
  }
  get(k) { return this.values[k]; }
  update(patch) {
    this.values = { ...this.values, ...patch };
    writeJson(this.file, this.values);
    return this.values;
  }
}

/** Rolling event log: in memory for the dashboard, appended to disk for the post-show review. */
export class EventLog {
  constructor(dataDir, max = 200) {
    this.file = path.join(dataDir, 'events.jsonl');
    this.max = max;
    this.items = [];
    fs.mkdirSync(dataDir, { recursive: true });
  }
  add(level, text, source = 'system') {
    const e = { t: Date.now(), level, text, source };
    this.items.unshift(e);
    if (this.items.length > this.max) this.items.length = this.max;
    fs.appendFile(this.file, JSON.stringify({ ...e, time: new Date(e.t).toISOString() }) + '\n', () => {});
    return e;
  }
  recent(n = 60) { return this.items.slice(0, n); }
}
