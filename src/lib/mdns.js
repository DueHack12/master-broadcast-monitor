import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Tiny mDNS browser for NDI sources — no dependencies.
 *
 * NDI senders announce themselves over mDNS as `_ndi._tcp.local` services,
 * with instance names like `STUDIO-PC (vMix - Output 1)`. We ask for that
 * service type every few seconds on each network the computer is on, and
 * record who answers — including answers to other programs' questions (vMix,
 * NDI Studio Monitor), since mDNS answers are multicast to everyone.
 *
 * Not covered: NDI Discovery Server setups, which do not use mDNS at all.
 */

export const MDNS_ADDR = '224.0.0.251';
export const MDNS_PORT = 5353;
export const NDI_SERVICE = '_ndi._tcp.local';

export const T_A = 1, T_PTR = 12, T_TXT = 16, T_SRV = 33;

function encodeLabels(labels) {
  const parts = labels.filter((l) => l !== '').map((l) => {
    const b = Buffer.from(l, 'utf8');
    if (b.length > 63) throw new Error(`DNS label too long: ${l}`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/**
 * A query with one or more questions: [{ labels: [...], type }].
 * Labels are passed whole because an NDI instance name can contain dots.
 */
export function buildQuestions(questions, { unicastResponse = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(questions.length, 4); // QDCOUNT
  const body = questions.map(({ labels, type }) => {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(type, 0);
    q.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2);
    return Buffer.concat([encodeLabels(labels), q]);
  });
  return Buffer.concat([header, ...body]);
}

/** "Who offers this service?" — one PTR question. */
export function buildQuery(service = NDI_SERVICE, opts) {
  return buildQuestions([{ labels: service.split('.'), type: T_PTR }], opts);
}

/** "Are you still there?" — SRV and TXT for one named source. */
export function buildInstanceQuery(instance, service = NDI_SERVICE) {
  const labels = [instance, ...service.split('.')];
  return buildQuestions([{ labels, type: T_SRV }, { labels, type: T_TXT }]);
}

/** Read a (possibly compressed) DNS name; returns its labels and where it ended. */
export function readName(buf, off) {
  const labels = [];
  let end = -1, jumps = 0;
  for (;;) {
    if (off >= buf.length) throw new Error('name runs past packet');
    const len = buf[off];
    if (len === 0) { if (end < 0) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) throw new Error('bad pointer');
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      if (++jumps > 32) throw new Error('pointer loop');
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { labels, end };
}

/**
 * Parse an mDNS packet. A record we cannot read is skipped rather than
 * throwing the whole packet away, so one odd record never hides a source.
 */
export function parsePacket(buf) {
  if (buf.length < 12) throw new Error('short packet');
  const flags = buf.readUInt16BE(2);
  const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6), ns = buf.readUInt16BE(8), ar = buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) { off = readName(buf, off).end + 4; }
  const records = [];
  for (let i = 0; i < an + ns + ar; i++) {
    const { labels, end } = readName(buf, off);
    off = end;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off), ttl = buf.readUInt32BE(off + 4), rdlen = buf.readUInt16BE(off + 8);
    const rd = off + 10;
    off = rd + rdlen;
    if (off > buf.length) break;
    const rec = { labels, name: labels.join('.'), type, ttl };
    try {
      if (type === T_PTR) rec.target = readName(buf, rd).labels;
      else if (type === T_SRV) rec.srv = { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).labels.join('.') };
      else if (type === T_A && rdlen === 4) rec.address = [...buf.subarray(rd, rd + 4)].join('.');
    } catch { continue; }
    records.push(rec);
  }
  return { isResponse: !!(flags & 0x8000), records };
}

const sameName = (labels, name) => labels.join('.').toLowerCase() === name.toLowerCase();

/**
 * Pull NDI sources out of a parsed packet.
 * Returns [{ name, goodbye, ttl, host, port, address }]
 *
 * Only a PTR record with TTL 0 means "this source is leaving". Senders also
 * expire individual SRV/TXT records when something about them changes, and
 * those must not be read as the source going away.
 */
export function ndiSourcesFrom(parsed, service = NDI_SERVICE) {
  const out = new Map();
  const hosts = new Map();
  for (const r of parsed.records) if (r.type === T_A && r.ttl > 0) hosts.set(r.name.toLowerCase(), r.address);
  for (const r of parsed.records) {
    if (r.type === T_PTR && sameName(r.labels, service) && r.target?.length) {
      const name = r.target[0];
      out.set(name, { ...(out.get(name) || {}), name, ttl: r.ttl, goodbye: r.ttl === 0 });
    }
  }
  for (const r of parsed.records) {
    if (r.type === T_SRV && r.labels.length > 1 && sameName(r.labels.slice(1), service)) {
      const name = r.labels[0];
      const cur = out.get(name) || { name, ttl: r.ttl, goodbye: false };
      if (r.ttl > 0) {
        cur.host = r.srv.target;
        cur.port = r.srv.port;
        cur.address = hosts.get(r.srv.target.toLowerCase()) || cur.address;
      }
      out.set(name, cur);
    }
  }
  // An SRV-only record with TTL 0 says nothing about the source being present.
  return [...out.values()].filter((s) => s.goodbye || s.ttl > 0);
}

/**
 * The IPv4 addresses to run discovery on. By default every real network:
 * not loopback (other computers are never there) and not 169.254.x.x (a
 * network card that got no address). `wanted` limits it to chosen addresses.
 */
export function pickInterfaces(ifaces = os.networkInterfaces(), wanted = []) {
  const all = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      all.push({ name, address: a.address, internal: !!a.internal });
    }
  }
  if (wanted && wanted.length) return all.filter((i) => wanted.includes(i.address));
  return all.filter((i) => !i.internal && !i.address.startsWith('169.254.'));
}

