import { EventEmitter } from 'node:events';
import { MONITORS } from './monitors/index.js';
import { chainIssues } from './rules.js';
import { Notifier } from './notify.js';
import { Settings, EventLog } from './store.js';
import { LEVELS, rank, worst, overrideLevel, fmtAgo } from './levels.js';

/**
 * The hub: owns the monitors, evaluates every rule into one list of issues,
 * builds the dashboard snapshot, and hands issues to the notifier.
 *
 * Evaluation runs on every change (throttled to 5 Hz, for the audio meters)
 * and at least once a second, so time-based rules — grace periods, "quiet for
 * 10 s" — fire on time even when nothing else changes.
 */
export class App extends EventEmitter {
  constructor({ config, dataDir }) {
    super();
    this.setMaxListeners(50);
    this.config = config;
    this.dataDir = dataDir;
    this.settings = new Settings(dataDir);
    this.log = new EventLog(dataDir);
    this.monitors = {};
    this.list = [];
    this.firstSeen = new Map();
    this.issues = [];
    this.onAir = false;
    this.notifier = new Notifier(this);
    this.snapshot = null;
  }

  get cfg() { return this.config.current; }

  start() {
    this.startMonitors();
    this.config.on('change', () => {
      this.log.add('info', 'config.json changed — monitors restarted with the new settings', 'system');
      this.restart();
    });
    this.config.on('error', (msg) => { this.log.add('warn', `config.json not applied: ${msg}`, 'system'); this.changed(); });
    this.ticker = setInterval(() => this.flush(), 1000);
    this.log.add('info', `Broadcast monitor started — settings file: ${this.config.file}`, 'system');
    this.flush();
  }

  startMonitors() {
    for (const M of MONITORS) {
      const cfg = this.cfg[M.id];
      if (!cfg || cfg.enabled === false) continue;
      const m = new M(this, cfg);
      this.monitors[M.id] = m;
      this.list.push(m);
      try { m.start(); } catch (e) { this.log.add('crit', `${M.title} failed to start: ${e.message}`, M.id); }
    }
  }

  stopMonitors() {
    for (const m of this.list) { try { m.stop(); } catch { /* best effort */ } }
    this.monitors = {};
    this.list = [];
  }

  restart() {
    this.stopMonitors();
    this.notifier.configure(this.cfg);
    this.startMonitors();
    this.changed();
  }

  stop() {
    clearInterval(this.ticker);
    clearTimeout(this.pending);
    this.config.unwatch?.();
    this.stopMonitors();
  }

  /** Something changed: re-evaluate soon (coalesced). */
  changed() {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = null; this.flush(); }, 200);
  }

  computeOnAir() {
    return !!(this.monitors.vmix?.state.streaming || this.monitors.youtube?.state.broadcast?.lifeCycleStatus === 'live');
  }

  evaluate(now = Date.now()) {
    const ctx = { now, cfg: this.cfg, settings: this.settings, monitors: this.monitors, onAir: this.computeOnAir() };
    this.onAir = ctx.onAir;

    let raw = [];
    const add = (list, source) => { for (const i of list || []) raw.push({ ...i, source: i.source || source }); };
    try { add(chainIssues(ctx), 'youtube'); } catch (e) { add([{ id: 'system.rules', level: 'warn', title: 'Rule error', detail: e.message }], 'system'); }
    for (const m of this.list) {
      try { add(m.issues(ctx), m.id); } catch (e) { add([{ id: `${m.id}.error`, level: 'warn', title: `${m.title} check failed`, detail: e.message }], m.id); }
    }
    if (this.config.error) add([{ id: 'system.config', level: 'warn', title: 'config.json has an error', detail: `${this.config.error} — still using the last good settings.` }], 'system');

    const overrides = this.cfg.alerts?.overrides || {};
    raw = raw
      .map((i) => ({ ...i, level: overrideLevel(i.id, i.level, overrides) }))
      .filter((i) => LEVELS.includes(i.level) && i.level !== 'ok');

    // Remember when each issue first appeared; log raises and clears.
    const seen = new Set();
    for (const i of raw) {
      seen.add(i.id);
      if (!this.firstSeen.has(i.id)) {
        this.firstSeen.set(i.id, now);
        if (i.level !== 'info') this.log.add(i.level, i.title, i.source);
      }
      i.since = this.firstSeen.get(i.id);
    }
    for (const [id] of this.firstSeen) {
      if (!seen.has(id)) {
        const old = this.issues.find((x) => x.id === id);
        this.firstSeen.delete(id);
        if (old && old.level !== 'info') this.log.add('ok', `Resolved: ${old.title}`, old.source);
      }
    }
    raw.sort((a, b) => rank(b.level) - rank(a.level) || a.since - b.since);
    this.issues = raw;
    return ctx;
  }

  buildSnapshot(ctx) {
    const now = ctx.now;
    const alerting = this.issues.filter((i) => i.level !== 'info');
    const level = worst(alerting.map((i) => i.level));
    const yt = this.monitors.youtube?.state;
    const vm = this.monitors.vmix?.state;
    const ytLive = yt?.broadcast?.lifeCycleStatus === 'live';
    const liveSince = ytLive && yt.broadcast.actualStartTime ? Date.parse(yt.broadcast.actualStartTime) : null;

    let headline, detail;
    if (alerting.length) {
      headline = alerting[0].title;
      detail = alerting[0].detail || '';
      if (alerting.length > 1) detail = `${detail}${detail ? '  ·  ' : ''}+${alerting.length - 1} more`;
    } else {
      headline = 'All systems operational';
      if (ytLive) detail = `LIVE on YouTube${liveSince ? ` for ${fmtAgo(now - liveSince)}` : ''}${yt.viewers != null ? `  ·  ${yt.viewers.toLocaleString()} watching` : ''}`;
      else if (vm?.streaming) detail = 'vMix is streaming';
      else detail = 'Standby — not streaming';
    }

    const cards = this.list.map((m) => {
      let v;
      try { v = m.view(ctx) || {}; } catch (e) { v = { level: 'warn', status: 'View error', rows: [{ label: 'Error', value: e.message, level: 'warn' }] }; }
      return { id: m.id, title: m.title, ...v };
    });

    return {
      time: now,
      station: this.cfg.stationName,
      onAir: ctx.onAir,
      live: { youtube: ytLive, since: liveSince, viewers: yt?.viewers ?? null, vmixStreaming: !!vm?.streaming },
      overall: { level, headline, detail },
      issues: this.issues.map(({ id, level, title, detail, since, source }) => ({ id, level, title, detail, since, source })),
      cards,
      log: this.log.recent(50),
      notify: { channels: this.notifier.enabledChannels(), onlyWhenOnAir: !!this.cfg.notify?.onlyWhenOnAir },
      settingsFile: this.config.file
    };
  }

  flush() {
    const ctx = this.evaluate();
    this.snapshot = this.buildSnapshot(ctx);
    this.emit('snapshot', this.snapshot);
    try { this.notifier.tick(this.issues, ctx.onAir, ctx.now); } catch (e) { console.error('notifier:', e); }
  }
}
