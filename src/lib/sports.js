/**
 * Sport identification for the scoreboard feed.
 *
 * Sportzcast's JSON carries a numeric `VendorSportId` (23 = soccer, verified
 * on a real ScoreConnect III). Other IDs are learned per venue — the dashboard
 * has a one-click "this ID is <sport>" button — and stored in settings.
 *
 * When there is no ID, the field names give a decent hint (football sends
 * Down/ToGo, baseball sends Balls/Strikes...). That guess is shown on the card
 * but is never strong enough on its own to raise an alarm.
 */

export const SPORTS = [
  { id: 'football', name: 'Football' },
  { id: 'soccer', name: 'Soccer' },
  { id: 'basketball', name: 'Basketball' },
  { id: 'volleyball', name: 'Volleyball' },
  { id: 'hockey', name: 'Ice Hockey' },
  { id: 'lacrosse', name: 'Lacrosse' },
  { id: 'baseball', name: 'Baseball / Softball' }
];

export const DEFAULT_VENDOR_SPORT_IDS = { 23: 'soccer' };

export const sportName = (id) => SPORTS.find((s) => s.id === id)?.name || id || '—';

/** Map a free-text sport name (OpenStatsEngine's `sportName`) to an id. */
export function sportIdFromName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  if (n.includes('hockey')) return 'hockey';
  if (n.includes('baseball') || n.includes('softball')) return 'baseball';
  return SPORTS.find((s) => n.includes(s.id))?.id || null;
}

/** Field-name heuristics → list of plausible sports (may be empty). */
export function fingerprint(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const keys = new Set(Object.keys(raw).map((k) => k.toLowerCase()));
  const has = (...names) => names.some((n) => [...keys].some((k) => k.includes(n)));
  if (has('togo', 'ballon') || keys.has('down')) return ['football'];
  if (has('strikes', 'inning') || (keys.has('balls') && keys.has('outs'))) return ['baseball'];
  if (has('cornerkick')) return ['soccer'];
  if (has('gameswon', 'serve')) return ['volleyball'];
  if (has('foul', 'bonus')) return ['basketball'];
  if (has('penalty')) return ['hockey', 'lacrosse'];
  return [];
}

/**
 * Work out the scoreboard's sport from one raw message.
 * Returns { vendorId, sport, method: 'id' | 'guess' | null, candidates }
 */
export function detectSport(raw, vendorMap = {}) {
  const map = { ...DEFAULT_VENDOR_SPORT_IDS, ...vendorMap };
  let vendorId = null;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (k.toLowerCase() === 'vendorsportid' && v != null && String(v).trim() !== '') vendorId = String(v).trim();
    }
  }
  if (vendorId != null && map[vendorId]) return { vendorId, sport: map[vendorId], method: 'id', candidates: [map[vendorId]] };
  const candidates = fingerprint(raw);
  return { vendorId, sport: candidates.length === 1 ? candidates[0] : null, method: candidates.length ? 'guess' : null, candidates };
}
