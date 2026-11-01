/**
 * The Settings page's fields — one list used by both sides:
 *   - the browser draws the form from it (public/settings.js);
 *   - the server validates what comes back against it (src/http.js).
 *
 * Each field: { path, label, type, help?, min?, max?, step?, options?, optional?, advanced? }
 * Types: text, host, port, number, bool, select, url, secret, secret-url,
 *        list (strings), phones, checks (numbers), audioSources, heading.
 *
 * Anything not listed here is still configurable by hand in config.json.
 */

export const LEVEL_OPTIONS = [
  { value: 'warn', label: 'Yellow and red' },
  { value: 'crit', label: 'Red only' }
];

export const SECTIONS = [
  {
    id: 'general', title: 'General',
    fields: [
      { path: 'stationName', label: 'Station name', type: 'text', max: 60, help: 'Shown on the dashboard and in phone alerts.' },
      { path: 'publicUrl', label: 'Dashboard address', type: 'url', optional: true, help: 'The link in phone alerts. Tap an alert to open the dashboard.' },
      { path: 'port', label: 'Dashboard port', type: 'port', help: 'Takes effect the next time Broadcast Monitor starts.' }
    ]
  },
  {
    id: 'vmix', title: 'vMix', toggle: 'vmix.enabled',
    fields: [
      { path: 'vmix.host', label: 'vMix computer', type: 'host', help: 'IP address of the vMix computer, or 127.0.0.1 if it is this one. In vMix: Settings → Web Controller → enable.' },
      { path: 'vmix.port', label: 'Web Controller port', type: 'port' },
      { path: 'vmix.youtubeChannels', label: 'Stream destinations that go to YouTube', type: 'checks', options: [1, 2, 3], help: 'vMix can stream to three places. Tick the ones that are YouTube.' }
    ]
  },
  {
    id: 'youtube', title: 'YouTube', toggle: 'youtube.enabled',
    guide: 'https://github.com/DueHack12/master-broadcast-monitor#youtube',
    fields: [
      { path: 'youtube.clientId', label: 'Google client ID', type: 'text', optional: true, max: 200 },
      { path: 'youtube.clientSecret', label: 'Google client secret', type: 'secret', optional: true, help: 'From Google Cloud → Credentials, type "TVs and Limited Input devices". After saving, press Connect YouTube on the dashboard.' },
      { path: 'youtube.ingestGraceSec', label: 'Seconds before "YouTube isn\'t receiving" turns red', type: 'number', min: 10, max: 300 },
      { path: 'youtube.notLiveGraceSec', label: 'Seconds before "NOT LIVE — press Go Live" turns red', type: 'number', min: 0, max: 3600, help: '0 = as soon as YouTube is receiving. Raise it if you stream a preview for a while before going live.' },
      { path: 'youtube.showViewers', label: 'Show viewer count', type: 'bool' }
    ]
  },
  {
    id: 'audio', title: 'Audio', toggle: 'audio.enabled',
    fields: [
      { path: 'audio.sources', label: 'Sources to watch', type: 'audioSources' },
      { path: 'audio.onlyWhenOnAir', label: 'Only alert while on air', type: 'bool' },
      { path: 'audio.low.thresholdDb', label: 'Too quiet below (dBFS)', type: 'number', min: -90, max: -10, step: 1 },
      { path: 'audio.low.durationSec', label: '…for longer than (seconds)', type: 'number', min: 1, max: 300 },
      { path: 'audio.clip.thresholdDb', label: 'Clipping at or above (dBFS)', type: 'number', min: -20, max: 0, step: 0.5 },
      { path: 'audio.clip.minHits', label: 'Clipping peaks needed', type: 'number', min: 1, max: 100 },
      { path: 'audio.clip.windowSec', label: '…within (seconds)', type: 'number', min: 1, max: 120, help: 'One stray peak is ignored; audio that keeps hitting the ceiling is not.' }
    ]
  },
  {
    id: 'scorebot', title: 'Scorebot (Sportzcast ScoreConnect)', toggle: 'scorebot.enabled',
    fields: [
      { path: 'scorebot.host', label: 'ScoreConnect computer', type: 'host', help: 'IP of the computer running ScoreConnect, or 127.0.0.1 if it is this one.' },
      { path: 'scorebot.ping.enabled', label: 'Ping the ScoreConnect computer', type: 'bool' },
      { path: 'scorebot.silentAfterSec', label: 'Alert if no data for (seconds)', type: 'number', min: 0, max: 300, help: '0 turns this off — for boards that only send when something changes.' },
      { path: 'scorebot.mqtt.port', label: 'MQTT port', type: 'port', advanced: true },
      { path: 'scorebot.mqtt.topic', label: 'MQTT topic', type: 'text', max: 200, advanced: true },
      { path: 'scorebot.mqtt.username', label: 'MQTT username', type: 'text', optional: true, max: 200, advanced: true },
      { path: 'scorebot.mqtt.password', label: 'MQTT password', type: 'secret', optional: true, advanced: true }
    ]
  },
  {
    id: 'ose', title: 'OpenStatsEngine', toggle: 'ose.enabled',
    fields: [
      { path: 'ose.url', label: 'OpenStatsEngine address', type: 'url' },
      { path: 'ose.required', label: 'Alert when OpenStatsEngine isn\'t running', type: 'bool', help: 'Off: not running is fine (not every event uses it).' }
    ]
  },
  {
    id: 'ndi', title: 'NDI', toggle: 'ndi.enabled',
    fields: [
      { path: 'ndi.expected', label: 'Sources that must be present', type: 'list', item: 'source', help: 'Part of the name is enough: "Camera 1" matches "CAM-PC (Camera 1)".' }
    ]
  },
  {
    id: 'notify', title: 'Phone alerts',
    fields: [
      { path: 'notify.onlyWhenOnAir', label: 'Only send while on air', type: 'bool' },
      { path: 'notify.persistSec', label: 'Wait before sending (seconds)', type: 'number', min: 0, max: 300, help: 'An issue must last this long first, so a blip does not buzz your phone.' },
      { path: 'notify.repeatAfterMin', label: 'Remind every (minutes)', type: 'number', min: 0, max: 120, help: '0 = send once.' },
      { path: 'notify.recovery', label: 'Send "All clear" when fixed', type: 'bool' },

      { type: 'heading', label: 'Pushcut (iPhone)' },
      { path: 'notify.pushcut.enabled', label: 'Send to Pushcut', type: 'bool' },
      { path: 'notify.pushcut.url', label: 'Pushcut webhook URL', type: 'secret-url', optional: true, help: 'Pushcut app → Notifications → yours → Webhook → copy.' },
      { path: 'notify.pushcut.minLevel', label: 'Send for', type: 'select', options: LEVEL_OPTIONS },

      { type: 'heading', label: 'Text message (Twilio)' },
      { path: 'notify.twilio.enabled', label: 'Send texts', type: 'bool' },
      { path: 'notify.twilio.accountSid', label: 'Account SID', type: 'text', optional: true, max: 100 },
      { path: 'notify.twilio.authToken', label: 'Auth token', type: 'secret', optional: true },
      { path: 'notify.twilio.from', label: 'From (your Twilio number)', type: 'text', optional: true, max: 40 },
      { path: 'notify.twilio.to', label: 'Send to', type: 'phones', item: 'phone number' },
      { path: 'notify.twilio.minLevel', label: 'Send for', type: 'select', options: LEVEL_OPTIONS },

      { type: 'heading', label: 'Webhook (Slack, Discord, Home Assistant…)' },
      { path: 'notify.webhook.enabled', label: 'Send to a webhook', type: 'bool' },
      { path: 'notify.webhook.url', label: 'Webhook URL', type: 'secret-url', optional: true },
      { path: 'notify.webhook.minLevel', label: 'Send for', type: 'select', options: LEVEL_OPTIONS }
    ]
  }
];

