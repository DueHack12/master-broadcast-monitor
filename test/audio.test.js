import test from 'node:test';
import assert from 'node:assert/strict';
import { LevelWatcher } from '../src/lib/audio.js';

const cfg = { clip: { thresholdDb: -1, windowSec: 10, minHits: 3 }, low: { thresholdDb: -50, durationSec: 10 } };

test('low alert only after the full duration of quiet', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  for (let t = 0; t <= 9000; t += 250) w.sample({ left: -70, right: -70 }, t);
  assert.equal(w.status(9000).low, false);
  w.sample({ left: -70, right: -70 }, 10000);
  assert.equal(w.status(10000).low, true);
});

test('one loud sample resets the quiet timer', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  w.sample({ left: -70, right: -70 }, 9000);
  w.sample({ left: -20, right: -70 }, 9500);
  w.sample({ left: -70, right: -70 }, 15000);
  assert.equal(w.status(15000).low, false);
  assert.equal(w.status(19600).low, true);
});

test('muted counts as quiet even with meter activity', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  for (let t = 0; t <= 11000; t += 500) w.sample({ left: -10, right: -10, muted: true }, t);
  assert.equal(w.status(11000).low, true);
});

test('a single transient is not clipping; repeated peaks are', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  w.sample({ left: 0, right: -10 }, 1000);
  assert.equal(w.status(1000).clipping, false);
  assert.equal(w.status(1000).clippedRecently, true);
  w.sample({ left: -0.5, right: -10 }, 2000);
  w.sample({ left: -10, right: -0.2 }, 3000);
  assert.equal(w.status(3000).clipping, true);
});

test('clip hits age out of the window', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  [1000, 2000, 3000].forEach((t) => w.sample({ left: 0, right: 0 }, t));
  assert.equal(w.status(3000).clipping, true);
  assert.equal(w.status(12500).clipping, false);
});

test('restartLowTimer gives a fresh countdown', () => {
  const w = new LevelWatcher(cfg);
  w.reset(0);
  w.sample({ left: -80, right: -80 }, 20000);
  assert.equal(w.status(20000).low, true);
  w.restartLowTimer(20000);
  assert.equal(w.status(25000).low, false);
});