/**
 * Send one packet out of each interface in turn. Each send must finish before
 * the outgoing interface is switched: Node sends a moment after send() is
 * called, so switching in a tight loop sends every copy out of the last one.
 */
export async function sendOnEach(sock, msg, addresses, port = MDNS_PORT, group = MDNS_ADDR) {
  const errors = [];
  for (const ip of addresses) {
    try {
      sock.setMulticastInterface(ip);
      await new Promise((resolve) => sock.send(msg, port, group, (err) => { if (err) errors.push(`${ip}: ${err.code || err.message}`); resolve(); }));
    } catch (e) {
      errors.push(`${ip}: ${e.code || e.message}`);
    }
  }
  return errors;
}

/**
 * Browse continuously.
 *   onSource({ name, goodbye, host, port, address, from })  for every answer
 *   onError(message)
 * `stats` describes what discovery is doing, for the dashboard.
 */
export class MdnsBrowser {
  constructor({ service = NDI_SERVICE, intervalMs = 5000, interfaces = null, onSource, onError } = {}) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.wanted = interfaces && interfaces.length ? interfaces : null;
    this.onSource = onSource || (() => {});
    this.onError = onError || (() => {});
    this.sock = null;
    this.ifaces = new Map(); // address → { name, address, joined, error }
    this.queue = Promise.resolve();
    this.stats = { mode: 'starting', interfaces: [], queries: 0, sendErrors: [], answers: 0, lastAnswerAt: null, others: new Map(), selfAnswers: 0 };
  }

  start() {
    this.stopped = false;
    // Preferred: share port 5353, so multicast answers — to our questions and
    // to everyone else's — reach us. Fallback: an ephemeral port, which makes
    // our queries "legacy unicast": responders that support it answer us directly.
    this._open(MDNS_PORT, 'shared', (err) => {
      if (!err) return;
      this.stats.portError = err.code || err.message;
      this._open(0, 'fallback', (err2) => {
        if (err2) { this.stats.mode = 'failed'; this.onError(`mDNS unavailable: ${err2.message}`); }
      });
    });
    this.timer = setInterval(() => this.query(), this.intervalMs);
    // Network cards come and go (cables, Wi-Fi, VPN, a new DHCP address): keep up.
    this.ifaceTimer = setInterval(() => this._syncInterfaces(), 30000);
    return this;
  }

  _open(port, mode, done) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let bound = false;
    sock.on('error', (e) => {
      if (!bound) { try { sock.close(); } catch { /* */ } done(e); return; }
      this.onError(e.message);
    });
    sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
    sock.bind(port, () => {
      bound = true;
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch { /* */ }
      this.sock = sock;
      this.stats.mode = mode;
      this._syncInterfaces();
      done(null);
      this.query();
    });
  }

  /** Join the group on every interface we use; leave ones that are gone. */
  _syncInterfaces() {
    if (!this.sock || this.stopped) return;
    const next = new Map(pickInterfaces(os.networkInterfaces(), this.wanted).map((i) => [i.address, i]));
    for (const addr of this.ifaces.keys()) {
      if (next.has(addr)) continue;
      try { this.sock.dropMembership(MDNS_ADDR, addr); } catch { /* already gone */ }
      this.ifaces.delete(addr);
    }
    for (const [addr, i] of next) {
      if (this.ifaces.has(addr)) continue;
      try { this.sock.addMembership(MDNS_ADDR, addr); this.ifaces.set(addr, { ...i, joined: true }); } catch (e) { this.ifaces.set(addr, { ...i, joined: false, error: e.code || e.message }); }
    }
    this.stats.interfaces = [...this.ifaces.values()].map(({ name, address, joined, error }) => ({ name, address, joined, error }));
  }

  _onMessage(msg, rinfo) {
    let p;
    try { p = parsePacket(msg); } catch { return; }
    if (!p.isResponse) return;
    const found = ndiSourcesFrom(p, this.service);
    if (!found.length) return;
    const now = Date.now();
    this.stats.answers++;
    this.stats.lastAnswerAt = now;
    if (this.ifaces.has(rinfo.address) || rinfo.address.startsWith('127.')) this.stats.selfAnswers++;
    else this.stats.others.set(rinfo.address, now);
    for (const s of found) this.onSource({ ...s, from: rinfo.address });
  }

  /** Queue a send: one at a time, because each one switches the outgoing interface. */
  _send(msg) {
    this.queue = this.queue.then(async () => {
      if (!this.sock || this.stopped) return;
      const addrs = [...this.ifaces.values()].filter((i) => i.joined).map((i) => i.address);
      let errors = [];
      if (addrs.length) errors = await sendOnEach(this.sock, msg, addrs);
      else {
        // No usable network card found: let the operating system pick one.
        await new Promise((r) => this.sock.send(msg, MDNS_PORT, MDNS_ADDR, (err) => { if (err) errors.push(err.code || err.message); r(); }));
      }
      this.stats.queries++;
      this.stats.sendErrors = errors;
    }).catch((e) => { this.stats.sendErrors = [e.message]; });
    return this.queue;
  }

  /** Ask who offers the service. */
  query() { return this._send(buildQuery(this.service)); }

  /** Ask one source directly whether it is still there. */
  queryInstance(name) {
    try { return this._send(buildInstanceQuery(name, this.service)); } catch { return Promise.resolve(); }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.ifaceTimer);
    try { this.sock?.close(); } catch { /* */ }
    this.sock = null;
  }
}
