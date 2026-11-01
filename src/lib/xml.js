/**
 * Just enough XML reading for the vMix API document — no dependencies.
 *
 * vMix's /api XML is flat and machine-generated: attributes are always
 * double-quoted, elements never nest the same tag, and the parts we read
 * (<input>, <streaming>, <audio> buses, a handful of booleans) have a fixed
 * shape. A regex reader is reliable for that and keeps `npm install` out of
 * the picture on a broadcast machine.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseAttrs(s) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[2]);
  return out;
}

const bool = (v) => /^true$/i.test(String(v ?? '').trim());
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[2].trim()) : null;
}

/**
 * vMix meters are linear amplitude, 0..1 where 1 is full scale. Convert to
 * dBFS, clamping silence to a floor so the maths downstream stays finite.
 */
export const FLOOR_DB = -100;
export function ampToDb(a) {
  const v = Number(a);
  if (!Number.isFinite(v) || v <= 0) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(v));
}

function meter(attrs) {
  const l = num(attrs.meterF1), r = num(attrs.meterF2);
  return {
    volume: num(attrs.volume),
    muted: bool(attrs.muted),
    left: l == null ? null : ampToDb(l),
    right: r == null ? null : ampToDb(r)
  };
}

/**
 * Parse the vMix /api document into the shape the monitors use.
 * Throws if the document does not look like vMix at all.
 */
export function parseVmix(xml) {
  if (typeof xml !== 'string' || !/<vmix[\s>]/i.test(xml)) throw new Error('Not a vMix API response');

  const inputs = [];
  const inputRe = /<input\s([^>]*?)(?:\/>|>([\s\S]*?)<\/input>)/gi;
  let m;
  while ((m = inputRe.exec(xml))) {
    const a = parseAttrs(m[1]);
    // The element text is the input title; inner tags (<text>, <list>, <overlay>) can follow it.
    const inner = (m[2] || '').replace(/<[\s\S]*$/, '').trim();
    inputs.push({
      number: parseInt(a.number, 10) || null,
      key: a.key || null,
      type: a.type || '',
      title: a.title || decodeEntities(inner) || '',
      shortTitle: a.shortTitle || '',
      state: a.state || '',
      ...meter(a),
      audioBusses: a.audiobusses || ''
    });
  }

  // <streaming>True</streaming> on older builds; newer builds add per-destination
  // channel1/channel2/channel3 attributes. Read both.
  let streaming = false;
  const channels = {};
  const sm = xml.match(/<streaming(\s[^>]*)?>([\s\S]*?)<\/streaming>/i);
  if (sm) {
    streaming = bool(sm[2]);
    const a = parseAttrs(sm[1] || '');
    for (const [k, v] of Object.entries(a)) {
      const cm = k.match(/^channel(\d+)$/i);
      if (cm) channels[cm[1]] = bool(v);
    }
  }

  const buses = {};
  const audioBlock = xml.match(/<audio>([\s\S]*?)<\/audio>/i);
  if (audioBlock) {
    const busRe = /<(master|bus[A-Z])\s([^>]*?)\/?>/gi;
    while ((m = busRe.exec(audioBlock[1]))) {
      const name = m[1].toLowerCase() === 'master' ? 'master' : 'bus' + m[1].slice(3).toUpperCase();
      buses[name] = meter(parseAttrs(m[2]));
    }
  }

  const active = parseInt(tagText(xml, 'active'), 10) || null;
  const preview = parseInt(tagText(xml, 'preview'), 10) || null;
  const byNumber = (n) => inputs.find((i) => i.number === n) || null;

  return {
    version: tagText(xml, 'version'),
    edition: tagText(xml, 'edition'),
    preset: tagText(xml, 'preset'),
    inputs,
    active, preview,
    activeTitle: byNumber(active)?.title ?? null,
    previewTitle: byNumber(preview)?.title ?? null,
    streaming,
    streamChannels: channels,
    recording: bool(tagText(xml, 'recording')),
    external: bool(tagText(xml, 'external')),
    multiCorder: bool(tagText(xml, 'multiCorder')),
    fadeToBlack: bool(tagText(xml, 'fadeToBlack')),
    buses
  };
}
