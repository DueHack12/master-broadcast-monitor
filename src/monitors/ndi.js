import { Monitor } from './base.js';
import { MdnsBrowser } from '../lib/mdns.js';
import { tcpCheck } from '../lib/ping.js';
import { fmtAgo } from '../levels.js';

/**
 * NDI sources on the network, discovered the way NDI itself does it (mDNS),
 * plus the NDI inputs vMix has loaded.
 *
 * `ndi.expected` lists sources that must be present, e.g.
 *   ["CAM-PC (Camera 1)", "Graphics"]
 * Matching is case-insensitive and partial, so "Camera 1" matches
 * "CAM-PC (Camera 1)".
 *
 * mDNS answers get lost, and senders do not answer every question, so a
 * source that goes quiet is chased before it is called gone:
 *   1. quiet for half of `goneAfterSec` → ask that source directly;
 *   2. quiet for `goneAfterSec`          → try a connection to its NDI port;
 *   3. only if that fails too            → offline.
 * A sender that signs off (an mDNS "goodbye") is offline 2 s later, unless it
 * announces itself again in the meantime.
 */
export default class NdiMonitor extends Monitor {
  static id = 'ndi';
  static title = 'NDI';

  start() {
    this.sources = new Map();
    this.state = { error: null, startedAt: Date.now() };
    this.browser = new MdnsBrowser({
      intervalMs: this.cfg.scanIntervalSec * 1000,
      interfaces: this.cfg.interfaces,
      onSource: (s) => this.seen(s),
      onError: (msg) => { this.state.error = msg; this.app.changed(); }
    }).start();
    this.loop(() => this.check(), 1000);
  }

  stop() { this.browser?.stop(); this.clearTimers(); }

  seen(s) {
    const now = Date.now();
    const cur = this.sources.get(s.name);
    if (s.goodbye) {
      if (cur) { cur.leavingAt = now; this.app.changed(); }
      return;
    }
    if (!cur) {
      this.sources.set(s.name, { name: s.name, firstSeen: now });
      this.app.log.add('info', `NDI source found: ${s.name}`, this.id);
    }
    const src = this.sources.get(s.name);
    Object.assign(src, {
      host: s.host || src.host,
      port: s.port || src.port,
      address: s.address || src.address || s.from,
      lastSeen: now,
      via: 'mdns',
      askedAt: null,
      leavingAt: null
    });
    this.app.changed();
  }

  lastAlive(s) { return Math.max(s.lastSeen || 0, s.tcpOkAt || 0); }

  /** Once a second: chase sources that have gone quiet before calling them gone. */
  async check() {
    const now = Date.now();
    const gone = this.cfg.goneAfterSec * 1000;
    for (const s of [...this.sources.values()]) {
      if (s.probing) continue;
      if (s.leavingAt && now - s.leavingAt > 2000 && (s.lastSeen || 0) < s.leavingAt) {
        this.remove(s, ' (it signed off)');
        continue;
      }
      const quiet = now - this.lastAlive(s);
      if (quiet > gone / 2 && !s.askedAt) {
        s.askedAt = now;
        this.browser.queryInstance(s.name);
      } else if (quiet > gone) {
        this.confirm(s, '');
      }
    }
  }

  /** Last chance before "offline": does the sender's NDI port still take a connection? */
  async confirm(s, why) {
    s.probing = true;
    const r = s.address && s.port ? await tcpCheck(s.address, s.port, 2000) : { ok: false };
    s.probing = false;
    if (this.sources.get(s.name) !== s) return;
    if (r.ok) {
      s.tcpOkAt = Date.now();
      s.via = 'tcp';
      s.askedAt = null;
      s.leavingAt = null;
      this.app.changed();
      return;
    }
    // Seen again while we were checking? Then it is not gone.
    if (Date.now() - (s.lastSeen || 0) < this.cfg.goneAfterSec * 1000 / 2) return;
    this.remove(s, s.leavingAt ? ' (it signed off)' : why);
  }

  remove(s, why) {
    this.sources.delete(s.name);
    this.app.log.add('warn', `NDI source went offline: ${s.name}${why}`, this.id);
    this.app.changed();
  }

  online() { return [...this.sources.values()].sort((a, b) => a.name.localeCompare(b.name)); }

  match(expected, list) {
    const e = String(expected).toLowerCase();
    return list.find((s) => s.name.toLowerCase() === e) || list.find((s) => s.name.toLowerCase().includes(e)) || null;
  }

