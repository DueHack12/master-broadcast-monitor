import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, buildInstanceQuery, parsePacket, ndiSourcesFrom, readName, pickInterfaces, sendOnEach, T_SRV, T_TXT } from '../src/lib/mdns.js';
import { ndiResponse } from '../tools/simulator.js';

test('query asks for _ndi._tcp.local PTR', () => {
  const q = buildQuery();
  assert.equal(q.readUInt16BE(4), 1);
  const { labels, end } = readName(q, 12);
  assert.deepEqual(labels, ['_ndi', '_tcp', 'local']);
  assert.equal(q.readUInt16BE(end), 12);
});

test('parses NDI sources from a response', () => {
  const p = parsePacket(ndiResponse(['CAM-PC (Camera 1)', 'GFX (Output)']));
  assert.equal(p.isResponse, true);
  const s = ndiSourcesFrom(p);
  assert.deepEqual(s.map((x) => x.name).sort(), ['CAM-PC (Camera 1)', 'GFX (Output)']);
  assert.equal(s[0].port, 5961);
  assert.equal(s[0].address, '127.0.0.1');
});

test('follows compression pointers', () => {
  // header + question "_ndi._tcp.local" + PTR answer whose name points back at the question
  const hdr = Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  const qname = Buffer.from([4, ...Buffer.from('_ndi'), 4, ...Buffer.from('_tcp'), 5, ...Buffer.from('local'), 0]);
  const qtail = Buffer.from([0, 12, 0, 1]);
  const inst = Buffer.from('BOX (Cam)');
  const rdata = Buffer.concat([Buffer.from([inst.length]), inst, Buffer.from([0xc0, 12])]);
  const ans = Buffer.concat([Buffer.from([0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 120, 0, rdata.length]), rdata]);
  const p = parsePacket(Buffer.concat([hdr, qname, qtail, ans]));
  assert.deepEqual(ndiSourcesFrom(p).map((x) => x.name), ['BOX (Cam)']);
});

test('a PTR with TTL 0 is a goodbye', () => {
  const s = ndiSourcesFrom(parsePacket(ndiResponse(['X (Y)'], 0)));
  assert.equal(s.length, 1);
  assert.equal(s[0].goodbye, true);
});

test('an SRV record expiring on its own is not a goodbye', () => {
  // Same packet shape as a sender refreshing its SRV: SRV with TTL 0, no PTR.
  const full = parsePacket(ndiResponse(['CAM (A)'], 0));
  const srvOnly = { isResponse: true, records: full.records.filter((r) => r.type === T_SRV) };
  assert.deepEqual(ndiSourcesFrom(srvOnly), []);
});

test('sendOnEach sends each copy out of its own interface', async () => {
  // Like Node: send() goes out a moment later, using whatever interface is set then.
  const fake = () => {
    const sent = [];
    let cur = null;
    return {
      sent,
      setMulticastInterface(ip) { cur = ip; },
      send(msg, port, addr, cb) { setImmediate(() => { sent.push(cur); cb?.(); }); }
    };
  };
  const naive = fake();
  for (const ip of ['10.0.0.5', '192.168.1.9', '127.0.0.1']) { naive.setMulticastInterface(ip); naive.send(Buffer.alloc(1), 5353, '224.0.0.251'); }
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(naive.sent, ['127.0.0.1', '127.0.0.1', '127.0.0.1'], 'the old loop sent everything out of the last interface');

  const fixed = fake();
  await sendOnEach(fixed, Buffer.alloc(1), ['10.0.0.5', '192.168.1.9']);
  assert.deepEqual(fixed.sent, ['10.0.0.5', '192.168.1.9']);
});

test('interfaces: real networks only, unless chosen', () => {
  const ifaces = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    Ethernet: [{ family: 'IPv4', address: '10.0.0.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '169.254.3.4', internal: false }],
    NDI: [{ family: 4, address: '192.168.50.2', internal: false }]
  };
  assert.deepEqual(pickInterfaces(ifaces).map((i) => i.address), ['10.0.0.20', '192.168.50.2']);
  assert.deepEqual(pickInterfaces(ifaces, ['192.168.50.2']).map((i) => i.address), ['192.168.50.2']);
});

test('asking one source directly keeps its name whole', () => {
  const q = buildInstanceQuery('CAM.PC (Cam 1)');
  assert.equal(q.readUInt16BE(4), 2);
  const first = readName(q, 12);
  assert.deepEqual(first.labels, ['CAM.PC (Cam 1)', '_ndi', '_tcp', 'local']);
  assert.equal(q.readUInt16BE(first.end), T_SRV);
  const second = readName(q, first.end + 4);
  assert.equal(q.readUInt16BE(second.end), T_TXT);
});

test('rejects garbage without throwing past parsePacket', () => {
  assert.throws(() => parsePacket(Buffer.from([1, 2, 3])));
  const loop = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12])]);
  assert.throws(() => parsePacket(loop));
});