/** Every editable field, flat. Section on/off switches count as bool fields. */
export const FIELDS = SECTIONS.flatMap((s) => [
  ...(s.toggle ? [{ path: s.toggle, label: `${s.title} on/off`, type: 'bool' }] : []),
  ...s.fields.filter((f) => f.path)
]);

export const isSecret = (f) => f.type === 'secret' || f.type === 'secret-url';

export const BUSES = ['master', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

const isUrl = (s) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s);

/**
 * Check one value against its field. Returns { value } or { error }.
 * Strings are trimmed; numbers may arrive as strings from a form.
 */
export function checkField(f, raw) {
  const str = (v) => (v == null ? '' : String(v).trim());
  switch (f.type) {
    case 'bool':
      if (typeof raw !== 'boolean') return { error: 'Must be on or off.' };
      return { value: raw };
    case 'text': {
      const v = str(raw);
      if (!v && !f.optional) return { error: 'Required.' };
      if (f.max && v.length > f.max) return { error: `At most ${f.max} characters.` };
      return { value: v };
    }
    case 'host': {
      const v = str(raw);
      if (!v) return { error: 'Required — an IP address like 192.168.1.20, or 127.0.0.1 for this computer.' };
      if (/^[a-z]+:\/\//i.test(v) || /[\s/]/.test(v)) return { error: 'Just the address, like 192.168.1.20 (no http:// or slashes).' };
      if (!/^[A-Za-z0-9.\-:[\]]+$/.test(v)) return { error: 'That does not look like an IP address or computer name.' };
      return { value: v };
    }
    case 'port': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: 'A port number from 1 to 65535.' };
      return { value: n };
    }
    case 'number': {
      if (raw === '' || raw == null) return { error: 'Required.' };
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: 'Must be a number.' };
      if (f.min != null && n < f.min) return { error: `At least ${f.min}.` };
      if (f.max != null && n > f.max) return { error: `At most ${f.max}.` };
      return { value: n };
    }
    case 'select': {
      const ok = f.options.some((o) => (o.value ?? o) === raw);
      return ok ? { value: raw } : { error: 'Pick one of the options.' };
    }
    case 'url': {
      const v = str(raw);
      if (!v) return f.optional ? { value: '' } : { error: 'Required — starts with http:// or https://' };
      if (!isUrl(v)) return { error: 'Must start with http:// or https://' };
      return { value: v.replace(/\/+$/, '') };
    }
    case 'secret':
    case 'secret-url': {
      // null clears; anything else replaces.
      if (raw === null) return { value: '' };
      const v = str(raw);
      if (!v) return f.optional ? { value: '' } : { error: 'Required.' };
      if (f.type === 'secret-url' && !isUrl(v)) return { error: 'Must start with http:// or https://' };
      if (v.length > 2000) return { error: 'Too long.' };
      return { value: v };
    }
    case 'list':
    case 'phones': {
      if (!Array.isArray(raw)) return { error: 'Must be a list.' };
      const items = raw.map(str).filter(Boolean);
      if (items.length > 50) return { error: 'At most 50 entries.' };
      if (f.type === 'phones') {
        const bad = items.find((p) => !/^\+?[0-9][0-9 ()-]{6,}$/.test(p));
        if (bad) return { error: `"${bad}" is not a phone number. Use the international format, e.g. +15551234567.` };
        return { value: items.map((p) => p.replace(/[ ()-]/g, '')) };
      }
      return { value: items };
    }
    case 'checks': {
      if (!Array.isArray(raw)) return { error: 'Must be a list.' };
      const vals = raw.map(Number);
      if (vals.some((v) => !f.options.includes(v))) return { error: 'Unknown option.' };
      if (!vals.length) return { error: 'Tick at least one.' };
      return { value: [...new Set(vals)].sort() };
    }
    case 'audioSources': {
      if (!Array.isArray(raw)) return { error: 'Must be a list.' };
      if (raw.length > 16) return { error: 'At most 16 sources.' };
      const out = [];
      for (const [i, s] of raw.entries()) {
        const n = i + 1;
        const label = str(s?.label);
        if (s?.bus != null) {
          const bus = str(s.bus);
          if (!BUSES.includes(bus)) return { error: `Source ${n}: unknown bus "${bus}".` };
          const src = { label: label || (bus === 'master' ? 'Program (Master)' : `Bus ${bus}`), bus };
          if (s.mutedLevel) {
            if (!['crit', 'warn'].includes(s.mutedLevel)) return { error: `Source ${n}: bad muted level.` };
            src.mutedLevel = s.mutedLevel;
          }
          out.push(src);
        } else {
          const input = str(s?.input);
          if (!input) return { error: `Source ${n}: enter the vMix input's name or number.` };
          out.push({ label: label || input, input });
        }
        if (out[out.length - 1].label.length > 60) return { error: `Source ${n}: label is too long.` };
      }
      return { value: out };
    }
    default:
      return { error: 'Unknown field type.' };
  }
}

/**
 * Validate a flat { path: value } map from the form. Paths not present are
 * left alone; a secret sent as undefined is kept as it is.
 * Returns { values, errors } — values holds only the paths that passed.
 */
export function validate(input) {
  const values = {}, errors = {};
  if (!input || typeof input !== 'object') return { values, errors: { _: 'Nothing to save.' } };
  for (const f of FIELDS) {
    if (!(f.path in input) || input[f.path] === undefined) continue;
    const r = checkField(f, input[f.path]);
    if ('error' in r) errors[f.path] = r.error;
    else values[f.path] = r.value;
  }
  for (const k of Object.keys(input)) if (!FIELDS.some((f) => f.path === k)) errors[k] = 'Not a setting this page can change.';
  return { values, errors };
}
