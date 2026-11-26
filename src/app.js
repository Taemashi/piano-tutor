(function () {
  const $ = (id) => document.getElementById(id);
  const NAMES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
  const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
  const noteName = (p) => NAMES_ES[p % 12] + (Math.floor(p / 12) - 1);

  const S = {
    song: null, notes: [], hands: 'both', mode: 'wait', speed: 1,
    splitMode: 'auto', splitPoint: 60, edit: false, sel: new Set(), hist: [], overrides: {}, songId: '', handInfo: null,
    loopA: 1, loopB: 1, measures: 0,
    steps: [], idx: 0, status: 'idle', noteEls: new Map(), measureEl: [], rowH: 250,
    stats: { ok: 0, bad: 0, errs: 0, total: 0 },
    stepByBeat: new Map(), thruOn: new Set(), keyEls: {}, kbLo: 36, kbHi: 96, held: new Set(), passes: 0,
    ctx: null, master: null, raf: 0, t0: 0, spb: 0.5, endTime: 0, timeOf: null, tol: 0.2, lastCur: null
  };

  // ───────────────────────── Audio ─────────────────────────
  const VOL_BOOST = 4; // el 100% del control equivale a ganancia x4 (con limitador)
  function audio() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ctx.state === 'suspended') S.ctx.resume();
    if (!S.bus) {
      S.bus = S.ctx.createGain();
      S.bus.gain.value = Sound.volume * VOL_BOOST;
      // Compresor/limitador: permite subir mucho el volumen sin que se distorsione.
      const comp = S.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 8;
      comp.attack.value = 0.003; comp.release.value = 0.2;
      S.bus.connect(comp); comp.connect(S.ctx.destination);
    }
    return S.ctx;
  }

  // ───────────────────────── SoundFont ─────────────────────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pt.' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pt.' + k, v); } catch (e) {} }
  };
  const Sound = { synth: null, enabled: false, name: '', volume: +store.get('vol', 85) / 100, presets: [], preset: null };

  async function initSynth() {
    if (Sound.synth) return Sound.synth;
    const ctx = audio();
    await ctx.audioWorklet.addModule('vendor/spessasynth_processor.min.js');
    const synth = new SpessaLib.WorkletSynthesizer(ctx);
    synth.connect(S.bus);
    synth.eventHandler.addEvent('presetListChange', 'ui', (d) => { if (Sound.enabled || Sound.loading) setPresets(Array.isArray(d) ? d : synth.presetList); });
    Sound.synth = synth;
    return synth;
  }
  function applyProgram() {
    const syn = Sound.synth, p = Sound.preset;
    if (!syn || !p) return;
    for (const ch of [0, 1]) {
      syn.controllerChange(ch, 0, p.msb);
      syn.controllerChange(ch, 32, p.lsb);
      syn.programChange(ch, p.program);
    }
  }
  const presetKey = () => 'preset:' + Sound.name;
  function setPresets(list) {
    const seen = new Set();
    Sound.presets = (list || [])
      .filter((p) => !p.isDrum)
      .map((p) => ({ key: p.bankMSB + ':' + p.bankLSB + ':' + p.program, name: p.name, msb: p.bankMSB, lsb: p.bankLSB, program: p.program }))
      .filter((p) => !seen.has(p.key) && seen.add(p.key))
      .sort((a, b) => a.msb - b.msb || a.lsb - b.lsb || a.program - b.program);
    const saved = store.get(presetKey(), '');
    Sound.preset = Sound.presets.find((p) => p.key === saved) || Sound.presets.find((p) => p.msb === 0 && p.lsb === 0) || Sound.presets[0] || null;
    applyProgram(); renderPresets();
  }
  function renderPresets() {
    const box = $('presetBox');
    box.hidden = !Sound.enabled || !Sound.presets.length;
    $('presetHelp').textContent = Sound.enabled
      ? (Sound.presets.length ? 'Haz clic en un sonido para usarlo.' : 'Este SoundFont no trae sonidos melódicos.')
      : 'Carga un SoundFont para ver y elegir sus sonidos.';
    if (box.hidden) return;
    const q = $('presetFilter').value.trim().toLowerCase();
    const multiBank = new Set(Sound.presets.map((p) => p.msb + ':' + p.lsb)).size > 1;
    const shown = Sound.presets.filter((p) => !q || p.name.toLowerCase().includes(q));
    $('presetCount').textContent = '(' + shown.length + (q ? ' de ' + Sound.presets.length : '') + ')';
    const sel = $('preset'); sel.innerHTML = '';
    for (const p of shown) {
      const o = document.createElement('option');
      o.value = p.key;
      o.textContent = (multiBank ? p.msb + '.' + p.lsb + '  ' : '') + String(p.program).padStart(3, '0') + '  ' + p.name;
      if (Sound.preset && p.key === Sound.preset.key) o.selected = true;
      sel.appendChild(o);
    }
    const cur = sel.querySelector('option:checked'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  // Suena una nota corta para oír el sonido recién elegido.
  function preview() {
    if (!Sound.enabled) return;
    const t = audio().currentTime;
    for (const [i, n] of [60, 64, 67].entries()) playNote(n, t + i * 0.13, 0.5, 90);
  }
  function syncSoundUi() {
    $('sfState').textContent = Sound.enabled ? 'SoundFont' : 'Básico';
    $('sfName').textContent = Sound.enabled ? 'Archivo: ' + Sound.name : '';
    const rm = $('sfRemove'); if (rm) rm.disabled = !Sound.enabled;
    renderPresets();
  }
  async function useSoundfont(bytes, name) {
    setFeedback('Cargando SoundFont…');
    try {
      const synth = await initSynth();
      synth.stopAll(true);
      Sound.loading = true; Sound.name = name;
      await synth.soundBankManager.addSoundBank(bytes, 'main');
      await synth.isReady;
      Sound.loading = false; Sound.enabled = true;
      setPresets(synth.presetList); syncSoundUi();
      setFeedback('SoundFont cargado: ' + name, 'good');
    } catch (err) {
      Sound.loading = false; Sound.enabled = false; syncSoundUi();
      setFeedback('No pude cargar ese SoundFont: ' + (err && err.message ? err.message : err), 'bad');
    }
  }
  function toBuffer(u8) { return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength); }

  // Reproduce una nota (SoundFont si hay uno cargado, si no el sintetizador básico).
  function playNote(midi, when, dur, vel, dest) {
    if (Sound.enabled) {
      Sound.synth.noteOn(0, midi, vel || 90, { time: when });
      Sound.synth.noteOff(0, midi, { time: when + Math.max(dur, 0.08) });
    } else tone(dest || S.bus, midi, when, dur, vel);
  }
  function tone(dest, midi, when, dur, vel) {
    const ctx = audio();
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    const peak = 0.04 + 0.15 * ((vel || 90) / 127);
    const hold = Math.max(dur, 0.15);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.008);
    g.gain.exponentialRampToValueAtTime(peak * 0.35, when + 0.25);
    g.gain.setValueAtTime(peak * 0.3, when + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.35);
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(dest);
    o1.start(when); o2.start(when);
    o1.stop(when + hold + 0.4); o2.stop(when + hold + 0.4);
  }
  function click(dest, when, accent) {
    const ctx = audio();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.25, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    o.connect(g); g.connect(dest);
    o.start(when); o.stop(when + 0.08);
  }

  // ───────────────────────── Manos / canción ─────────────────────────
  const noteKey = (n) => n.q + '|' + n.pitch;
  function makeSongId() {
    let h = 0;
    for (const n of S.notes) h = (h * 31 + n.pitch * 7 + Math.round(n.q * 4)) | 0;
    return (S.song.title || '') + '|' + S.notes.length + '|' + h;
  }
  function loadOverrides() {
    try { S.overrides = JSON.parse(localStorage.getItem('pt.hands:' + S.songId) || '{}'); } catch (e) { S.overrides = {}; }
  }
  function saveOverrides() {
    try { localStorage.setItem('pt.hands:' + S.songId, JSON.stringify(S.overrides)); } catch (e) {}
  }
  function applyOverrides() { for (const n of S.notes) n.hand = S.overrides[noteKey(n)] || n.auto; }
  function showSplitInfo() {
    const r = S.handInfo, el = $('splitInfo'); if (!r) { el.className = 'info'; el.textContent = ''; return; }
    el.className = 'info ' + r.level;
    el.innerHTML = '<b>' + escapeHtml(r.title) + '</b>' + escapeHtml(r.detail);
  }
  function assignHands() {
    S.handInfo = Hands.detect(S.song, S.notes, S.song.beatsPerMeasure, S.measures, S.splitMode, S.splitPoint);
    applyOverrides(); showSplitInfo(); updateEditInfo();
  }

  function loadSong(song, label) {
    stopAll();
    S.song = song;
    const q = new Map();
    S.notes = [];
    for (const n of song.notes) {
      const qs = Math.round(n.start * 4) / 4;
      const key = qs + '|' + n.pitch;
      const qd = Math.max(0.25, Math.round(n.dur * 4) / 4);
      if (q.has(key)) { q.get(key).qd = Math.max(q.get(key).qd, qd); continue; }
      const nn = { pitch: n.pitch, q: qs, qd, vel: n.vel, track: n.track, hand: 'R' };
      q.set(key, nn);
      S.notes.push(nn);
    }
    const last = S.notes.reduce((m, n) => Math.max(m, n.q + n.qd), 0);
    S.measures = Math.max(1, Math.ceil(last / song.beatsPerMeasure - 1e-9));
    S.loopA = 1; S.loopB = S.measures;
    $('loopA').max = $('loopB').max = S.measures;
    $('loopA').value = 1; $('loopB').value = S.measures;
    S.splitMode = 'auto';
    $('splitMode').value = 'auto';
    $('splitRow').style.display = 'none';
    S.splitPoint = 60; $('splitPoint').value = 60; updateSplitLabel();
    S.songId = makeSongId(); loadOverrides(); S.hist = []; S.sel.clear();
    if (S.edit) setEdit(false);
    assignHands();

    const info = [];
    info.push('<b>' + escapeHtml(label || song.title || 'Canción') + '</b>');
    info.push(Math.round(song.bpm) + ' bpm · compás ' + song.num + '/' + song.den + ' · ' + S.measures + ' compases');
    info.push(S.notes.length + ' notas · ' + song.tracks.length + ' pista(s)');
    $('songInfo').innerHTML = info.join('<br>');
    $('start').disabled = false; $('reset').disabled = false;
    buildKeyboard();
    renderScore();
    setFeedback('Listo. Elige la mano y el modo, y pulsa Iniciar.');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderScore() {
    if (!S.song) return;
    const r = Notation.render($('score'), S.song, S.notes, S.measures, S.song.sf < 0);
    S.noteEls = r.noteEls; S.measureEl = r.measureEl; S.rowH = r.rowH;
    S.elInfo = new Map();
    for (const [beat, list] of r.noteEls) for (const e of list) S.elInfo.set(e.el, { beat, hand: e.hand });
    applyDim();
  }

  const handActive = (h) => S.hands === 'both' || S.hands === h;
  function applyDim() {
    for (const list of S.noteEls.values()) for (const e of list) e.el.classList.toggle('dim', !S.edit && !handActive(e.hand));
  }

  // ───────────────────────── Teclado en pantalla ─────────────────────────
  function buildKeyboard() {
    const kb = $('kb'); kb.innerHTML = ''; S.keyEls = {};
    let lo = 36, hi = 96;
    if (S.notes.length) {
      const mn = Math.min(...S.notes.map((n) => n.pitch)), mx = Math.max(...S.notes.map((n) => n.pitch));
      lo = Math.min(lo, Math.floor(mn / 12) * 12);
      hi = Math.max(hi, Math.ceil(mx / 12) * 12);
    }
    S.kbLo = lo; S.kbHi = hi;
    let whites = 0;
    for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites++;
    const ww = kb.clientWidth / whites;
    let wi = 0;
    for (let p = lo; p <= hi; p++) {
      const el = document.createElement('div');
      if (!isBlack(p)) {
        el.className = 'key w'; el.style.left = wi * ww + 'px'; el.style.width = ww + 'px';
        if ($('names').checked) el.textContent = (p % 12 === 0) ? noteName(p) : NAMES_ES[p % 12];
        wi++;
      } else {
        const bw = ww * 0.62;
        el.className = 'key b'; el.style.left = wi * ww - bw / 2 + 'px'; el.style.width = bw + 'px';
      }
      el.dataset.p = p;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); noteOn(p, 90); });
      el.addEventListener('mouseup', () => noteOff(p));
      el.addEventListener('mouseleave', () => { if (S.held.has(p)) noteOff(p); });
      kb.appendChild(el); S.keyEls[p] = el;
    }
    refreshKeys();
    fallResize();
  }

  function refreshKeys() {
    for (const el of Object.values(S.keyEls)) el.classList.remove('wantR', 'wantL');
    const cur = currentStep();
    if (cur) {
      for (const [p, h] of cur.hands) {
        const el = S.keyEls[p];
        if (el) el.classList.add(h === 'R' ? 'wantR' : 'wantL');
      }
    }
    updateNow();
  }
  function currentStep() {
    if (S.status === 'wait') return S.steps[S.idx];
    if (S.status === 'rhythm' || S.status === 'listen') return S.steps.find((s) => s.state === 'idle') || null;
    return null;
  }

  // ───────────────────────── Panel "toca ahora" ─────────────────────────
  let lastNow = '';
  function updateNow() {
    const el = $('now'); if (!el) return;
    const legend = '<span id="legend"><i style="background:#2563eb"></i>mano derecha (melodía)<i style="background:#d97706"></i>mano izquierda (bajo)</span>';
    let html;
    if (S.edit) html = '<span class="lbl">✏️ <b>Modo edición</b>: haz clic en una nota para pasarla de mano. Azul = derecha (melodía), naranja = izquierda (bajo).</span>';
    else if (!S.song) html = '<span class="lbl">Abre un archivo MIDI o prueba la canción de ejemplo para empezar.</span>';
    else {
      const cur = S.status === 'idle' ? null : currentStep();
      if (!cur) {
        html = S.status === 'idle'
          ? '<span class="lbl">Pulsa <b>▶ Iniciar</b>. Verás barras de colores bajar hacia el teclado: toca esa tecla cuando la barra llegue abajo.</span>'
          : '<span class="lbl">¡Fin de la canción!</span>';
      } else {
        const chips = [...cur.hands.entries()].sort((a, b) => a[0] - b[0])
          .map(([p, h]) => '<span class="chip ' + h + '">' + NAMES_ES[p % 12] + '<small>' + (h === 'R' ? 'derecha' : 'izquierda') + '</small></span>').join('');
        html = '<span class="lbl">' + (S.status === 'wait' ? 'Toca ahora:' : 'Siguiente:') + '</span>' + chips;
      }
    }
    html += legend;
    if (html !== lastNow) { el.innerHTML = html; lastNow = html; }
  }

  // ───────────────────────── Teclas que caen ─────────────────────────
  const Fall = { cv: null, g: null, w: 0, h: 0, dpr: 1, view: 0, manual: 0, ppb: 60, hit: [], drag: null };
  function fallResize() {
    const cv = Fall.cv || (Fall.cv = $('fall')); if (!cv) return;
    const wrap = $('fallWrap'), kb = $('kb');
    const w = kb.clientWidth, h = wrap.clientHeight;
    if (!w || !h) { Fall.w = 0; return; }
    Fall.dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * Fall.dpr); cv.height = Math.round(h * Fall.dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    Fall.g = cv.getContext('2d'); Fall.w = w; Fall.h = h;
  }
  function fallTarget() {
    const bm = S.song.beatsPerMeasure, startBeat = (S.loopA - 1) * bm;
    if (S.edit) return Fall.manual;
    if ((S.status === 'rhythm' || S.status === 'listen') && S.ctx) return startBeat + (S.ctx.currentTime - S.t0) / S.spb;
    if (S.status === 'wait') {
      const st = S.steps[S.idx] || S.steps[S.steps.length - 1];
      return st ? st.beat : startBeat;
    }
    return startBeat - 0.4;
  }
  const STATE_FILL = { ok: '#22c55e', bad: '#eab308', miss: '#ef4444' };
  function drawFall() {
    requestAnimationFrame(drawFall);
    const v = document.body.dataset.view;
    if (v === 'score' || !Fall.w || !Fall.g) return;
    const g = Fall.g, W = Fall.w, H = Fall.h;
    g.setTransform(Fall.dpr, 0, 0, Fall.dpr, 0, 0);
    g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
    if (!S.song) {
      g.fillStyle = '#5b6478'; g.font = '16px Segoe UI, sans-serif'; g.textAlign = 'center';
      g.fillText('Aquí caerán las notas de la canción', W / 2, H / 2);
      return;
    }
    const bm = S.song.beatsPerMeasure, ppb = H / (S.edit ? 10 : 6);
    Fall.ppb = ppb; Fall.hit = [];
    const tgt = fallTarget();
    const timed = S.status === 'rhythm' || S.status === 'listen';
    Fall.view = timed ? tgt : Fall.view + (tgt - Fall.view) * 0.2;
    const vb = Fall.view, top = vb + H / ppb;

    // líneas de pulso y de compás
    g.textAlign = 'left'; g.font = '10px Segoe UI, sans-serif';
    for (let b = Math.floor(vb); b <= Math.ceil(top); b++) {
      if (b < 0) continue;
      const y = H - (b - vb) * ppb, strong = b % bm === 0;
      g.strokeStyle = strong ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.07)';
      g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      if (strong) { g.fillStyle = 'rgba(255,255,255,.35)'; g.fillText('compás ' + (b / bm + 1), 4, y - 3); }
    }
    // separadores en cada Do
    g.strokeStyle = 'rgba(255,255,255,.06)';
    for (const [p, el] of Object.entries(S.keyEls)) {
      if (p % 12 === 0) { g.beginPath(); g.moveTo(el.offsetLeft, 0); g.lineTo(el.offsetLeft, H); g.stroke(); }
    }

    const cur = S.status === 'idle' ? null : currentStep();
    for (const n of S.notes) {
      if (n.q + n.qd < vb - 1 || n.q > top + 0.1) continue;
      const el = S.keyEls[n.pitch]; if (!el) continue;
      const x = el.offsetLeft, w = el.offsetWidth;
      const yb = H - (n.q - vb) * ppb, yt = H - (n.q + n.qd - vb) * ppb;
      const h = Math.max(yb - yt - 3, 12), y = yb - 3 - h;
      const active = S.edit || handActive(n.hand);
      Fall.hit.push({ n, x, y, w, h });
      const st = S.status !== 'idle' && active ? S.stepByBeat.get(n.q) : null;
      let fill = n.hand === 'R' ? '#3b82f6' : '#f59e0b';
      if (st && STATE_FILL[st.state]) fill = STATE_FILL[st.state];
      g.globalAlpha = active ? 1 : 0.22; g.fillStyle = fill;
      g.beginPath(); g.roundRect(x + 1, y, w - 2, h, 4); g.fill();
      if (st && st === cur) { g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(); }
      if (S.edit && S.sel.has(n)) { g.lineWidth = 2; g.setLineDash([4, 3]); g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([]); }
      if (w >= 15 && h >= 16 && active) {
        g.fillStyle = '#fff'; g.font = 'bold ' + Math.min(12, w - 6) + 'px Segoe UI, sans-serif'; g.textAlign = 'center';
        g.fillText(NAMES_ES[n.pitch % 12], x + w / 2, Math.min(y + h - 5, H - 8));
      }
      g.globalAlpha = 1;
    }
    if (Fall.drag && Fall.drag.moved) {
      const d = Fall.drag; g.globalAlpha = 1; g.strokeStyle = '#fff'; g.fillStyle = 'rgba(255,255,255,.12)';
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    // zona de "toca aquí"
    const gr = g.createLinearGradient(0, H - 22, 0, H);
    gr.addColorStop(0, 'rgba(59,130,246,0)'); gr.addColorStop(1, 'rgba(59,130,246,.45)');
    g.fillStyle = gr; g.fillRect(0, H - 22, W, 22);
  }

  // ───────────────────────── Corregir manos ─────────────────────────
  let rerenderT = 0;
  function afterEdit() {
    updateEditInfo();
    clearTimeout(rerenderT);
    rerenderT = setTimeout(() => { renderScore(); }, 120);
  }
  function updateEditInfo() {
    const n = Object.keys(S.overrides).length;
    $('editInfo').textContent = (n ? n + ' nota(s) corregida(s) a mano. ' : 'Sin correcciones. ') + (S.sel.size ? S.sel.size + ' seleccionada(s).' : '');
  }
  function setNoteHand(notes, hand) {
    const changes = [];
    for (const n of notes) {
      if (n.hand === hand) continue;
      changes.push({ n, old: n.hand });
      n.hand = hand;
      if (hand === n.auto) delete S.overrides[noteKey(n)]; else S.overrides[noteKey(n)] = hand;
    }
    if (!changes.length) return;
    S.hist.push(changes); if (S.hist.length > 200) S.hist.shift();
    saveOverrides(); afterEdit();
  }
  function undoHands() {
    const ch = S.hist.pop(); if (!ch) return;
    for (const { n, old } of ch) {
      n.hand = old;
      if (old === n.auto) delete S.overrides[noteKey(n)]; else S.overrides[noteKey(n)] = old;
    }
    saveOverrides(); afterEdit();
  }
  function resetHands() {
    S.overrides = {}; S.hist = []; S.sel.clear(); applyOverrides(); saveOverrides(); afterEdit();
  }
  function setEdit(on) {
    if (on && !S.song) return;
    if (on) {
      stopAll(true);
      if (document.body.dataset.view === 'score') setView('both');
      Fall.manual = (S.loopA - 1) * S.song.beatsPerMeasure - 0.4;
    } else S.sel.clear();
    S.edit = on;
    document.body.classList.toggle('editing', on);
    $('editTools').hidden = !on;
    $('editToggle').textContent = on ? '✔ Terminar edición' : '✏️ Editar manos';
    applyDim(); updateEditInfo();
    if (on) setFeedback('Modo edición: haz clic en una nota para cambiarla de mano.');
  }
  const other = (h) => (h === 'R' ? 'L' : 'R');

  function initEditor() {
    $('editToggle').addEventListener('click', () => setEdit(!S.edit));
    $('toR').addEventListener('click', () => { setNoteHand([...S.sel], 'R'); });
    $('toL').addEventListener('click', () => { setNoteHand([...S.sel], 'L'); });
    $('undoH').addEventListener('click', undoHands);
    $('resetH').addEventListener('click', resetHands);
    $('gotoM').addEventListener('change', (e) => {
      if (!S.song) return;
      const m = Math.max(1, Math.min(S.measures, +e.target.value || 1));
      Fall.manual = (m - 1) * S.song.beatsPerMeasure - 0.4;
    });
    // Partitura: clic en una figura
    $('score').addEventListener('click', (e) => {
      if (!S.edit || !S.elInfo) return;
      const g = e.target.closest('.vf-stavenote'); if (!g) return;
      const info = S.elInfo.get(g); if (!info) return;
      const notes = S.notes.filter((n) => n.q === info.beat && n.hand === info.hand);
      setNoteHand(notes, other(info.hand));
    });
    // Barras que caen: clic, recuadro y rueda
    const cv = $('fall');
    let drag = null;
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('mousedown', (e) => { if (!S.edit) return; const [x, y] = pos(e); drag = { x0: x, y0: y, x1: x, y1: y, moved: false }; Fall.drag = drag; });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return; const [x, y] = pos(e); drag.x1 = x; drag.y1 = y;
      if (Math.hypot(x - drag.x0, y - drag.y0) > 5) drag.moved = true;
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag; drag = null; Fall.drag = null;
      if (d.moved) {
        const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
        S.sel.clear();
        for (const h of Fall.hit) if (h.x < x1 && h.x + h.w > x0 && h.y < y1 && h.y + h.h > y0) S.sel.add(h.n);
        updateEditInfo();
      } else {
        const hit = [...Fall.hit].reverse().find((h) => d.x0 >= h.x && d.x0 <= h.x + h.w && d.y0 >= h.y && d.y0 <= h.y + h.h);
        if (hit) { setNoteHand([hit.n], other(hit.n.hand)); } else { S.sel.clear(); updateEditInfo(); }
      }
    });
    cv.addEventListener('wheel', (e) => {
      if (!S.edit) return; e.preventDefault();
      const bm = S.song ? S.song.beatsPerMeasure : 4;
      Fall.manual = Math.max(-0.4, Math.min(S.measures * bm, Fall.manual + (e.deltaY / (Fall.ppb || 60)) * 0.8));
      $('gotoM').value = Math.max(1, Math.min(S.measures, Math.floor(Fall.manual / bm) + 1));
    }, { passive: false });
  }

  function setView(v) {
    document.body.dataset.view = v; store.set('view', v);
    document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    requestAnimationFrame(() => { fallResize(); if (v !== 'fall') renderScore(); });
  }

  // ───────────────────────── Pasos de práctica ─────────────────────────
  function buildSteps() {
    const bm = S.song.beatsPerMeasure;
    const m = new Map();
    for (const n of S.notes) {
      if (!handActive(n.hand)) continue;
      const meas = Math.floor(n.q / bm + 1e-9) + 1;
      if (meas < S.loopA || meas > S.loopB) continue;
      let s = m.get(n.q);
      if (!s) { s = { beat: n.q, pitches: new Set(), hands: new Map(), measure: meas, got: new Set(), state: 'idle', err: false, time: 0 }; m.set(n.q, s); }
      s.pitches.add(n.pitch); s.hands.set(n.pitch, n.hand);
    }
    S.steps = [...m.values()].sort((a, b) => a.beat - b.beat);
    S.stepByBeat = new Map(S.steps.map((st) => [st.beat, st]));
    for (const s of S.steps) {
      s.els = (S.noteEls.get(s.beat) || []).filter((e) => handActive(e.hand)).map((e) => e.el);
    }
  }

  const STATE_CLASSES = ['s-cur', 's-ok', 's-bad', 's-miss'];
  function paint(step, cls) {
    for (const el of step.els) { el.classList.remove(...STATE_CLASSES); if (cls) el.classList.add(cls); }
  }
  function clearPaint() {
    for (const list of S.noteEls.values()) for (const e of list) e.el.classList.remove(...STATE_CLASSES);
  }
  function scrollTo(step) {
    if (!step) return;
    const el = step.els[0]; if (!el) return;
    const wrap = $('scoreWrap');
    const r = el.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    if (r.top < w.top + 20 || r.bottom > w.bottom - 20) wrap.scrollTop += r.top - w.top - w.height / 3;
  }

  function setFeedback(msg, cls) {
    const f = $('feedback'); f.textContent = msg; f.className = cls || '';
  }
  function updateStats() {
    const s = S.stats;
    $('stats').textContent = S.status === 'idle' ? '' : 'Aciertos ' + s.ok + '/' + s.total + ' · errores ' + s.errs +
      (S.passes ? ' · vuelta ' + (S.passes + 1) : '');
  }

  // ───────────────────────── Inicio / parada ─────────────────────────
  function start() {
    if (!S.song) return;
    if (S.edit) setEdit(false);
    stopAll();
    audio();
    S.passes = 0;
    beginPass();
  }

  function beginPass() {
    clearPaint(); applyDim();
    buildSteps();
    if (!S.steps.length) { setFeedback('No hay notas de esa mano en esos compases.', 'bad'); S.status = 'idle'; syncButton(); return; }
    S.stats = { ok: 0, bad: 0, errs: 0, total: S.steps.length };
    S.idx = 0;
    S.status = S.mode;
    syncButton();
    if (S.mode === 'wait') {
      paint(S.steps[0], 's-cur'); scrollTo(S.steps[0]);
      setFeedback('Toca las notas azules/naranjas del teclado.');
    } else {
      startTimed();
    }
    refreshKeys(); updateStats();
  }

  function stopAll(keepMsg) {
    cancelAnimationFrame(S.raf);
    clearInterval(S.schedTimer);
    if (Sound.enabled) Sound.synth.stopAll(true);
    if (S.master) {
      try { S.master.gain.cancelScheduledValues(0); S.master.gain.value = 0; S.master.disconnect(); } catch (e) {}
      S.master = null;
    }
    S.status = 'idle';
    $('overlay').hidden = true;
    clearPaint(); refreshKeys(); syncButton(); updateStats();
    if (!keepMsg && S.song) setFeedback('Detenido.');
  }

  function syncButton() {
    const b = $('start');
    const running = S.status !== 'idle';
    b.textContent = running ? '■ Detener' : '▶ Iniciar';
  }

  // ───────────────────────── Modos con reloj (Ritmo / Escuchar) ─────────────────────────
  function startTimed() {
    const ctx = audio();
    const bm = S.song.beatsPerMeasure;
    const spb = 60 / (S.song.bpm * S.speed);
    const startBeat = (S.loopA - 1) * bm, endBeat = S.loopB * bm;
    const countIn = S.mode === 'rhythm' || S.metro ? bm : 0;
    S.spb = spb;
    S.tol = Math.max(0.18, 0.3 * spb);
    S.t0 = ctx.currentTime + 0.2 + countIn * spb;
    S.timeOf = (beat) => S.t0 + (beat - startBeat) * spb;
    S.endTime = S.timeOf(endBeat);
    S.master = ctx.createGain(); S.master.connect(S.bus);

    // Metrónomo y cuenta previa
    const useMetro = $('metro').checked;
    if (useMetro || countIn) {
      for (let b = -countIn; b < endBeat - startBeat; b++) {
        if (b < 0 || useMetro) click(S.master, S.t0 + b * spb, ((b % bm) + bm) % bm === 0);
      }
    }
    // Notas que suenan solas (se programan poco a poco para poder detenerlas al instante)
    S.sched = S.notes
      .filter((n) => n.q >= startBeat && n.q < endBeat &&
        (S.mode === 'listen' || ($('backing').checked && !handActive(n.hand))))
      .sort((a, b) => a.q - b.q);
    S.schedI = 0;
    clearInterval(S.schedTimer);
    const pump = () => {
      const now = audio().currentTime;
      while (S.schedI < S.sched.length && S.timeOf(S.sched[S.schedI].q) < now + 0.12) {
        const n = S.sched[S.schedI++];
        playNote(n.pitch, Math.max(S.timeOf(n.q), now), n.qd * spb * 0.95, n.vel, S.master);
      }
    };
    S.schedTimer = setInterval(pump, 25); pump();
    for (const s of S.steps) { s.time = S.timeOf(s.beat); s.state = 'idle'; s.got.clear(); }
    S.lastCur = null;
    setFeedback(S.mode === 'rhythm' ? 'Sigue el tempo: toca cada nota a tiempo.' : 'Escuchando…');
    S.raf = requestAnimationFrame(tick);
  }

  function tick() {
    if (S.status !== 'rhythm' && S.status !== 'listen') return;
    const now = audio().currentTime;
    const ov = $('overlay');
    if (now < S.t0 - 0.02) {
      ov.hidden = false; ov.textContent = Math.ceil((S.t0 - now) / S.spb - 1e-6);
    } else ov.hidden = true;

    if (S.status === 'rhythm') {
      for (const s of S.steps) {
        if (s.state === 'idle' && now > s.time + S.tol) {
          s.state = 'miss'; S.stats.errs++; paint(s, 's-miss');
        }
      }
    } else {
      for (const s of S.steps) {
        if (s.state === 'idle' && now >= s.time) {
          s.state = 'ok';
          if (S.lastCur) paint(S.lastCur, null);
          paint(s, 's-cur'); S.lastCur = s; scrollTo(s);
        }
      }
    }
    const nxt = S.steps.find((s) => s.state === 'idle');
    if (nxt && S.status === 'rhythm') { paint(nxt, 's-cur'); scrollTo(nxt); }
    refreshKeys(); updateStats();

    if (now >= S.endTime + 0.5) { endPass(); return; }
    S.raf = requestAnimationFrame(tick);
  }

  function endPass() {
    const total = S.steps.length;
    let msg = '';
    if (S.mode === 'rhythm') {
      const acc = S.stats.ok / total;
      msg = 'Precisión: ' + Math.round(acc * 100) + '% (' + S.stats.ok + '/' + total + '), errores: ' + S.stats.errs + '.';
      if ($('loop').checked) {
        S.passes++;
        if ($('autoSpeed').checked && acc >= 0.9 && S.speed < 1.25) {
          S.speed = Math.min(1.25, Math.round((S.speed + 0.05) * 100) / 100);
          $('speed').value = Math.round(S.speed * 100); $('speedLabel').textContent = Math.round(S.speed * 100) + '%';
          msg += ' ¡Subo a ' + Math.round(S.speed * 100) + '%!';
        }
        setFeedback(msg, acc >= 0.9 ? 'good' : '');
        cancelAnimationFrame(S.raf);
        const keep = S.passes;
        setTimeout(() => { if (S.status === 'rhythm' && S.passes === keep) beginPassKeep(); }, 900);
        return;
      }
      setFeedback(msg, acc >= 0.9 ? 'good' : '');
    } else {
      msg = 'Fin de la canción.';
      if ($('loop').checked) { S.passes++; cancelAnimationFrame(S.raf); setTimeout(() => { if (S.status === 'listen') beginPassKeep(); }, 600); return; }
      setFeedback(msg);
    }
    stopAll(true);
  }
  function beginPassKeep() { const p = S.passes; beginPass(); S.passes = p; updateStats(); }

  // ───────────────────────── Entrada de notas ─────────────────────────
  function noteOn(pitch, vel, audioTime) {
    S.held.add(pitch);
    const el = S.keyEls[pitch];
    if (el) el.classList.add('down');
    if ($('thru').checked) {
      S.thruOn.add(pitch);
      if (Sound.enabled) Sound.synth.noteOn(1, pitch, vel || 90);
      else tone(audio() && S.bus, pitch, audio().currentTime, 0.6, vel);
    }

    if (S.status === 'wait') waitInput(pitch);
    else if (S.status === 'rhythm') rhythmInput(pitch, audioTime == null ? audio().currentTime : audioTime);
  }
  function noteOff(pitch) {
    S.held.delete(pitch);
    if (S.thruOn.delete(pitch) && Sound.enabled) Sound.synth.noteOff(1, pitch);
    const el = S.keyEls[pitch];
    if (el) el.classList.remove('down');
  }
  function flashWrong(pitch) {
    const el = S.keyEls[pitch]; if (!el) return;
    el.classList.add('wrong'); setTimeout(() => el.classList.remove('wrong'), 250);
  }

  function waitInput(pitch) {
    const s = S.steps[S.idx];
    if (!s) return;
    if (s.pitches.has(pitch)) {
      s.got.add(pitch);
      if (s.got.size === s.pitches.size) {
        const clean = !s.err;
        s.state = clean ? 'ok' : 'bad';
        paint(s, clean ? 's-ok' : 's-bad');
        if (clean) S.stats.ok++; else S.stats.bad++;
        S.idx++;
        if (S.idx >= S.steps.length) { waitFinished(); return; }
        const n = S.steps[S.idx];
        paint(n, 's-cur'); scrollTo(n);
        setFeedback('¡Bien!', 'good');
      }
    } else {
      s.err = true; S.stats.errs++;
      flashWrong(pitch);
      setFeedback('Esa no es: busca ' + [...s.pitches].filter((p) => !s.got.has(p)).map(noteName).join(' + '), 'bad');
    }
    refreshKeys(); updateStats();
  }

  function waitFinished() {
    const acc = S.stats.ok / S.stats.total;
    const msg = 'Terminaste: ' + Math.round(acc * 100) + '% sin errores (' + S.stats.ok + '/' + S.stats.total + '), ' + S.stats.errs + ' fallos.';
    if ($('loop').checked) {
      S.passes++;
      setFeedback(msg + ' Otra vuelta…', acc >= 0.9 ? 'good' : '');
      const keep = S.passes;
      S.status = 'idle'; refreshKeys();
      setTimeout(() => { if (S.passes === keep && S.status === 'idle') { S.mode = currentMode(); beginPassKeep(); } }, 900);
      return;
    }
    setFeedback(msg, acc >= 0.9 ? 'good' : '');
    stopAll(true);
    S.stats = { ...S.stats }; updateStats();
  }
  const currentMode = () => document.querySelector('#modes .on').dataset.v;

  function rhythmInput(pitch, t) {
    let best = null, bd = Infinity;
    for (const s of S.steps) {
      if (s.state !== 'idle' || !s.pitches.has(pitch) || s.got.has(pitch)) continue;
      const d = Math.abs(t - s.time);
      if (d <= S.tol && d < bd) { best = s; bd = d; }
    }
    if (best) {
      best.got.add(pitch);
      if (best.got.size === best.pitches.size) {
        best.state = 'ok'; S.stats.ok++; paint(best, 's-ok');
        const dt = t - best.time;
        setFeedback(Math.abs(dt) < S.tol * 0.45 ? '¡Justo!' : (dt < 0 ? 'Un poco temprano' : 'Un poco tarde'), Math.abs(dt) < S.tol * 0.45 ? 'good' : '');
      }
    } else {
      S.stats.errs++; flashWrong(pitch);
      setFeedback('Nota fuera de lugar o de tiempo', 'bad');
    }
    updateStats();
  }

  // ───────────────────────── MIDI real ─────────────────────────
  async function initMidi() {
    const st = $('midiStatus');
    if (!navigator.requestMIDIAccess) { st.textContent = 'MIDI no disponible'; return; }
    try {
      const access = await navigator.requestMIDIAccess();
      const refresh = () => {
        const names = [];
        for (const inp of access.inputs.values()) {
          names.push(inp.name);
          inp.onmidimessage = onMidi;
        }
        st.textContent = names.length ? '● ' + names.join(', ') : 'Sin piano MIDI';
        st.classList.toggle('ok', names.length > 0);
        $('kbHint').style.display = names.length ? 'none' : '';
      };
      access.onstatechange = refresh;
      refresh();
    } catch (e) {
      st.textContent = 'MIDI bloqueado';
    }
  }
  function onMidi(e) {
    const [status, a, b] = e.data;
    const type = status & 0xf0;
    if (type === 0x90 && b > 0) {
      const lat = (performance.now() - e.timeStamp) / 1000;
      const t = S.ctx ? S.ctx.currentTime - Math.max(0, lat) : 0;
      noteOn(a, b, t);
    } else if (type === 0x80 || (type === 0x90 && b === 0)) noteOff(a);
  }

  // Teclado del PC como respaldo
  const KEYMAP = {};
  'zsxdcvgbhnjm'.split('').forEach((k, i) => (KEYMAP[k] = 48 + i));
  'q2w3er5t6y7u'.split('').forEach((k, i) => (KEYMAP[k] = 60 + i));
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
    const p = KEYMAP[e.key.toLowerCase()];
    if (p != null) noteOn(p, 90);
  });
  window.addEventListener('keyup', (e) => { const p = KEYMAP[e.key.toLowerCase()]; if (p != null) noteOff(p); });

  // ───────────────────────── Canción de ejemplo ─────────────────────────
  function demoSong() {
    const E = 64, F = 65, G = 67, D = 62, C = 60;
    const mel = [
      [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1],
      [C, 1], [C, 1], [D, 1], [E, 1], [E, 1.5], [D, 0.5], [D, 2],
      [E, 1], [E, 1], [F, 1], [G, 1], [G, 1], [F, 1], [E, 1], [D, 1],
      [C, 1], [C, 1], [D, 1], [E, 1], [D, 1.5], [C, 0.5], [C, 2]
    ];
    const notes = []; let t = 0;
    for (const [p, d] of mel) { notes.push({ pitch: p, start: t, dur: d * 0.95, vel: 90, track: 1 }); t += d; }
    const bass = [[48, 55], [43, 50], [48, 55], [43, 50], [48, 55], [43, 50], [48, 55], [43, 48]];
    bass.forEach(([a, b], m) => {
      notes.push({ pitch: a, start: m * 4, dur: 3.8, vel: 70, track: 2 });
      notes.push({ pitch: b, start: m * 4, dur: 3.8, vel: 70, track: 2 });
    });
    notes.sort((x, y) => x.start - y.start);
    return {
      title: 'Himno a la alegría (ejemplo)', ppq: 480, bpm: 90, num: 4, den: 4, beatsPerMeasure: 4, sf: 0, notes,
      tracks: [{ index: 1, name: 'Melodía', count: 30, avg: 63 }, { index: 2, name: 'Bajo', count: 16, avg: 47 }]
    };
  }

  // ───────────────────────── Interfaz ─────────────────────────
  const MODE_HELP = {
    wait: 'La canción espera hasta que toques la nota correcta. Ideal para aprender.',
    rhythm: 'Hay cuenta previa y metrónomo. Debes tocar cada nota a tiempo.',
    listen: 'Escucha la canción y mira el cursor recorrer la partitura.'
  };
  function updateSplitLabel() {
    $('splitLabel').textContent = noteName(S.splitPoint) + ' (' + S.splitPoint + ')';
  }
  function segment(id, cb) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      cb(b.dataset.v);
    });
  }

  function init() {
    $('modeHelp').textContent = MODE_HELP.wait;
    segment('views', setView);
    initEditor();
    const sv = store.get('view', 'fall');
    setView(['fall', 'score', 'both'].includes(sv) ? sv : 'fall');
    new ResizeObserver(fallResize).observe($('fallWrap'));
    requestAnimationFrame(drawFall);
    segment('hands', (v) => { S.hands = v; if (S.status !== 'idle') stopAll(); applyDim(); });
    segment('modes', (v) => { S.mode = v; $('modeHelp').textContent = MODE_HELP[v]; if (S.status !== 'idle') stopAll(); });
    $('splitMode').addEventListener('change', (e) => {
      S.splitMode = e.target.value; $('splitRow').style.display = S.splitMode === 'pitch' ? '' : 'none';
      stopAll(true); if (S.song) { assignHands(); renderScore(); }
    });
    $('splitPoint').addEventListener('input', (e) => { S.splitPoint = +e.target.value; updateSplitLabel(); });
    $('splitPoint').addEventListener('change', () => { stopAll(true); if (S.song) { assignHands(); renderScore(); } });
    $('speed').addEventListener('input', (e) => { S.speed = e.target.value / 100; $('speedLabel').textContent = e.target.value + '%'; });
    const loopChange = () => {
      let a = Math.max(1, Math.min(S.measures || 1, +$('loopA').value || 1));
      let b = Math.max(1, Math.min(S.measures || 1, +$('loopB').value || 1));
      if (b < a) b = a;
      $('loopA').value = a; $('loopB').value = b; S.loopA = a; S.loopB = b;
      if (S.status !== 'idle') stopAll();
    };
    $('loopA').addEventListener('change', loopChange);
    $('loopB').addEventListener('change', loopChange);
    S.metro = $('metro').checked;
    $('metro').addEventListener('change', () => (S.metro = $('metro').checked));
    $('names').addEventListener('change', buildKeyboard);

    $('start').addEventListener('click', () => (S.status === 'idle' ? start() : stopAll()));
    $('reset').addEventListener('click', () => { stopAll(true); if (S.song) { clearPaint(); setFeedback('Reiniciado.'); } });
    $('demo').addEventListener('click', () => loadSong(demoSong(), 'Himno a la alegría (ejemplo)'));
    $('file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const song = MidiParser.parse(await f.arrayBuffer());
        loadSong(song, f.name.replace(/\.midi?$/i, ''));
      } catch (err) { setFeedback('No pude leer el archivo: ' + err.message, 'bad'); }
      e.target.value = '';
    });
    window.addEventListener('resize', () => { buildKeyboard(); });

    $('ver').textContent = window.pianoApi ? 'v' + window.pianoApi.version : '(desarrollo)';

    // Sonido / SoundFont
    $('volume').value = Math.round(Sound.volume * 100); $('volLabel').textContent = $('volume').value + '%';
    $('volume').addEventListener('input', (e) => {
      Sound.volume = e.target.value / 100; $('volLabel').textContent = e.target.value + '%';
      store.set('vol', e.target.value);
      if (S.bus) S.bus.gain.value = Sound.volume * VOL_BOOST;
    });
    $('preset').addEventListener('change', (e) => {
      const p = Sound.presets.find((x) => x.key === e.target.value); if (!p) return;
      Sound.preset = p; store.set(presetKey(), p.key); applyProgram(); preview();
    });
    $('presetFilter').addEventListener('input', renderPresets);
    const sel = $('sfSelect');
    const api = window.pianoApi;
    async function refreshSfList() {
      if (!api) return;
      const { list, current } = await api.listSoundfonts();
      sel.innerHTML = '<option value="">Sonido básico integrado</option>';
      for (const it of list) {
        const o = document.createElement('option');
        o.value = it.path; o.textContent = it.name + (it.missing ? ' (no encontrado)' : '');
        sel.appendChild(o);
      }
      sel.value = Sound.enabled ? current : '';
      $('sfRemove').disabled = !sel.value;
    }
    async function pickSoundfont(p) {
      if (!p) {
        if (Sound.synth) Sound.synth.stopAll(true);
        Sound.enabled = false; syncSoundUi();
        if (api) await api.clearSoundfont();
        setFeedback('Usando el sonido básico.');
      } else {
        const r = await api.selectSoundfont(p);
        if (r) await useSoundfont(toBuffer(r.data), r.name);
        else setFeedback('No encuentro ese archivo de SoundFont.', 'bad');
      }
      await refreshSfList();
    }
    sel.addEventListener('change', () => pickSoundfont(sel.value));
    $('sfAdd').addEventListener('click', async () => {
      if (!api) { $('sfFile').click(); return; }
      const r = await api.addSoundfonts();
      if (r) await pickSoundfont(r.first);
    });
    $('sfRemove').addEventListener('click', async () => {
      if (!sel.value) return;
      const wasActive = Sound.enabled;
      await api.removeSoundfont(sel.value);
      if (wasActive) { if (Sound.synth) Sound.synth.stopAll(true); Sound.enabled = false; syncSoundUi(); }
      await refreshSfList();
    });
    $('sfFile').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      await useSoundfont(await f.arrayBuffer(), f.name); e.target.value = '';
    });
    if (api) {
      api.savedSoundfont().then(async (r) => { if (r) await useSoundfont(toBuffer(r.data), r.name); refreshSfList(); }).catch(() => {});
      refreshSfList();
    }

    buildKeyboard();
    initMidi();
  }
  init();
  window.__S = S; window.__load = loadSong; // útil para depurar
})();
