import { Monitor } from './base.js';
import { LevelWatcher } from '../lib/audio.js';
import { fmtAgo } from '../levels.js';

/**
 * Audio levels from vMix's meters. Each configured source is a bus
 * ("master", "busA"…) or an input (by title or number). Detection rules live
 * in lib/audio.js; this file wires them to vMix and turns them into alerts.
 *
 * Config (audio.sources[]):
 *   { label: "Program (Master)", bus: "master", mutedLevel: "crit" }
 *   { label: "Commentary", input: "Mic 1", low: { durationSec: 20 } }
 * Each source can override the global clip/low settings.
 */
export default class AudioMonitor extends Monitor {
  static id = 'audio';
  static title = 'Audio';

  start() {
    this.sources = (this.cfg.sources || []).map((src, i) => ({
      key: src.bus ? `bus:${src.bus}` : `input:${src.input}`,
      slug: slug(src.label || src.bus || src.input || `source${i + 1}`),
      src,
      watcher: new LevelWatcher({
        clip: { ...this.cfg.clip, ...(src.clip || {}) },
        low: { ...this.cfg.low, ...(src.low || {}) }
      }),
      found: false
    }));
    this.wasOnAir = false;
    this.onData = (d, now) => this.ingest(d, now);
    this.app.on('vmix:data', this.onData);
  }

  stop() { this.app.off('vmix:data', this.onData); }

  ingest(d, now) {
    const onAir = this.app.onAir;
    for (const s of this.sources) {
      const m = pick(d, s.src);
      s.found = !!m;
      if (!m) continue;
      s.watcher.sample({ left: m.left, right: m.right, muted: m.muted }, now);
      s.name = m.title || s.src.bus;
    }
    // A quiet pre-show must not count against the first ten seconds on air.
    if (onAir && !this.wasOnAir) for (const s of this.sources) s.watcher.restartLowTimer(now);
    this.wasOnAir = onAir;
  }

  active(ctx) {
    const vmix = ctx.monitors.vmix;
    if (!vmix?.state.online) return false;
    return ctx.onAir || !this.cfg.onlyWhenOnAir;
  }

  issues(ctx) {
    if (!this.active(ctx)) return [];
    const out = [];
    for (const s of this.sources) {
      const label = s.src.label || s.name;
      if (!s.found) {
        out.push({ id: `audio.${s.slug}.missing`, level: 'warn', title: `Audio source not found: ${label}`, detail: describe(s.src) + ' is not in vMix.' });
        continue;
      }
      const st = s.watcher.status(ctx.now);
      const low = s.watcher.low, clip = s.watcher.clip;
      if (st.muted && s.src.bus) {
        out.push({ id: `audio.${s.slug}.muted`, level: s.src.mutedLevel || 'warn', title: `${label} is MUTED`, detail: 'The bus is muted in vMix.' });
      } else if (st.low) {
        out.push({
          id: `audio.${s.slug}.low`, level: 'warn', title: `${label} audio is very low`,
          detail: `Below ${low.thresholdDb} dBFS for ${fmtAgo(st.quietMs)} (alert after ${low.durationSec}s).`
        });
      }
      if (st.clipping) {
        out.push({
          id: `audio.${s.slug}.clip`, level: 'warn', title: `${label} audio is clipping`,
          detail: `${st.clipHits} peaks at or above ${clip.thresholdDb} dBFS in the last ${clip.windowSec}s.`
        });
      }
    }
    return out;
  }

  view(ctx) {
    const vmix = ctx.monitors.vmix;
    const on = this.active(ctx);
    const meters = this.sources.map((s) => {
      const st = s.watcher.status(ctx.now);
      return {
        label: s.src.label || s.name || describe(s.src),
        found: s.found,
        left: st.left, right: st.right, hold: st.holdDb,
        muted: st.muted,
        clip: st.clippedRecently,
        clipping: on && st.clipping,
        low: on && st.low,
        quietSec: st.belowLow ? Math.floor(st.quietMs / 1000) : 0,
        clipDb: s.watcher.clip.thresholdDb,
        lowDb: s.watcher.low.thresholdDb,
        lowSec: s.watcher.low.durationSec
      };
    });
    const bad = meters.some((m) => m.clipping || m.low || (m.muted && on));
    return {
      level: !vmix?.state.online ? 'idle' : bad ? 'warn' : on ? 'ok' : 'idle',
      status: !vmix?.state.online ? 'No vMix' : on ? (bad ? 'Check levels' : 'Levels OK') : 'Watching (alerts when on air)',
      wide: true,
      meters
    };
  }
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'source'; }

function describe(src) { return src.bus ? `Bus "${src.bus}"` : `Input "${src.input}"`; }

/** Find a source's meter in the parsed vMix document. */
export function pick(d, src) {
  if (src.bus) {
    const b = d.buses?.[src.bus === 'master' ? 'master' : 'bus' + String(src.bus).replace(/^bus/i, '').toUpperCase()];
    return b ? { ...b, title: src.bus } : null;
  }
  if (src.input != null) {
    const want = String(src.input).trim();
    const n = /^\d+$/.test(want) ? parseInt(want, 10) : null;
    const lc = want.toLowerCase();
    return d.inputs.find((i) => (n != null && i.number === n))
      || d.inputs.find((i) => i.title.toLowerCase() === lc || i.shortTitle.toLowerCase() === lc)
      || d.inputs.find((i) => i.title.toLowerCase().includes(lc))
      || null;
  }
  return null;
}
