import test from 'node:test';
import assert from 'node:assert/strict';
import { chainIssues } from '../src/rules.js';

const NOW = 1_000_000;
function ctx({ vmix = {}, yt = {}, ytCfg = {} } = {}) {
  const vmixState = { online: true, streaming: false, streamingSince: null, ...vmix };
  const ytState = { configured: true, authed: true, lastOkAt: NOW - 1000, broadcast: null, stream: null, ...yt };
  return {
    now: NOW,
    monitors: {
      vmix: { state: vmixState },
      youtube: { state: ytState, cfg: { ingestGraceSec: 45, notLiveGraceSec: 0, ...ytCfg }, isStale: () => false }
    }
  };
}
const ids = (list) => list.map((i) => `${i.id}:${i.level}`);
const bc = (lc) => ({ id: 'b', title: 'Game', lifeCycleStatus: lc });
const stream = (status, health = 'good') => ({ title: 'key', streamStatus: status, health, issues: [] });

test('standby: nothing to say', () => {
  assert.deepEqual(chainIssues(ctx({ yt: { broadcast: bc('ready'), stream: stream('inactive', 'noData') } })), []);
});

test('just started streaming: yellow while YouTube catches up', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 10000 }, yt: { broadcast: bc('ready'), stream: stream('inactive') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.waiting:warn']);
});

test('data from before the stream started is not trusted', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 60000 }, yt: { lastOkAt: NOW - 70000, broadcast: bc('ready'), stream: stream('inactive') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.waiting:warn']);
});

test('grace over and still not receiving: red', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 60000 }, yt: { broadcast: bc('ready'), stream: stream('inactive') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.no_ingest:crit']);
});

test('receiving but in preview: red, press Go Live', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 5000 }, yt: { broadcast: bc('testing'), stream: stream('active') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.not_live:crit']);
});

test('notLiveGraceSec delays the Go Live alarm', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 5000 }, yt: { broadcast: bc('ready'), stream: stream('active') }, ytCfg: { notLiveGraceSec: 60 } });
  assert.deepEqual(chainIssues(c), []);
});

test('live and receiving: all good', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 600000 }, yt: { broadcast: bc('live'), stream: stream('active') } });
  assert.deepEqual(chainIssues(c), []);
});

test('live, vMix stopped: red', () => {
  const c = ctx({ vmix: { streaming: false }, yt: { broadcast: bc('live'), stream: stream('inactive', 'noData') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.live_no_vmix:crit']);
});

test('live, stream restarted: shorter grace', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 20000 }, yt: { broadcast: bc('live'), stream: stream('inactive') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.no_ingest:crit']);
});

test('bad health: yellow', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 600000 }, yt: { broadcast: bc('live'), stream: stream('active', 'bad') } });
  assert.deepEqual(ids(chainIssues(c)), ['youtube.health:warn']);
});

test('YouTube not connected: chain rules stay quiet', () => {
  const c = ctx({ vmix: { streaming: true, streamingSince: NOW - 600000 }, yt: { authed: false } });
  assert.deepEqual(chainIssues(c), []);
});
