/* Settings page — drawn from settings-schema.js, the same list the server validates against. */
import { SECTIONS, FIELDS, isSecret, BUSES } from './settings-schema.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.path, f]));

let loaded = null;     // what the server has
let state = {};        // what the form shows (non-secret fields)
let secretEdits = {};  // path → new string, or null to remove
let errors = {};

/* ---------------- load & render ---------------- */
async function load() {
  const res = await fetch('/api/config');
  loaded = await res.json();
  state = structuredClone(loaded.values);
  secretEdits = {};
  errors = {};
  $('#file').textContent = loaded.file;
  $('#welcome').hidden = !loaded.firstRun;
  const ce = $('#config-error');
  ce.hidden = !loaded.configError;
  ce.textContent = loaded.configError ? `config.json has a typo and could not be read: ${loaded.configError}. Fix it in a text editor (or delete it to start over) before saving here.` : '';
  $('#dl-vmix').innerHTML = loaded.hints.vmixInputs.map((t) => `<option value="${esc(t)}">`).join('');
  $('#dl-ndi').innerHTML = loaded.hints.ndiSources.map((t) => `<option value="${esc(t)}">`).join('');
  render();
  refreshDirty();
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function render() {
  $('#toc').innerHTML = SECTIONS.map((s) => `<a href="#${s.id}">${esc(s.title.replace(/ \(.*\)$/, ''))}</a>`).join('');
  $('#form').innerHTML = SECTIONS.map(sectionHtml).join('');
  for (const s of SECTIONS) if (s.toggle) dimSection(s);
}

function sectionHtml(s) {
  const basic = s.fields.filter((f) => !f.advanced);
  const adv = s.fields.filter((f) => f.advanced);
  return `<section class="card setting-card" id="${s.id}">
    <header class="card-head">
      <h2>${esc(s.title)}</h2>
      ${s.toggle ? `<label class="switch"><input type="checkbox" data-path="${s.toggle}"${state[s.toggle] ? ' checked' : ''}><span class="track" aria-hidden="true"></span><span class="switch-label">${state[s.toggle] ? 'On' : 'Off'}</span></label>` : ''}
    </header>
    <div class="fields">
      ${basic.map(fieldHtml).join('')}
      ${adv.length ? `<details class="more"><summary>More options</summary>${adv.map(fieldHtml).join('')}</details>` : ''}
      ${s.guide ? `<p class="muted small">Need the Google client? <a href="${esc(s.guide)}" target="_blank" rel="noopener">Step-by-step setup guide ↗</a></p>` : ''}
      ${s.id === 'notify' ? '<div class="field"><button type="button" id="test-alert" class="btn">Send a test alert</button><small class="help">Uses the saved settings, so save first.</small></div>' : ''}
    </div>
  </section>`;
}

const help = (f) => (f.help ? `<small class="help">${esc(f.help)}</small>` : '');
const err = (p) => `<small class="err" data-err="${p}">${esc(errors[p] || '')}</small>`;

function fieldHtml(f) {
  if (f.type === 'heading') return `<h3 class="sub-heading">${esc(f.label)}</h3>`;
  const p = f.path, v = state[p];
  const id = `f-${p.replace(/\./g, '-')}`;
  switch (f.type) {
    case 'bool':
      return `<div class="field check"><label><input type="checkbox" id="${id}" data-path="${p}"${v ? ' checked' : ''}> ${esc(f.label)}</label>${help(f)}${err(p)}</div>`;
    case 'select':
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-path="${p}">${f.options.map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help(f)}${err(p)}</div>`;
    case 'ifaces': {
      const chosen = Array.isArray(v) ? v : [];
      const known = loaded.hints.interfaces || [];
      const all = [...known, ...chosen.filter((ip) => !known.some((k) => k.address === ip)).map((ip) => ({ name: 'not connected now', address: ip }))];
      return `<div class="field"><span class="lbl">${esc(f.label)}</span><div class="checks ifaces">${all.map((i) => `<label><input type="checkbox" data-path="${p}" data-ip="${esc(i.address)}"${chosen.includes(i.address) ? ' checked' : ''}> ${esc(i.address)} <span class="muted small">${esc(i.name)}</span></label>`).join('') || '<span class="muted small">No network cards found.</span>'}</div>${help(f)}${err(p)}</div>`;
    }
    case 'checks':
      return `<div class="field"><span class="lbl">${esc(f.label)}</span><div class="checks">${f.options.map((o) => `<label><input type="checkbox" data-path="${p}" data-value="${o}"${(v || []).includes(o) ? ' checked' : ''}> ${o}</label>`).join('')}</div>${help(f)}${err(p)}</div>`;
    case 'secret':
    case 'secret-url': {
      const set = loaded.secretsSet[p];
      const edit = secretEdits[p];
      const status = edit === null ? 'Will be removed when you save' : edit ? 'Will be replaced when you save' : set ? 'Saved ✓ (hidden)' : 'Not set';
      return `<div class="field"><label for="${id}">${esc(f.label)}</label>
        <div class="row"><input id="${id}" type="password" data-secret="${p}" value="${esc(edit || '')}" placeholder="${set ? 'Saved — type to replace' : 'Not set'}" autocomplete="new-password" spellcheck="false">
        ${set && edit !== null ? `<button type="button" class="btn subtle" data-clear="${p}">Remove</button>` : ''}</div>
        <small class="help">${esc(status)}${f.help ? ` · ${esc(f.help)}` : ''}</small>${err(p)}</div>`;
    }
    case 'list':
    case 'phones': {
      const items = Array.isArray(v) ? v : [];
      const dl = p === 'ndi.expected' ? ' list="dl-ndi"' : '';
      return `<div class="field" data-listfield="${p}"><span class="lbl">${esc(f.label)}</span>
        ${items.map((it, i) => `<div class="row"><input data-list="${p}" data-index="${i}" value="${esc(it)}"${dl} spellcheck="false" placeholder="${f.type === 'phones' ? '+15551234567' : ''}"><button type="button" class="btn subtle" data-remove="${p}" data-index="${i}" aria-label="Remove">✕</button></div>`).join('')}
        <div><button type="button" class="btn subtle" data-add="${p}">+ Add ${esc(f.item || 'item')}</button>
        ${p === 'ndi.expected' && loaded.hints.ndiSources.length ? `<small class="help">On the network now: ${esc(loaded.hints.ndiSources.join(', '))}</small>` : ''}</div>
        ${help(f)}${err(p)}</div>`;
    }
    case 'audioSources': {
      const items = Array.isArray(v) ? v : [];
      return `<div class="field" data-audiofield="${p}"><span class="lbl">${esc(f.label)}</span>
        ${items.map((s, i) => audioRow(s, i)).join('') || '<p class="muted small">No sources — audio won\'t be checked.</p>'}
        <div class="row"><button type="button" class="btn subtle" data-add-audio="bus">+ Add a bus</button><button type="button" class="btn subtle" data-add-audio="input">+ Add a vMix input</button></div>
        <small class="help">Master is what goes to the stream. Add an input (e.g. a commentary mic) to watch it on its own.${loaded.hints.vmixInputs.length ? '' : ' Input names are suggested once vMix is connected.'}</small>${err(p)}</div>`;
    }
    default: {
      const type = f.type === 'number' || f.type === 'port' ? 'number' : 'text';
      const ph = p === 'publicUrl' ? loaded.hints.publicUrl : '';
      const extra = type === 'number' ? ` inputmode="decimal"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''} step="${f.step ?? 1}"` : ' spellcheck="false"';
      const fill = p === 'publicUrl' && ph && !v ? `<button type="button" class="btn subtle" data-fill="${p}" data-value="${esc(ph)}">Use ${esc(ph)}</button>` : '';
      return `<div class="field"><label for="${id}">${esc(f.label)}</label><div class="row"><input id="${id}" type="${type}" data-path="${p}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"${extra}>${fill}</div>${help(f)}${err(p)}</div>`;
    }
  }
}

function audioRow(s, i) {
  const isBus = s.bus != null;
  return `<div class="audio-row" data-audio-index="${i}">
    <input data-audio="label" value="${esc(s.label || '')}" placeholder="Label, e.g. Program" aria-label="Label">
    ${isBus
      ? `<select data-audio="bus" aria-label="Bus">${BUSES.map((b) => `<option value="${b}"${b === s.bus ? ' selected' : ''}>${b === 'master' ? 'Master' : `Bus ${b}`}</option>`).join('')}</select>
         <select data-audio="mutedLevel" aria-label="If muted"><option value="crit"${s.mutedLevel === 'crit' ? ' selected' : ''}>Muted = red</option><option value="warn"${s.mutedLevel !== 'crit' ? ' selected' : ''}>Muted = yellow</option></select>`
      : `<input data-audio="input" value="${esc(s.input || '')}" list="dl-vmix" placeholder="vMix input name or number" aria-label="vMix input">`}
    <button type="button" class="btn subtle" data-remove-audio="${i}" aria-label="Remove">✕</button>
  </div>`;
}

function dimSection(s) {
  const sec = document.getElementById(s.id);
  sec.classList.toggle('off', !state[s.toggle]);
  const lab = $('.switch-label', sec);
  if (lab) lab.textContent = state[s.toggle] ? 'On' : 'Off';
}

function rerenderField(path) {
  const f = FIELD[path];
  const host = $(`[data-listfield="${path}"], [data-audiofield="${path}"]`);
  if (!host) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = fieldHtml(f);
  host.replaceWith(tmp.firstElementChild);
}

/* ---------------- dirty tracking ---------------- */
function norm(f, v) {
  if (f.type === 'number' || f.type === 'port') return v === '' || v == null ? '' : Number(v);
  if (f.type === 'list' || f.type === 'phones') return (v || []).map((x) => String(x).trim()).filter(Boolean);
  return v;
}

function changes() {
  const out = {};
  for (const f of FIELDS) {
    if (isSecret(f)) { if (f.path in secretEdits) out[f.path] = secretEdits[f.path]; continue; }
    const a = JSON.stringify(norm(f, state[f.path])), b = JSON.stringify(norm(f, loaded.values[f.path]));
    if (a !== b) out[f.path] = f.type === 'list' || f.type === 'phones' ? norm(f, state[f.path]) : state[f.path];
  }
  return out;
}

function refreshDirty() {
  const n = Object.keys(changes()).length;
  $('#dirty').textContent = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'No changes';
  $('#dirty').classList.toggle('pending', n > 0);
  $('#save').disabled = n === 0;
  $('#revert').disabled = n === 0;
  const t = $('#test-alert');
  if (t) { t.disabled = n > 0; t.title = n ? 'Save first' : ''; }
}

function showErrors() {
  for (const el of $$('[data-err]')) el.textContent = errors[el.dataset.err] || '';
  for (const el of $$('.field')) el.classList.toggle('has-error', !!$('.err', el)?.textContent);
}

/* ---------------- events ---------------- */
const form = $('#form');

form.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.secret) { secretEdits[t.dataset.secret] = t.value; if (!t.value) delete secretEdits[t.dataset.secret]; }
  else if (t.dataset.list) { const p = t.dataset.list; state[p] = [...(state[p] || [])]; state[p][+t.dataset.index] = t.value; }
  else if (t.dataset.audio) {
    const i = +t.closest('[data-audio-index]').dataset.audioIndex;
    state['audio.sources'] = state['audio.sources'].map((s, j) => (j === i ? { ...s, [t.dataset.audio]: t.value } : s));
  } else if (t.dataset.path && t.type !== 'checkbox' && t.tagName !== 'SELECT') state[t.dataset.path] = t.value;
  delete errors[t.dataset.path || t.dataset.secret || t.dataset.list];
  refreshDirty();
});

form.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.audio) {
    const i = +t.closest('[data-audio-index]').dataset.audioIndex;
    state['audio.sources'] = state['audio.sources'].map((s, j) => (j === i ? { ...s, [t.dataset.audio]: t.value } : s));
  } else if (t.dataset.path && t.type === 'checkbox' && t.dataset.ip) {
    const p = t.dataset.path;
    state[p] = $$(`input[data-path="${p}"][data-ip]`).filter((x) => x.checked).map((x) => x.dataset.ip);
  } else if (t.dataset.path && t.type === 'checkbox' && t.dataset.value) {
    const p = t.dataset.path;
    state[p] = $$(`input[data-path="${p}"][data-value]`).filter((x) => x.checked).map((x) => Number(x.dataset.value));
  } else if (t.dataset.path && t.type === 'checkbox') {
    state[t.dataset.path] = t.checked;
    const s = SECTIONS.find((x) => x.toggle === t.dataset.path);
    if (s) dimSection(s);
  } else if (t.dataset.path && t.tagName === 'SELECT') state[t.dataset.path] = t.value;
  refreshDirty();
});

form.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.add) {
    const p = b.dataset.add;
    state[p] = [...(state[p] || []), ''];
    rerenderField(p);
    $$(`[data-list="${p}"]`).pop()?.focus();
  } else if (b.dataset.remove) {
    const p = b.dataset.remove;
    state[p] = state[p].filter((_, i) => i !== +b.dataset.index);
    rerenderField(p);
  } else if (b.dataset.addAudio) {
    const src = b.dataset.addAudio === 'bus' ? { label: '', bus: 'A', mutedLevel: 'warn' } : { label: '', input: '' };
    state['audio.sources'] = [...(state['audio.sources'] || []), src];
    rerenderField('audio.sources');
    $$('.audio-row input[data-audio="label"]').pop()?.focus();
  } else if (b.dataset.removeAudio != null) {
    state['audio.sources'] = state['audio.sources'].filter((_, i) => i !== +b.dataset.removeAudio);
    rerenderField('audio.sources');
  } else if (b.dataset.clear) {
    secretEdits[b.dataset.clear] = null;
    const f = FIELD[b.dataset.clear];
    const field = b.closest('.field');
    const tmp = document.createElement('div');
    tmp.innerHTML = fieldHtml(f);
    field.replaceWith(tmp.firstElementChild);
  } else if (b.dataset.fill) {
    state[b.dataset.fill] = b.dataset.value;
    const input = $(`input[data-path="${b.dataset.fill}"]`);
    input.value = b.dataset.value;
    b.remove();
  } else if (b.id === 'test-alert') {
    b.disabled = true;
    try {
      const r = await post('/api/notify/test', {});
      toast(r.message || r.results.map((x) => `${x.channel}: ${x.ok ? 'sent ✓' : x.error}`).join(' · '));
    } catch (er) { toast(er.message); } finally { b.disabled = false; }
    return;
  } else return;
  refreshDirty();
});

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(j.error || `HTTP ${res.status}`); e.errors = j.errors; throw e; }
  return j;
}

$('#save').addEventListener('click', async () => {
  const values = changes();
  if (!Object.keys(values).length) return;
  $('#save').disabled = true;
  try {
    await post('/api/config', { values });
    await load();
    toast('Saved — applied');
  } catch (e) {
    errors = e.errors || {};
    showErrors();
    const first = $('.field.has-error');
    if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast(e.errors ? 'Some settings need fixing — see the red notes.' : e.message);
    refreshDirty();
  }
});

$('#revert').addEventListener('click', () => {
  state = structuredClone(loaded.values);
  secretEdits = {};
  errors = {};
  render();
  refreshDirty();
});

window.addEventListener('beforeunload', (e) => {
  if (Object.keys(changes()).length) { e.preventDefault(); e.returnValue = ''; }
});

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4500);
}

/* ---------------- slim live status, so an alarm is never missed while editing ---------------- */
let lastAt = 0;
const es = new EventSource('/events');
es.onmessage = (e) => {
  let s;
  try { s = JSON.parse(e.data); } catch { return; }
  lastAt = Date.now();
  $('#mini').className = `mini lvl-${s.overall.level}`;
  const alerting = s.issues.filter((i) => i.level !== 'info');
  $('#mini-text').textContent = `${s.overall.headline}${alerting.length > 1 ? `  (+${alerting.length - 1} more)` : ''}`;
};
setInterval(() => {
  if (Date.now() - lastAt > 5000) { $('#mini').className = 'mini lvl-stale'; $('#mini-text').textContent = 'Monitor offline — reconnecting…'; }
}, 1000);

load().catch((e) => toast(`Could not load settings: ${e.message}`));
