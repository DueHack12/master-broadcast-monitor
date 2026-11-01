/* Broadcast Monitor dashboard — plain JS, no build step. */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONS = { ok: '✔', warn: '!', crit: '✖', stale: '?' };
  const COLORS = { ok: '#22c55e', warn: '#eab308', crit: '#dc2626', stale: '#667085' };

  let snap = null;
  let lastAt = 0;
  let clockOffset = 0;

  /* ---------------- live updates ---------------- */
  function connect() {
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      try { snap = JSON.parse(e.data); } catch { return; }
      lastAt = Date.now();
      clockOffset = snap.time - Date.now();
      render(snap);
    };
  }
  connect();

  setInterval(() => {
    tickClock();
    if (snap && Date.now() - lastAt > 5000) renderStale();
    if (snap) renderIssues(snap.issues);
  }, 1000);

  function now() { return Date.now() + clockOffset; }

  function tickClock() {
    $('#clock').textContent = new Date(now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }

  /* ---------------- render ---------------- */
  function render(s) {
    renderBar(s);
    renderIssues(s.issues);
    renderCards(s.cards);
    renderLog(s.log);
    $('#station').textContent = s.station || 'Broadcast Monitor';
    const ch = s.notify.channels;
    $('#notify-info').textContent = ch.length ? `Phone alerts: ${ch.join(', ')}${s.notify.onlyWhenOnAir ? ' (when on air)' : ''}` : 'Phone alerts: off';
    alarm(s);
  }

  function renderBar(s) {
    const lvl = s.overall.level;
    const bar = $('#bar');
    bar.className = `bar lvl-${lvl}`;
    $('#bar-icon').textContent = ICONS[lvl] || '?';
    $('#headline').textContent = s.overall.headline;
    $('#detail').textContent = s.overall.detail || '';
    const onair = $('#onair');
    onair.classList.toggle('on', !!s.onAir);
    onair.textContent = s.live.youtube ? 'LIVE' : (s.live.vmixStreaming ? 'STREAMING' : 'OFF AIR');
    document.title = `${{ ok: '🟢', warn: '🟡', crit: '🔴' }[lvl] || ''} ${s.overall.headline} — ${s.station || 'Broadcast Monitor'}`;
    setFavicon(lvl);
  }

  function renderStale() {
    const bar = $('#bar');
    if (bar.classList.contains('lvl-stale')) return;
    bar.className = 'bar lvl-stale';
    $('#bar-icon').textContent = ICONS.stale;
    $('#headline').textContent = 'Monitor offline';
    $('#detail').textContent = "Can't reach the monitor server — the status shown below may be out of date. Reconnecting…";
    document.title = '⚪ Monitor offline';
    setFavicon('stale');
  }

  let favLvl = null;
  function setFavicon(lvl) {
    if (favLvl === lvl) return;
    favLvl = lvl;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='${COLORS[lvl] || COLORS.stale}'/></svg>`;
    $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function renderIssues(issues) {
    const el = $('#issues');
    const list = issues || [];
    el.hidden = list.length === 0;
    setHTML(el, list.map((i) => `<span class="chip lvl-${i.level}" title="${esc(i.detail)}"><span class="dot lvl-${i.level}"></span>${esc(i.title)}<span class="age">${ago(now() - i.since)}</span></span>`).join(''));
  }

  function setHTML(el, html) {
    if (el._html === html) return;
    el.innerHTML = html;
    el._html = html;
  }

  /* ---------------- cards ---------------- */
  const cardEls = new Map();

  function renderCards(cards) {
    const main = $('#cards');
    const ids = new Set();
    for (const c of cards) {
      ids.add(c.id);
      let el = cardEls.get(c.id);
      if (!el) {
        el = document.createElement('section');
        el.innerHTML = `<header class="card-head"><span class="dot"></span><h2></h2><span class="status"></span></header>
          <div class="body"></div><div class="meters"></div><div class="controls"></div><div class="actions"></div>`;
        el.dataset.id = c.id;
        cardEls.set(c.id, el);
      }
      if (main.children[[...ids].length - 1] !== el) main.insertBefore(el, main.children[[...ids].length - 1] || null);
      updateCard(el, c);
    }
    for (const [id, el] of cardEls) if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
  }

  function updateCard(el, c) {
    const lvl = c.level || 'idle';
    el.className = `card lvl-${lvl}${c.wide ? ' wide' : ''}`;
    $('.dot', el).className = `dot lvl-${lvl}`;
    $('h2', el).textContent = c.title;
    const st = $('.status', el);
    st.textContent = c.status || '';
    st.className = `status lvl-${lvl}`;

    let body = '';
    if (c.notice) {
      body += `<div class="notice">${esc(c.notice.text)}${c.notice.code ? `<span class="code">${esc(c.notice.code)}</span>` : ''}${c.notice.link ? `<a href="${esc(c.notice.link)}" target="_blank" rel="noopener">${esc(c.notice.link)}</a>` : ''}</div>`;
    }
    if (c.rows?.length) {
      body += `<dl class="rows">${c.rows.map((r) => `<dt>${esc(r.label)}</dt><dd class="${r.level ? `lvl-${r.level}` : ''}">${esc(r.value)}</dd>`).join('')}</dl>`;
    }
    if (c.list) {
      const items = c.list.items || [];
      body += `<div class="list">${c.list.title ? `<h3>${esc(c.list.title)}</h3>` : ''}${items.length
        ? `<ul>${items.map((i) => `<li><span class="dot lvl-${i.level || 'idle'}"></span><span class="name">${esc(i.name)}</span><span class="sub">${esc(i.detail || '')}</span></li>`).join('')}</ul>`
        : `<div class="muted small">${esc(c.list.empty || 'Nothing yet.')}</div>`}</div>`;
    }
    setHTML($('.body', el), body);

    renderMeters($('.meters', el), c.meters);

    const controls = $('.controls', el);
    if (!controls.contains(document.activeElement)) {
      setHTML(controls, (c.controls || []).map((k) => k.type === 'select'
        ? `<label>${esc(k.label)}<select data-post="${esc(k.post)}" data-name="${esc(k.name)}">${k.options.map((o) => `<option value="${esc(o.value)}"${o.value === k.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`
        : '').join(''));
    }

    setHTML($('.actions', el), (c.actions || []).map((a) => a.href
      ? `<a class="btn ${esc(a.style || '')}" href="${esc(a.href)}" target="_blank" rel="noopener">${esc(a.label)} ↗</a>`
      : `<button type="button" class="btn ${esc(a.style || '')}" data-post="${esc(a.post)}" data-body="${esc(JSON.stringify(a.body || {}))}"${a.confirm ? ` data-confirm="${esc(a.confirm)}"` : ''}>${esc(a.label)}</button>`).join(''));
  }

  /* ---------------- audio meters ---------------- */
  const MIN_DB = -60;
  const pct = (db) => (db == null ? 0 : Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100)));
  const SCALE = [-60, -50, -40, -30, -20, -10, -6, -3, 0];

  function renderMeters(host, meters) {
    if (!meters || !meters.length) { if (host._sig) { host.innerHTML = ''; host._sig = null; } return; }
    const sig = meters.map((m) => `${m.label}|${m.lowDb}|${m.clipDb}`).join(';');
    if (host._sig !== sig) {
      host.innerHTML = meters.map((m) => `
        <div class="meter">
          <div class="meter-head"><span class="meter-label">${esc(m.label)}</span><span class="meter-val"></span><span class="meter-flags"></span></div>
          ${['L', 'R'].map((ch) => `<div class="meter-bar" data-ch="${ch}" title="${ch}">
            <div class="meter-mark low" style="left:${pct(m.lowDb)}%"></div>
            <div class="meter-mark clip" style="left:${pct(m.clipDb)}%"></div>
            <div class="meter-cover"></div><div class="meter-hold"></div></div>`).join('')}
          <div class="meter-scale">${SCALE.map((d) => `<span style="left:${pct(d)}%">${d}</span>`).join('')}</div>
          <div class="meter-legend">Blue line: low alert below ${m.lowDb} dB for ${m.lowSec}s · white line: clip at ${m.clipDb} dB</div>
        </div>`).join('');
      host._sig = sig;
    }
    const nodes = host.querySelectorAll('.meter');
    meters.forEach((m, i) => {
      const n = nodes[i];
      n.classList.toggle('is-missing', !m.found);
      const bars = n.querySelectorAll('.meter-bar');
      [m.left, m.right].forEach((db, j) => {
        $('.meter-cover', bars[j]).style.width = `${100 - pct(m.found ? db : null)}%`;
        const hold = $('.meter-hold', bars[j]);
        hold.style.left = `${pct(m.hold)}%`;
        hold.style.display = m.found && m.hold != null && m.hold > MIN_DB ? '' : 'none';
      });
      const peak = Math.max(m.left ?? -100, m.right ?? -100);
      $('.meter-val', n).textContent = m.found ? (peak <= -99 ? '−∞ dB' : `${peak.toFixed(1)} dB`) : '';
      const flags = [];
      if (!m.found) flags.push('<span class="flag missing">NOT FOUND</span>');
      if (m.muted) flags.push('<span class="flag muted">MUTED</span>');
      if (m.clipping) flags.push('<span class="flag clip">CLIPPING</span>');
      else if (m.clip) flags.push('<span class="flag clip">CLIP</span>');
      if (m.low) flags.push(`<span class="flag low">LOW ${m.quietSec}s</span>`);
      else if (m.quietSec >= 2) flags.push(`<span class="flag quiet">quiet ${m.quietSec}s</span>`);
      setHTML($('.meter-flags', n), flags.join(''));
    });
  }

  /* ---------------- log ---------------- */
  function renderLog(items) {
    setHTML($('#log'), (items || []).map((e) => `<li><time>${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span class="dot lvl-${e.level}"></span><span>${esc(e.text)}</span><span class="src">${esc(e.source)}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>');
  }

  /* ---------------- actions ---------------- */
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    return j;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-post]');
    if (!b) return;
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    b.disabled = true;
    try { await post(b.dataset.post, JSON.parse(b.dataset.body || '{}')); } catch (err) { toast(err.message); } finally { b.disabled = false; }
  });

  document.addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-post]');
    if (!s) return;
    try { await post(s.dataset.post, { [s.dataset.name]: s.value }); toast('Saved'); } catch (err) { toast(err.message); }
    s.blur();
  });

  $('#btn-test').addEventListener('click', async () => {
    try {
      const r = await post('/api/notify/test');
      toast(r.message || r.results.map((x) => `${x.channel}: ${x.ok ? 'sent' : x.error}`).join(' · '));
    } catch (err) { toast(err.message); }
  });

  /* ---------------- sound alarm ---------------- */
  // Browsers only allow sound after a click, so sound starts off and the
  // choice is remembered; after a reload any click re-arms it.
  let ctx = null;
  let soundOn = false;
  try { soundOn = localStorage.getItem('bm.sound') === '1'; } catch { /* private mode */ }
  let silenced = new Set();
  let lastBeep = 0;
  let knownWarn = new Set();

  function ensureCtx() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, start, dur, vol = 0.25) {
    const c = ensureCtx();
    if (!c) return;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.01);
    g.gain.setValueAtTime(vol, c.currentTime + start + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.02);
  }

  function updateSoundBtn() {
    const b = $('#btn-sound');
    b.setAttribute('aria-pressed', String(soundOn));
    const armed = ctx && ctx.state === 'running';
    b.textContent = soundOn ? (armed ? '🔔 Sound on' : '🔔 Click to arm sound') : '🔇 Sound off';
  }

  $('#btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('bm.sound', soundOn ? '1' : '0'); } catch { /* */ }
    if (soundOn) { ensureCtx(); tone(880, 0, 0.12, 0.15); }
    updateSoundBtn();
  });
  document.addEventListener('pointerdown', () => { if (soundOn) { ensureCtx(); setTimeout(updateSoundBtn, 50); } }, { once: false });
  updateSoundBtn();

  $('#btn-silence').addEventListener('click', () => {
    silenced = new Set((snap?.issues || []).filter((i) => i.level === 'crit').map((i) => i.id));
    alarm(snap);
  });

  function alarm(s) {
    const crit = s.issues.filter((i) => i.level === 'crit');
    const warn = s.issues.filter((i) => i.level === 'warn');
    // Silence lasts until a new critical issue appears.
    for (const id of [...silenced]) if (!crit.some((i) => i.id === id)) silenced.delete(id);
    const loud = crit.filter((i) => !silenced.has(i.id));
    const btn = $('#btn-silence');
    btn.hidden = !(soundOn && crit.length);
    btn.className = `btn ${loud.length ? 'alarm' : 'subtle'}`;
    btn.textContent = loud.length ? 'Silence alarm' : 'Alarm silenced';

    if (!soundOn || !ctx || ctx.state !== 'running') { knownWarn = new Set(warn.map((i) => i.id)); return; }
    const t = Date.now();
    if (loud.length && t - lastBeep > 2500) {
      lastBeep = t;
      tone(988, 0, 0.18); tone(740, 0.22, 0.18); tone(988, 0.44, 0.18); tone(740, 0.66, 0.18);
    }
    const fresh = warn.filter((i) => !knownWarn.has(i.id));
    if (fresh.length && !loud.length) tone(660, 0, 0.15, 0.15);
    knownWarn = new Set(warn.map((i) => i.id));
  }
})();
