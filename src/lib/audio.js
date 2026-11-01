/**
 * Watches one audio source's peak level and decides whether it is clipping or
 * too quiet.
 *
 *   Too low:  the peak stayed below `low.thresholdDb` continuously for
 *             `low.durationSec`. Any louder sample resets the timer.
 *   Clipping: the peak reached `clip.thresholdDb` at least `clip.minHits`
 *             times within the last `clip.windowSec`. One stray transient is
 *             ignored; a voice or music bed that keeps hitting the ceiling is not.
 *
 * Feed it samples with `sample()`; read the verdict with `status()`.
 */

export const DEFAULT_AUDIO = {
  clip: { thresholdDb: -1, windowSec: 10, minHits: 3 },
  low: { thresholdDb: -50, durationSec: 10 }
};

export class LevelWatcher {
  constructor(opts = {}) { this.configure(opts); this.reset(); }

  configure(opts = {}) {
    this.clip = { ...DEFAULT_AUDIO.clip, ...(opts.clip || {}) };
    this.low = { ...DEFAULT_AUDIO.low, ...(opts.low || {}) };
  }

  reset(now = Date.now()) {
    this.lastAboveLow = now;
    this.clipTimes = [];
    this.lastClip = null;
    this.peakDb = null;
    this.left = null;
    this.right = null;
    this.muted = false;
    this.lastSample = null;
    this.holdDb = null;
    this.holdAt = 0;
  }

  /** Restart the quiet timer, e.g. when the stream starts. */
  restartLowTimer(now = Date.now()) { this.lastAboveLow = now; }

  sample({ left, right, muted = false }, now = Date.now()) {
    const vals = [left, right].filter((v) => typeof v === 'number' && Number.isFinite(v));
    const peak = vals.length ? Math.max(...vals) : null;
    this.left = left ?? null;
    this.right = right ?? null;
    this.peakDb = peak;
    this.muted = !!muted;
    this.lastSample = now;

    if (peak != null && peak > this.low.thresholdDb && !muted) this.lastAboveLow = now;
    if (peak != null && peak >= this.clip.thresholdDb) {
      this.clipTimes.push(now);
      this.lastClip = now;
    }
    this._prune(now);

    // Peak hold for the meter display: 1.5 s, then fall back.
    if (peak != null && (this.holdDb == null || peak >= this.holdDb || now - this.holdAt > 1500)) {
      this.holdDb = peak;
      this.holdAt = now;
    }
  }

  _prune(now) {
    const cutoff = now - this.clip.windowSec * 1000;
    while (this.clipTimes.length && this.clipTimes[0] < cutoff) this.clipTimes.shift();
  }

  status(now = Date.now()) {
    this._prune(now);
    const quietMs = now - this.lastAboveLow;
    return {
      peakDb: this.peakDb,
      left: this.left,
      right: this.right,
      holdDb: this.holdDb,
      muted: this.muted,
      clipping: this.clipTimes.length >= this.clip.minHits,
      clipHits: this.clipTimes.length,
      clippedRecently: this.lastClip != null && now - this.lastClip < 2000,
      quietMs,
      belowLow: this.peakDb == null || this.peakDb <= this.low.thresholdDb || this.muted,
      low: quietMs >= this.low.durationSec * 1000,
      stale: this.lastSample == null || now - this.lastSample > 3000
    };
  }
}
