import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVmix, ampToDb, FLOOR_DB } from '../src/lib/xml.js';

const XML = `<vmix><version>27.0.0.49</version><edition>HD</edition>
<inputs>
<input key="k1" number="1" type="NDI" title="CAM-PC (Camera 1)" shortTitle="Camera 1" state="Running" muted="True" volume="100" meterF1="0" meterF2="0">CAM-PC (Camera 1)</input>
<input key="k2" number="2" type="Audio" title="Mic &amp; Desk" shortTitle="Mic" state="Running" muted="False" volume="80" meterF1="0.5" meterF2="0.25">Mic &amp; Desk</input>
<input key="k3" number="3" type="GT" title="Lower Third.gtzip" state="Paused">Lower Third.gtzip<text index="0" name="Name">Bob</text></input>
</inputs>
<preview>1</preview><active>2</active>
<fadeToBlack>False</fadeToBlack>
<recording duration="12">True</recording>
<external>False</external>
<streaming channel1="False" channel2="True" channel3="False">True</streaming>
<audio>
<master volume="100" muted="False" meterF1="1" meterF2="0.01" headphonesVolume="74.8"/>
<busA volume="100" muted="True" meterF1="0" meterF2="0" solo="False" sendToMaster="False"/>
</audio></vmix>`;

test('parses inputs, titles and entities', () => {
  const d = parseVmix(XML);
  assert.equal(d.version, '27.0.0.49');
  assert.equal(d.inputs.length, 3);
  assert.equal(d.inputs[1].title, 'Mic & Desk');
  assert.equal(d.inputs[0].type, 'NDI');
  assert.equal(d.inputs[2].title, 'Lower Third.gtzip');
  assert.equal(d.activeTitle, 'Mic & Desk');
  assert.equal(d.previewTitle, 'CAM-PC (Camera 1)');
});

test('reads streaming flag and per-channel state', () => {
  const d = parseVmix(XML);
  assert.equal(d.streaming, true);
  assert.deepEqual(d.streamChannels, { 1: false, 2: true, 3: false });
  assert.equal(d.recording, true);
  assert.equal(d.fadeToBlack, false);
});

test('older vMix without channel attributes', () => {
  const d = parseVmix('<vmix><streaming>False</streaming></vmix>');
  assert.equal(d.streaming, false);
  assert.deepEqual(d.streamChannels, {});
});

test('audio buses become dBFS', () => {
  const d = parseVmix(XML);
  assert.equal(d.buses.master.left, 0);
  assert.equal(Math.round(d.buses.master.right), -40);
  assert.equal(d.buses.busA.muted, true);
  assert.equal(d.buses.busA.left, FLOOR_DB);
  assert.equal(Math.round(d.inputs[1].left), -6);
});

test('rejects non-vMix documents', () => {
  assert.throws(() => parseVmix('<html></html>'));
  assert.throws(() => parseVmix(null));
});

test('ampToDb floors silence', () => {
  assert.equal(ampToDb(0), FLOOR_DB);
  assert.equal(ampToDb('nope'), FLOOR_DB);
  assert.equal(ampToDb(1), 0);
});
