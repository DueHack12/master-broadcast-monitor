import { execFile } from 'node:child_process';
import net from 'node:net';

/**
 * ICMP ping through the system `ping` command (raw sockets need admin rights,
 * the command does not). Works on Windows, macOS and Linux — each wants
 * different flags and words its output differently.
 */

export function pingArgs(host, timeoutMs, platform = process.platform) {
  if (platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host];
  // macOS -W is milliseconds; Linux (iputils/busybox) -W is whole seconds.
  if (platform === 'darwin') return ['-c', '1', '-W', String(timeoutMs), host];
  return ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
}

/**
 * Decide from ping's output whether a reply came back.
 * Windows exits 0 for "Destination host unreachable" relayed by a router, so
 * the presence of a TTL in a reply line is the only trustworthy signal there.
 */
export function parsePing(stdout, exitOk, platform = process.platform) {
  const text = String(stdout || '');
  const replied = platform === 'win32' ? /TTL=\d+/i.test(text) : exitOk && /ttl=\d+/i.test(text);
  const t = text.match(/time\s*[=<]\s*([\d.]+)\s*ms/i);
  return { ok: replied, rttMs: replied && t ? parseFloat(t[1]) : null };
}

let pingMissing = false;

/** Resolves { ok, rttMs, error?, unavailable? } — never rejects. */
export function ping(host, timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (pingMissing) { resolve({ ok: false, rttMs: null, unavailable: true, error: 'ping command not found' }); return; }
    execFile('ping', pingArgs(host, timeoutMs), { timeout: timeoutMs + 3000, windowsHide: true }, (err, stdout) => {
      if (err && err.code === 'ENOENT') {
        pingMissing = true;
        resolve({ ok: false, rttMs: null, unavailable: true, error: 'ping command not found' });
        return;
      }
      const r = parsePing(stdout, !err);
      resolve(r.ok ? r : { ...r, error: 'no reply' });
    });
  });
}

/** TCP connect check — "is anything listening on host:port". */
export function tcpCheck(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    const done = (ok, error) => { sock.destroy(); resolve({ ok, rttMs: ok ? Date.now() - started : null, error }); };
    sock.setTimeout(timeoutMs, () => done(false, 'timed out'));
    sock.on('connect', () => done(true));
    sock.on('error', (e) => done(false, e.code === 'ECONNREFUSED' ? 'connection refused' : e.message));
  });
}
