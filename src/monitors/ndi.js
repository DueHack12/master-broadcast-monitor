import { Monitor } from './base.js';
import { MdnsBrowser } from '../lib/mdns.js';
import { fmtAgo } from '../levels.js';

/**
 * NDI sources on the network, discovered the way NDI itself does it (mDNS),
 * plus the NDI inputs vMix has loaded.
 *
 * `ndi.expected` lists sources that must be present, e.g.
 *   ["CAM-PC (Camera 1)", "Graphics"]
 * Matching is case-insensitive and partial, so "Camera 1" matches
 * "CAM-PC (Camera 1)".
 */
export default class NdiMonitor extends Monitor {
  static id = 'ndi';
  static title = 'NDI';

  start() {
    this.sources = new Map();
    this.state = { error: null, startedAt: Date.now(), scans: 0 };
    this.browser = new MdnsBrowser({
      intervalMs: this.cfg.scanIntervalSec * 1000,
      interfaces: this.cfg.interfaces,
      onSource: (s) => this.seen(s),
      onError: (msg) => { this.state.error = msg; this.app.changed(); }
    }).start();
  }

  stop() { this.browser?.stop(); }

  seen(s) {
    const now = Date.now();
    if (s.ttl === 0) { // goodbye packet
      if (this.sources.has(s.name)) { this.sources.delete(s.name); this.app.log.add('warn', `NDI source left: ${s.name}`, this.id); }
      this.app.changed();
      return;
    }
    const cur = this.sources.get(s.name);
    if (!cur) this.app.log.add('info', `NDI source found: ${s.name}`, this.id);
    this.sources.set(s.name, { ...(cur || {}), ...s, address: s.address || cur?.address || s.from, lastSeen: now });
    this.app.changed();
  }

  online(now) {
    const out = [];
    for (const [name, s] of this.sources) {
      if (now - s.lastSeen <= this.cfg.goneAfterSec * 1000) out.push(s);
      else { this.sources.delete(name); this.app.log.add('warn', `NDI source disappeared: ${name}`, this.id); }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  match(expected, list) {
    const e = String(expected).toLowerCase();
    return list.find((s) => s.name.toLowerCase() === e) || list.find((s) => s.name.toLowerCase().includes(e)) || null;
  }

  issues(ctx) {
    // Give discovery a couple of scans before calling anything missing.
    if (ctx.now - this.state.startedAt < (this.cfg.scanIntervalSec * 2 + 2) * 1000) return [];
    const list = this.online(ctx.now);
    return (this.cfg.expected || []).filter((e) => !this.match(e, list)).map((e) => ({
      id: `ndi.missing.${String(e).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      level: 'warn', title: `NDI source missing: ${e}`,
      detail: 'Not announced on the network. Check the sending computer/camera and its network link.'
    }));
  }

  view(ctx) {
    const list = this.online(ctx.now);
    const expected = this.cfg.expected || [];
    const missing = this.issues(ctx);
    const items = [];
    for (const e of expected) {
      const m = this.match(e, list);
      items.push({ name: m ? m.name : e, level: m ? 'ok' : (missing.length ? 'warn' : 'idle'), detail: m ? `expected · ${m.address || ''}` : 'expected · not seen' });
    }
    for (const s of list) {
      if (expected.some((e) => this.match(e, [s]))) continue;
      items.push({ name: s.name, level: 'info', detail: `${s.address || ''}${s.port ? `:${s.port}` : ''} · seen ${fmtAgo(ctx.now - s.lastSeen)} ago` });
    }

    // NDI inputs loaded in vMix, from the vMix monitor's data.
    const vm = ctx.monitors.vmix?.state.data;
    const vmixNdi = (vm?.inputs || []).filter((i) => /ndi/i.test(i.type));
    const rows = [
      { label: 'On network', value: `${list.length} source${list.length === 1 ? '' : 's'}` },
      { label: 'In vMix', value: vm ? (vmixNdi.length ? vmixNdi.map((i) => `${i.number}: ${i.title}`).join(', ') : 'no NDI inputs') : '—' }
    ];
    if (this.state.error) rows.push({ label: 'Discovery', value: this.state.error, level: 'warn' });

    return {
      level: missing.length ? 'warn' : (expected.length ? 'ok' : 'idle'),
      status: missing.length ? `${missing.length} missing` : expected.length ? 'All expected sources present' : `${list.length} found`,
      rows,
      list: { title: expected.length ? 'Sources' : 'Discovered sources', items, empty: 'No NDI sources answering yet (scans every few seconds).' }
    };
  }
}
