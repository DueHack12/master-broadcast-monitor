import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Configuration = built-in defaults, deep-merged with config.json.
 * config.json is watched: save it and the monitors restart with the new
 * values, no server restart needed. A file that does not parse is reported
 * and ignored, so a typo mid-show never takes the monitor down.
 */

export const DEFAULTS = {
  port: 8090,
  publicUrl: '',
  stationName: 'Broadcast Monitor',
  alerts: {
    // Change any alert's level by id: "crit", "warn", "info" or "off".
    // Wildcards work: { "scorebot.*": "crit", "audio.*.low": "off" }
    overrides: {}
  },
  vmix: {
    enabled: true,
    host: '127.0.0.1',
    port: 8088,
    pollMs: 250,
    timeoutMs: 1500,
    offlineAfterMs: 3000,
    // Which vMix stream destinations (1-3) go to YouTube. Used when vMix reports per-channel state.
    youtubeChannels: [1, 2, 3]
  },
  audio: {
    enabled: true,
    onlyWhenOnAir: true,
    clip: { thresholdDb: -1, windowSec: 10, minHits: 3 },
    low: { thresholdDb: -50, durationSec: 10 },
    sources: [
      { label: 'Program (Master)', bus: 'master', mutedLevel: 'crit' }
    ]
  },
  youtube: {
    enabled: true,
    clientId: '',
    clientSecret: '',
    pollOnAirSec: 15,
    pollIdleSec: 180,
    ingestGraceSec: 45,
    notLiveGraceSec: 0,
    broadcastId: '',
    showViewers: true,
    // "desktop": browser sign-in, lets you choose the channel. "tv": code on any phone (account only).
    clientType: 'tv',
    apiBase: 'https://www.googleapis.com',
    oauthBase: 'https://oauth2.googleapis.com',
    authBase: 'https://accounts.google.com/o/oauth2/v2/auth'
  },
  scorebot: {
    enabled: true,
    host: '127.0.0.1',
    ping: { enabled: true, intervalSec: 5, timeoutMs: 1000, failuresBeforeDown: 2 },
    mqtt: { port: 1883, topic: 'bot/0/json', username: '', password: '' },
    silentAfterSec: 5,
    vendorSportIds: { 23: 'soccer' }
  },
  ose: {
    enabled: true,
    url: 'http://127.0.0.1:8080',
    pollSec: 2,
    required: false
  },
  ndi: {
    enabled: true,
    expected: [],
    scanIntervalSec: 5,
    goneAfterSec: 20,
    interfaces: []
  },
  notify: {
    onlyWhenOnAir: true,
    persistSec: 5,
    cooldownSec: 60,
    repeatAfterMin: 5,
    recovery: true,
    pushcut: { enabled: false, url: '', minLevel: 'warn', timeSensitiveLevel: 'crit' },
    twilio: { enabled: false, accountSid: '', authToken: '', from: '', to: [], minLevel: 'crit' },
    webhook: { enabled: false, url: '', minLevel: 'warn' }
  }
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue; // "_help" style comments
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

export class ConfigStore extends EventEmitter {
  /**
   * @param file     config.json path
   * @param example  text of config.example.json, written to `file` if it does not exist yet
   */
  constructor(file, { example } = {}) {
    super();
    this.file = path.resolve(file);
    this.example = example;
    this.created = false;
    this.error = null;
    this.current = this._read() || deepMerge(DEFAULTS, {});
  }

  _read() {
    if (!fs.existsSync(this.file) && this.example) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, this.example);
      this.created = true;
    }
    if (!fs.existsSync(this.file)) return deepMerge(DEFAULTS, {});
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.error = null;
      return deepMerge(DEFAULTS, raw);
    } catch (e) {
      this.error = `${path.basename(this.file)}: ${e.message}`;
      console.error(`Config not loaded — ${this.error}`);
      return null;
    }
  }

  /**
   * Save changes from the Settings page ({ 'audio.low.durationSec': 15, ... }).
   * Merged into config.json as it stands, so anything hand-written there —
   * "_help" notes, options the page does not show — survives. Applies at once.
   */
  update(flat) {
    let raw = {};
    if (fs.existsSync(this.file)) {
      try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) {
        throw new Error(`${path.basename(this.file)} has a typo (${e.message}). Fix or delete the file, then save again.`);
      }
    }
    for (const [p, v] of Object.entries(flat)) setPath(raw, p, v);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
    this.ownWrite = fs.statSync(this.file).mtimeMs; // the file watcher should not apply it a second time
    this.error = null;
    this.current = deepMerge(DEFAULTS, raw);
    this.emit('change', this.current, 'settings');
    return this.current;
  }

  watch() {
    fs.watchFile(this.file, { interval: 1000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs || cur.mtimeMs === this.ownWrite) return;
      const next = this._read();
      if (next) { this.current = next; this.emit('change', next); }
      else this.emit('error', this.error);
    });
  }

  unwatch() { fs.unwatchFile(this.file); }
}
