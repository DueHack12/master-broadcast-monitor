/**
 * Base class for everything the dashboard watches.
 *
 * Adding a new thing to monitor = one file in src/monitors/ that extends this,
 * plus a line in src/monitors/index.js and a config block. Nothing in the
 * front end needs to change: cards are drawn from what `view()` returns.
 *
 *   static id / title    config key and card heading
 *   start() / stop()     open and close connections and timers
 *   issues(ctx)          → [{ id, level, title, detail }]  (level: crit|warn|info)
 *   view(ctx)            → card description, see below
 *
 * `ctx` is shared by every monitor during one evaluation:
 *   { now, cfg, settings, onAir, monitors: { vmix, youtube, ... } }
 *
 * view() returns:
 *   {
 *     level: 'ok'|'info'|'warn'|'crit'|'idle',   // card accent
 *     status: 'Streaming',                        // short text in the header
 *     rows: [{ label, value, level? }],
 *     list: { title, items: [{ name, level, detail }], empty },
 *     notice: { text, code?, link?, level? },
 *     meters: [...]                               // audio meters (see audio.js)
 *     controls: [{ type: 'select', label, name, value, options: [{value,label}], post }],
 *     actions: [{ label, post, body?, confirm?, style? }]
 *   }
 */
export class Monitor {
  static id = 'monitor';
  static title = 'Monitor';

  constructor(app, cfg) {
    this.app = app;
    this.cfg = cfg;
    this.state = {};
    this._timers = new Set();
  }

  get id() { return this.constructor.id; }
  get title() { return this.constructor.title; }

  start() {}
  stop() {}

  /** Merge into state and let the app know something changed. */
  set(patch) {
    Object.assign(this.state, patch);
    this.app.changed();
  }

  /** setTimeout-chained loop: the next run waits for the previous one, so slow devices never pile up requests. */
  loop(fn, ms) {
    let stopped = false;
    let t;
    const tick = async () => {
      try { await fn(); } catch (e) { this.app.log?.add('warn', `${this.title}: ${e.message}`, this.id); }
      if (!stopped) { t = setTimeout(tick, typeof ms === 'function' ? ms() : ms); this._timers.add(t); }
    };
    t = setTimeout(tick, 0);
    this._timers.add(t);
    const handle = { stop: () => { stopped = true; clearTimeout(t); } };
    this._timers.add(handle);
    return handle;
  }

  clearTimers() {
    for (const t of this._timers) { if (t && typeof t.stop === 'function') t.stop(); else clearTimeout(t); }
    this._timers.clear();
  }

  issues() { return []; }
  view() { return { level: 'idle', status: '', rows: [] }; }
}
