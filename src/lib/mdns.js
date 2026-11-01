import dgram from 'node:dgram';
import os from 'node:os';

/**
 * Tiny mDNS browser for NDI sources — no dependencies.
 *
 * NDI senders announce themselves over mDNS as `_ndi._tcp.local` services,
 * with instance names like `STUDIO-PC (vMix - Output 1)`. We ask for that
 * service type every few seconds on every IPv4 interface and record who
 * answers. Sources that stop answering, or send an mDNS "goodbye" (TTL 0),
 * are dropped.
 *
 * Not covered: NDI Discovery Server setups, which do not use mDNS at all.
 */

export const MDNS_ADDR = '224.0.0.251';
export const MDNS_PORT = 5353;
export const NDI_SERVICE = '_ndi._tcp.local';

const T_A = 1, T_PTR = 12, T_SRV = 33;

function encodeName(name) {
  const parts = name.split('.').filter(Boolean).map((l) => {
    const b = Buffer.from(l, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A standard one-question PTR query. */
export function buildQuery(service = NDI_SERVICE, { unicastResponse = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT
  const q = Buffer.alloc(4);
  q.writeUInt16BE(T_PTR, 0);
  q.writeUInt16BE(unicastResponse ? 0x8001 : 0x0001, 2);
  return Buffer.concat([header, encodeName(service), q]);
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

/** Parse every resource record in an mDNS response. */
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
    if (type === T_PTR) rec.target = readName(buf, rd).labels;
    else if (type === T_SRV) rec.srv = { port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).labels.join('.') };
    else if (type === T_A && rdlen === 4) rec.address = [...buf.subarray(rd, rd + 4)].join('.');
    records.push(rec);
  }
  return { isResponse: !!(flags & 0x8000), records };
}

const sameName = (labels, name) => labels.join('.').toLowerCase() === name.toLowerCase();

/**
 * Pull NDI sources out of a parsed packet.
 * Returns [{ name, ttl, host, port, address }]
 */
export function ndiSourcesFrom(parsed, service = NDI_SERVICE) {
  const out = new Map();
  const hosts = new Map();
  for (const r of parsed.records) if (r.type === T_A) hosts.set(r.name.toLowerCase(), r.address);
  for (const r of parsed.records) {
    if (r.type === T_PTR && sameName(r.labels, service) && r.target?.length) {
      const name = r.target[0];
      out.set(name, { ...(out.get(name) || {}), name, ttl: r.ttl });
    }
  }
  for (const r of parsed.records) {
    if (r.type === T_SRV && r.labels.length > 1 && sameName(r.labels.slice(1), service)) {
      const name = r.labels[0];
      const cur = out.get(name) || { name, ttl: r.ttl };
      cur.host = r.srv.target;
      cur.port = r.srv.port;
      cur.address = hosts.get(r.srv.target.toLowerCase()) || cur.address;
      out.set(name, cur);
    }
  }
  return [...out.values()];
}

function ipv4Interfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) out.push(a.address);
  }
  return out;
}

/**
 * Browse continuously. Calls onSource({name, host, port, address, ttl, from})
 * for every answer and onError(message) for socket problems.
 */
export class MdnsBrowser {
  constructor({ service = NDI_SERVICE, intervalMs = 5000, interfaces = null, onSource, onError } = {}) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.interfaces = interfaces && interfaces.length ? interfaces : null;
    this.onSource = onSource || (() => {});
    this.onError = onError || (() => {});
    this.sockets = [];
  }

  start() {
    this.stopped = false;
    // Preferred: share port 5353 so multicast answers and unsolicited
    // announcements reach us. Fallback: an ephemeral port, which makes our
    // queries "legacy unicast" — responders then answer us directly.
    this._open(MDNS_PORT, (err) => {
      if (err) this._open(0, (err2) => { if (err2) this.onError(`mDNS unavailable: ${err2.message}`); });
    });
    this.timer = setInterval(() => this.query(), this.intervalMs);
    return this;
  }

  _open(port, done) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let bound = false;
    sock.on('error', (e) => {
      if (!bound) { try { sock.close(); } catch { /* */ } done(e); return; }
      this.onError(e.message);
    });
    sock.on('message', (msg, rinfo) => {
      try {
        const p = parsePacket(msg);
        if (!p.isResponse) return;
        for (const s of ndiSourcesFrom(p, this.service)) this.onSource({ ...s, from: rinfo.address });
      } catch { /* not for us / malformed */ }
    });
    sock.bind(port, () => {
      bound = true;
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch { /* */ }
      const ifaces = this.interfaces || ipv4Interfaces();
      for (const ip of ifaces) { try { sock.addMembership(MDNS_ADDR, ip); } catch { /* iface without multicast */ } }
      this.sockets.push({ sock, port, ifaces });
      done(null);
      this.query();
    });
  }

  query() {
    if (this.stopped) return;
    const msg = buildQuery(this.service);
    for (const { sock, ifaces } of this.sockets) {
      const targets = ifaces.length ? ifaces : [null];
      for (const ip of targets) {
        try { if (ip) sock.setMulticastInterface(ip); } catch { /* */ }
        sock.send(msg, MDNS_PORT, MDNS_ADDR, () => {});
      }
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const { sock } of this.sockets) { try { sock.close(); } catch { /* */ } }
    this.sockets = [];
  }
}
