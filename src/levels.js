/**
 * Alert levels, lowest to highest. The status bar shows the highest active one:
 *   crit → red, warn → yellow, otherwise green. `info` appears on its card only.
 */
export const LEVELS = ['ok', 'info', 'warn', 'crit'];

export const rank = (l) => LEVELS.indexOf(l);
export const atLeast = (l, min) => rank(l) >= rank(min);
export const worst = (levels) => levels.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'ok');

function globToRegex(glob) {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

/**
 * Apply `alerts.overrides` to an issue id. An exact id beats a wildcard; among
 * wildcards the longest pattern wins. "off" suppresses the issue entirely.
 */
export function overrideLevel(id, level, overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return level;
  if (overrides[id]) return overrides[id];
  let best = null;
  for (const pat of Object.keys(overrides)) {
    if (!pat.includes('*')) continue;
    if (globToRegex(pat).test(id) && (!best || pat.length > best.length)) best = pat;
  }
  return best ? overrides[best] : level;
}

/** Turn fetch/socket errors into words an operator can act on. */
export function netError(e) {
  if (!e) return 'unknown error';
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timed out';
  const code = e.cause?.code || e.code;
  const words = {
    ECONNREFUSED: 'connection refused', ECONNRESET: 'connection reset', EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable', ENOTFOUND: 'host name not found', ETIMEDOUT: 'timed out',
    UND_ERR_SOCKET: 'connection dropped', UND_ERR_CONNECT_TIMEOUT: 'timed out'
  };
  return words[code] || (code ? `${e.message} (${code})` : e.message);
}

export function fmtAgo(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