  /** What discovery can see, in words, for the card and alert details. */
  discovery(now) {
    const st = this.browser?.stats || {};
    const others = [...(st.others || new Map()).entries()].filter(([, t]) => now - t < 5 * 60000).length;
    const settled = now - this.state.startedAt > Math.max(15000, this.cfg.scanIntervalSec * 3000);
    let hint = null;
    const mac = process.platform === 'darwin';
    const blocked = (st.sendErrors || []).some((e) => /EHOSTUNREACH|EPERM|EACCES|ENETUNREACH/.test(e));
    const macTip = 'On a Mac, allow Terminal under System Settings → Privacy & Security → Local Network (Broadcast Monitor runs inside Terminal).';
    if (mac && blocked) hint = `macOS is blocking discovery on the local network. ${macTip}`;
    else if (st.mode === 'failed') hint = 'NDI discovery could not start on this computer.';
    else if (settled && !st.answers) hint = mac
      ? `Nothing has answered at all. ${macTip} Also check Settings → NDI → Networks.`
      : 'Nothing has answered at all. Windows Firewall may be blocking Broadcast Monitor: allow it on both Private and Public networks. Also check Settings → NDI → Networks.';
    else if (settled && !others) hint = 'Only sources on this computer answer. Windows Firewall may be blocking replies from other computers (allow Broadcast Monitor on Private and Public networks), or the cameras are on a network this computer isn\'t using: check Settings → NDI → Networks.';
    return { st, others, hint };
  }

  issues(ctx) {
    // Give discovery a few scans before calling anything missing.
    if (ctx.now - this.state.startedAt < (this.cfg.scanIntervalSec * 2 + 3) * 1000) return [];
    const list = this.online();
    const missing = (this.cfg.expected || []).filter((e) => !this.match(e, list));
    if (!missing.length) return [];
    const { hint } = this.discovery(ctx.now);
    return missing.map((e) => ({
      id: `ndi.missing.${String(e).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      level: 'warn', title: `NDI source missing: ${e}`,
      detail: hint || 'Not answering on the network, and its NDI port does not respond. Check the sending computer or camera and its network cable.'
    }));
  }

  view(ctx) {
    const now = ctx.now;
    const list = this.online();
    const expected = this.cfg.expected || [];
    const missing = this.issues(ctx);
    const gone = this.cfg.goneAfterSec * 1000;
    const describe = (s) => {
      const quiet = now - this.lastAlive(s);
      const where = s.address || '';
      if (s.via === 'tcp' && quiet <= gone) return { level: 'ok', detail: `${where} · online (port check; discovery quiet)` };
      if (quiet > gone / 2) return { level: 'warn', detail: `${where} · checking… no answer for ${fmtAgo(quiet)}` };
      return { level: 'ok', detail: `${where} · seen ${fmtAgo(quiet)} ago` };
    };

    const items = [];
    for (const e of expected) {
      const m = this.match(e, list);
      if (m) { const d = describe(m); items.push({ name: m.name, level: d.level, detail: `expected · ${d.detail}` }); }
      else items.push({ name: e, level: missing.length ? 'warn' : 'idle', detail: 'expected · not found' });
    }
    for (const s of list) {
      if (expected.some((e) => this.match(e, [s]))) continue;
      const d = describe(s);
      items.push({ name: s.name, level: d.level === 'ok' ? 'info' : d.level, detail: d.detail });
    }

    const { st, others, hint } = this.discovery(now);
    const nets = (st.interfaces || []).map((i) => `${i.address}${i.joined ? '' : ' (failed)'}`).join(', ');
    const discoveryRow = st.mode === 'shared'
      ? { label: 'Discovery', value: nets ? `UDP 5353 on ${nets}` : 'UDP 5353 (no network found)', level: nets ? undefined : 'warn' }
      : st.mode === 'fallback'
        ? { label: 'Discovery', value: `Port 5353 is in use by another program (${st.portError}). Using a fallback, so some devices may not answer. ${nets}`, level: 'warn' }
        : { label: 'Discovery', value: st.mode === 'failed' ? (this.state.error || 'failed') : 'starting…', level: st.mode === 'failed' ? 'warn' : undefined };
    const vm = ctx.monitors.vmix?.state.data;
    const vmixNdi = (vm?.inputs || []).filter((i) => /ndi/i.test(i.type));
    const rows = [
      { label: 'On network', value: `${list.length} source${list.length === 1 ? '' : 's'}${others ? ` · ${others} other computer${others === 1 ? '' : 's'} answering` : ''}` },
      discoveryRow,
      { label: 'Last answer', value: st.lastAnswerAt ? `${fmtAgo(now - st.lastAnswerAt)} ago` : 'none yet' },
      { label: 'In vMix', value: vm ? (vmixNdi.length ? vmixNdi.map((i) => `${i.number}: ${i.title}`).join(', ') : 'no NDI inputs') : '—' }
    ];
    if (st.sendErrors?.length) rows.push({ label: 'Send errors', value: st.sendErrors.join('; '), level: 'warn' });
    if (hint && (missing.length || !list.length)) rows.push({ label: 'Hint', value: hint, level: 'warn' });

    return {
      level: missing.length ? 'warn' : (expected.length ? 'ok' : 'idle'),
      status: missing.length ? `${missing.length} missing` : expected.length ? 'All expected sources present' : `${list.length} found`,
      rows,
      list: { title: expected.length ? 'Sources' : 'Discovered sources', items, empty: 'No NDI sources answering yet (asks every few seconds).' }
    };
  }
}
