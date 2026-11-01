import { LIFECYCLE } from './monitors/youtube.js';
import { fmtAgo } from './levels.js';

/**
 * The stream chain: vMix → YouTube ingest → YouTube LIVE.
 * These rules need both monitors, so they live here rather than in either one.
 *
 *   vMix streaming, YouTube not receiving yet  → warn during the grace period, then crit
 *   YouTube receiving, broadcast not LIVE       → crit "press Go Live"
 *   YouTube LIVE, vMix not streaming            → crit
 *   Receiving, health "bad"                     → warn
 */
export function chainIssues(ctx) {
  const vm = ctx.monitors.vmix, yt = ctx.monitors.youtube;
  if (!vm || !yt) return [];
  const vs = vm.state, ys = yt.state;
  if (!ys.configured || !ys.authed || yt.isStale(ctx.now)) return []; // youtube.* issues explain why
  const cfg = yt.cfg;
  const b = ys.broadcast, st = ys.stream;
  const lc = b?.lifeCycleStatus;
  const live = lc === 'live';
  const receiving = st?.streamStatus === 'active';
  const out = [];

  if (vs.streaming) {
    const since = ctx.now - vs.streamingSince;
    // Only trust YouTube data fetched after vMix started; older data predates the stream.
    const fresh = ys.lastOkAt && ys.lastOkAt > vs.streamingSince;
    if (!receiving) {
      // Already LIVE means viewers are affected right now, so allow less time.
      const grace = (live ? Math.min(cfg.ingestGraceSec, 15) : cfg.ingestGraceSec) * 1000;
      if (!fresh || since < grace) {
        out.push({
          id: 'youtube.waiting', level: 'warn', title: 'Waiting for YouTube to pick up the stream',
          detail: `vMix has been streaming for ${fmtAgo(since)}. YouTube usually sees it within 10–30 seconds.`
        });
      } else {
        out.push({
          id: 'youtube.no_ingest', level: 'crit',
          title: live ? "LIVE on YouTube but YouTube isn't receiving the feed" : "vMix is streaming but YouTube isn't receiving it",
          detail: b
            ? `"${b.title}" — its stream key "${st?.title || 'none bound'}" is ${st?.streamStatus || 'not active'}. Check the stream key in vMix and the internet connection.`
            : 'No YouTube broadcast found for this channel. Check the stream key in vMix belongs to this channel.'
        });
      }
    } else if (!live && since >= cfg.notLiveGraceSec * 1000) {
      out.push({
        id: 'youtube.not_live', level: 'crit', title: 'NOT LIVE on YouTube — press Go Live',
        detail: `YouTube is receiving the feed, but "${b?.title || 'the broadcast'}" is ${b ? (LIFECYCLE[lc]?.label || lc) : 'not set up'}. Viewers can't see it until you go live in Live Control Room.`
      });
    }
  }

  if (live && !vs.streaming && vs.online) {
    out.push({
      id: 'youtube.live_no_vmix', level: 'crit', title: 'YouTube is LIVE but vMix is not streaming',
      detail: `"${b.title}" is live and viewers are watching a stalled stream. Start streaming in vMix, or end the broadcast.`
    });
  }

  if (receiving && st?.health === 'bad') {
    out.push({
      id: 'youtube.health', level: 'warn', title: 'YouTube reports stream health BAD',
      detail: (st.issues || []).filter((i) => i.severity !== 'info').map((i) => i.description || i.reason).join(' ') || 'Check bitrate, resolution and the upload connection.'
    });
  }
  return out;
}
