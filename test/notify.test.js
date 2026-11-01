import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, compose } from '../src/notify.js';

function make(notify = {}) {
  const app = {
    log: { add() {} },
    cfg: {
      stationName: 'Test', publicUrl: '',
      notify: {
        onlyWhenOnAir: false, persistSec: 5, cooldownSec: 60, repeatAfterMin: 0, recovery: true,
        webhook: { enabled: true, url: 'http://x', minLevel: 'warn' }, ...notify
      }
    }
  };
  const n = new Notifier(app);
  const sent = [];
  n.send = (name, ch, msg) => { sent.push(msg); return Promise.resolve(); };
  return { n, sent };
}
const issue = (id, level, since) => ({ id, level, title: id, detail: `${id} detail`, since });

test('waits persistSec before sending', () => {
  const { n, sent } = make();
  const i = [issue('a', 'crit', 0)];
  n.tick(i, true, 4000);
  assert.equal(sent.length, 0);
  n.tick(i, true, 5000);
  assert.equal(sent.length, 1);
  n.tick(i, true, 9000);
  assert.equal(sent.length, 1, 'not repeated');
});

test('respects minLevel', () => {
  const { n, sent } = make({ webhook: { enabled: true, url: 'x', minLevel: 'crit' } });
  n.tick([issue('a', 'warn', 0)], true, 10000);
  assert.equal(sent.length, 0);
});

test('only when on air', () => {
  const { n, sent } = make({ onlyWhenOnAir: true });
  n.tick([issue('a', 'crit', 0)], false, 10000);
  assert.equal(sent.length, 0);
  n.tick([issue('a', 'crit', 0)], true, 11000);
  assert.equal(sent.length, 1);
});

test('all clear after the issue has been gone persistSec', () => {
  const { n, sent } = make();
  n.tick([issue('a', 'crit', 0)], true, 6000);
  n.tick([], true, 7000);
  assert.equal(sent.length, 1);
  n.tick([], true, 12000);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].level, 'ok');
});

test('a quick flap inside the cooldown is not re-sent', () => {
  const { n, sent } = make({ recovery: false });
  n.tick([issue('a', 'crit', 0)], true, 6000);
  n.tick([], true, 7000);
  n.tick([issue('a', 'crit', 8000)], true, 14000);
  assert.equal(sent.length, 1);
});

test('a return after an all-clear is always sent', () => {
  const { n, sent } = make();
  n.tick([issue('a', 'crit', 0)], true, 6000);
  n.tick([], true, 7000);
  n.tick([], true, 13000); // all clear
  n.tick([issue('a', 'crit', 14000)], true, 20000);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].level, 'crit');
});

test('reminders while an issue lasts', () => {
  const { n, sent } = make({ repeatAfterMin: 1 });
  const i = [issue('a', 'crit', 0)];
  n.tick(i, true, 6000);
  n.tick(i, true, 60000);
  n.tick(i, true, 67000);
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /Still/);
});

test('compose groups several issues', () => {
  const m = compose([issue('a', 'crit', 0), issue('b', 'warn', 0)], [issue('a', 'crit', 0), issue('b', 'warn', 0), issue('c', 'warn', 0)], 'S');
  assert.match(m.title, /a/);
  assert.match(m.text, /b/);
  assert.match(m.text, /\+1 other/);
});
