import { Monitor } from './base.js';
import { parseVmix } from '../lib/xml.js';
import { fmtAgo, netError } from '../levels.js';

/**
 * vMix over its HTTP API (http://host:8088/api). Polled a few times a second:
 * the same document carries the streaming flag and the audio meters, and the
 * audio monitor reads the meters from here rather than polling vMix again.
 */
export default class VmixMonitor extends Monitor {
  static id = 'vmix';
  static title = 'vMix';

  start() {
    this.state = {
      online: false, lastOkAt: null, error: null, data: null,
      streaming: false, streamingSince: null, startedAt: Date.now()
    };
    this.url = `http://${this.cfg.host}:${this.cfg.port}/api`;
    this.loop(() => this.poll(), this.cfg.pollMs);
  }

  stop() { this.clearTimers(); }

  async poll() {
    const now = Date.now();
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = parseVmix(await res.text());
      const streaming = this.youtubeStreaming(data);
      const wasOnline = this.state.online;
      const wasStreaming = this.state.streaming;
      this.state.data = data;
      this.state.online = true;
      this.state.lastOkAt = now;
      this.state.error = null;
      if (streaming !== wasStreaming) {
        this.state.streaming = streaming;
        this.state.streamingSince = streaming ? now : null;
        this.app.log.add(streaming ? 'info' : 'warn', streaming ? 'vMix started streaming' : 'vMix stopped streaming', this.id);
        this.app.emit('vmix:streaming', streaming);
      }
      if (!wasOnline) this.app.log.add('info', `Connected to vMix ${data.version || ''} at ${this.cfg.host}`, this.id);
      this.app.emit('vmix:data', data, now);
      this.app.changed();
    } catch (e) {
      this.state.error = netError(e);
      const since = this.state.lastOkAt ?? this.state.startedAt;
      if (this.state.online && now - since > this.cfg.offlineAfterMs) {
        this.state.online = false;
        this.app.log.add('crit', `Lost contact with vMix (${this.state.error})`, this.id);
        this.app.changed();
      } else if (!this.state.online) this.app.changed();
    }
  }

  /** True if any stream destination that feeds YouTube is live in vMix. */
  youtubeStreaming(d) {
    const ch = d.streamChannels || {};
    const known = Object.keys(ch);
    if (!known.length) return !!d.streaming;
    const wanted = (this.cfg.youtubeChannels || [1, 2, 3]).map(String);
    return known.some((k) => wanted.includes(k) && ch[k]);
  }

  /** Has vMix been unreachable long enough to call it offline? */
  isOffline(now) {
    if (this.state.online) return false;
    const since = this.state.lastOkAt ?? this.state.startedAt;
    return now - since > this.cfg.offlineAfterMs;
  }

  issues(ctx) {
    if (this.isOffline(ctx.now)) {
      return [{
        id: 'vmix.offline', level: 'crit', title: 'vMix is not responding',
        detail: `No answer from ${this.url} (${this.state.error || 'no response'}). Is vMix running and the Web Controller enabled?`
      }];
    }
    const d = this.state.data;
    const out = [];
    if (d && ctx.onAir && d.fadeToBlack) out.push({ id: 'vmix.ftb', level: 'warn', title: 'vMix is faded to black', detail: 'Fade To Black is active while on air.' });
    return out;
  }

  view(ctx) {
    const s = this.state, d = s.data;
    if (!s.online) {
      const offline = this.isOffline(ctx.now);
      return {
        level: offline ? 'crit' : 'idle',
        status: offline ? 'Offline' : 'Connecting…',
        rows: [
          { label: 'API', value: `${this.cfg.host}:${this.cfg.port}` },
          { label: 'Error', value: s.error || '—', level: offline ? 'crit' : undefined },
          { label: 'Last contact', value: s.lastOkAt ? `${fmtAgo(ctx.now - s.lastOkAt)} ago` : 'never' }
        ]
      };
    }
    const chans = Object.entries(d.streamChannels || {});
    const streamValue = chans.length
      ? chans.map(([k, v]) => `${k}: ${v ? 'ON' : 'off'}`).join('  ·  ')
      : (d.streaming ? 'ON' : 'off');
    return {
      level: s.streaming ? 'ok' : 'idle',
      status: s.streaming ? `Streaming ${fmtAgo(ctx.now - s.streamingSince)}` : 'Not streaming',
      rows: [
        { label: 'Stream', value: streamValue, level: s.streaming ? 'ok' : undefined },
        { label: 'Program', value: d.activeTitle || `Input ${d.active ?? '—'}` },
        { label: 'Preview', value: d.previewTitle || `Input ${d.preview ?? '—'}` },
        { label: 'Recording', value: d.recording ? 'ON' : 'off', level: d.recording ? 'ok' : undefined },
        { label: 'Fade to black', value: d.fadeToBlack ? 'ACTIVE' : 'off', level: d.fadeToBlack ? 'warn' : undefined },
        { label: 'Version', value: [d.version, d.edition].filter(Boolean).join(' ') || '—' }
      ]
    };
  }
}
