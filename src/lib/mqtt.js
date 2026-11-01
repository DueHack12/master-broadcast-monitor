import net from 'node:net';
import tls from 'node:tls';

/**
 * Minimal MQTT 3.1.1 subscriber — no dependencies.
 *
 * Adapted from OpenStatsEngine's src/integrations/mqtt.js (MIT). Differences
 * for a monitor rather than a data consumer:
 *   - it always reconnects, including after the broker refuses us, because a
 *     monitor that gives up is worse than one that keeps knocking;
 *   - connects time out instead of hanging on an unreachable host;
 *   - a connection that has gone silent at the TCP level (no PINGRESP) is
 *     torn down and retried, so "connected" never lies.
 *
 * Several subscribers can share one broker, so this runs happily alongside
 * OpenStatsEngine reading the same ScoreConnect topic.
 */

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4,
      SUBSCRIBE = 8, SUBACK = 9, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;

function vbi(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}
function mstr(s) {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
}
export function packet(type, flags, body = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), vbi(body.length), body]);
}

const CONNACK_ERRORS = {
  1: 'broker rejected the protocol version',
  2: 'broker rejected the client id',
  3: 'broker unavailable',
  4: 'bad username or password',
  5: 'not authorised'
};

export class MqttClient {
  /**
   * @param {object} o
   *   host, port, topic, username, password, tls
   *   onMessage(topic, payloadString)
   *   onStatus({connected, error, topic})
   */
  constructor(o) {
    this.host = o.host;
    this.port = o.port || (o.tls ? 8883 : 1883);
    this.topic = o.topic || '#';
    this.username = o.username || undefined;
    this.password = o.password || undefined;
    this.tls = !!o.tls;
    this.onMessage = o.onMessage || (() => {});
    this.onStatus = o.onStatus || (() => {});
    this.keepalive = 20;
    this.retryMs = o.retryMs ?? 3000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 4000;
    this.closed = false;
    this.buf = Buffer.alloc(0);
  }

  connect() {
    this.closed = false;
    this.buf = Buffer.alloc(0);
    const opts = { host: this.host, port: this.port };
    const sock = this.sock = this.tls
      ? tls.connect({ ...opts, rejectUnauthorized: false })
      : net.createConnection(opts);
    sock.setNoDelay(true);
    this.connTimer = setTimeout(() => {
      this._fail(`no answer from ${this.host}:${this.port}`);
    }, this.connectTimeoutMs);

    sock.on(this.tls ? 'secureConnect' : 'connect', () => this._sendConnect());
    sock.on('data', (c) => { this.lastRx = Date.now(); this._onData(c); });
    sock.on('error', (e) => {
      this.lastError = { ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset', EHOSTUNREACH: 'host unreachable', ENETUNREACH: 'network unreachable', ETIMEDOUT: 'timed out' }[e.code] || e.message;
    });
    sock.on('close', () => {
      if (sock !== this.sock) return;
      clearTimeout(this.connTimer);
      clearInterval(this.pinger);
      this.onStatus({ connected: false, error: this.lastError || 'connection closed' });
      if (!this.closed) this.retry = setTimeout(() => this.connect(), this.retryMs);
    });
    return this;
  }

  end() {
    this.closed = true;
    clearTimeout(this.connTimer);
    clearInterval(this.pinger);
    clearTimeout(this.retry);
    try { this.sock?.write(packet(DISCONNECT, 0)); } catch { /* already gone */ }
    try { this.sock?.destroy(); } catch { /* already gone */ }
  }

  _fail(why) {
    this.lastError = why;
    try { this.sock?.destroy(); } catch { /* already gone */ }
  }

  _sendConnect() {
    const clientId = 'broadcast-monitor-' + Math.random().toString(16).slice(2, 10);
    let flags = 0x02; // clean session
    const extra = [];
    if (this.username) { flags |= 0x80; extra.push(mstr(this.username)); }
    if (this.password) { flags |= 0x40; extra.push(mstr(this.password)); }
    this.sock.write(packet(CONNECT, 0, Buffer.concat([
      mstr('MQTT'), Buffer.from([4]),
      Buffer.from([flags]),
      Buffer.from([this.keepalive >> 8, this.keepalive & 0xff]),
      mstr(clientId), ...extra
    ])));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1, len = 0, i = 1, b;
      do {
        if (i >= this.buf.length) return;
        b = this.buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
        if (mult > 128 ** 4) { this._fail('malformed packet from broker'); return; }
      } while (b & 0x80);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4, flags = this.buf[0] & 0x0f;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this._handle(type, flags, body);
    }
  }

  _handle(type, flags, body) {
    switch (type) {
      case CONNACK: {
        clearTimeout(this.connTimer);
        const rc = body[1];
        if (rc !== 0) { this._fail(CONNACK_ERRORS[rc] || `broker refused (code ${rc})`); return; }
        this.sock.write(packet(SUBSCRIBE, 2, Buffer.concat([
          Buffer.from([0x00, 0x01]), mstr(this.topic), Buffer.from([0x00])
        ])));
        this.pinger = setInterval(() => {
          // Nothing heard for 1.5 keepalives: the link is dead even if TCP has not noticed.
          if (Date.now() - (this.lastRx || 0) > this.keepalive * 1500) { this._fail('broker stopped answering'); return; }
          try { this.sock.write(packet(PINGREQ, 0)); } catch { /* closing */ }
        }, (this.keepalive / 2) * 1000);
        break;
      }
      case SUBACK: {
        if (body[2] === 0x80) this._fail(`broker refused topic "${this.topic}"`);
        else { this.lastError = null; this.onStatus({ connected: true, topic: this.topic }); }
        break;
      }
      case PUBLISH: {
        if (body.length < 2) return;
        const tlen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tlen).toString('utf8');
        let off = 2 + tlen;
        const qos = (flags >> 1) & 0x03;
        let packetId = null;
        if (qos > 0) { packetId = body.readUInt16BE(off); off += 2; }
        const payload = body.subarray(off).toString('utf8');
        if (qos === 1 && packetId != null) {
          try { this.sock.write(packet(PUBACK, 0, Buffer.from([packetId >> 8, packetId & 0xff]))); } catch { /* closing */ }
        }
        this.onMessage(topic, payload);
        break;
      }
      case PINGRESP: break;
      default: break;
    }
  }
}
