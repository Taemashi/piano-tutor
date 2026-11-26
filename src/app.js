(function () {
  const $ = (id) => document.getElementById(id);
  const NAMES_ES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
  const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
  const noteName = (p) => NAMES_ES[p % 12] + (Math.floor(p / 12) - 1);

  const S = {
    song: null, notes: [], hands: 'both', mode: 'wait', speed: 1,
    splitMode: 'pitch', splitPoint: 60,
    loopA: 1, loopB: 1, measures: 0,
    steps: [], idx: 0, status: 'idle', noteEls: new Map(), measureEl: [], rowH: 250,
    stats: { ok: 0, bad: 0, errs: 0, total: 0 },
    keyEls: {}, kbLo: 36, kbHi: 96, held: new Set(), passes: 0,
    ctx: null, master: null, raf: 0, t0: 0, spb: 0.5, endTime: 0, timeOf: null, tol: 0.2, lastCur: null
  };

  // ───────────────────────── Audio ─────────────────────────
  function audio() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ctx.state === 'suspended') S.ctx.resume();
    return S.ctx;
  }
  function tone(dest, midi, when, dur, vel) {
    const ctx = audio();
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ctx.createGain();
    const peak = 0.05 + 0.22 * ((vel || 90) / 127);
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
  function assignHands() {
    const notes = S.notes;
    let usePitch = S.splitMode === 'pitch';
    if (!usePitch) {
      const tr = [...S.song.tracks].sort((a, b) => b.avg - a.avg);
      if (tr.length < 2) usePitch = true;
      else {
        const rightTrack = tr[0].index;
        for (const n of notes) n.hand = n.track === rightTrack ? 'R' : 'L';
        return;
      }
    }
    for (const n of notes) n.hand = n.pitch >= S.splitPoint ? 'R' : 'L';
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
    $('splitMode').querySelector('[value=tracks]').disabled = song.tracks.length < 2;
    S.splitMode = song.tracks.length >= 2 ? 'tracks' : 'pitch';
    $('splitMode').value = S.splitMode;
    $('splitRow').style.display = S.splitMode === 'pitch' ? '' : 'none';
    // Punto de corte sugerido: media de alturas
    const avg = S.notes.reduce((s, n) => s + n.pitch, 0) / S.notes.length;
    S.splitPoint = Math.max(40, Math.min(80, Math.round(Math.min(60, avg))));
    $('splitPoint').value = S.splitPoint; updateSplitLabel();
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
    applyDim();
  }

  const handActive = (h) => S.hands === 'both' || S.hands === h;
  function applyDim() {
    for (const list of S.noteEls.values()) for (const e of list) e.el.classList.toggle('dim', !handActive(e.hand));
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
  }
  function currentStep() {
    if (S.status === 'wait') return S.steps[S.idx];
    if (S.status === 'rhythm' || S.status === 'listen') return S.steps.find((s) => s.state === 'idle') || null;
    return null;
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
    S.master = ctx.createGain(); S.master.connect(ctx.destination);

    // Metrónomo y cuenta previa
    const useMetro = $('metro').checked;
    if (useMetro || countIn) {
      for (let b = -countIn; b < endBeat - startBeat; b++) {
        if (b < 0 || useMetro) click(S.master, S.t0 + b * spb, ((b % bm) + bm) % bm === 0);
      }
    }
    // Notas que suenan solas
    for (const n of S.notes) {
      if (n.q < startBeat || n.q >= endBeat) continue;
      const playIt = S.mode === 'listen' || ($('backing').checked && !handActive(n.hand));
      if (playIt) tone(S.master, n.pitch, S.timeOf(n.q), n.qd * spb * 0.95, n.vel);
    }
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
    if ($('thru').checked) tone(audio().destination, pitch, audio().currentTime, 0.6, vel);

    if (S.status === 'wait') waitInput(pitch);
    else if (S.status === 'rhythm') rhythmInput(pitch, audioTime == null ? audio().currentTime : audioTime);
  }
  function noteOff(pitch) {
    S.held.delete(pitch);
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
    buildKeyboard();
    initMidi();
  }
  init();
  window.__S = S; // útil para depurar
})();
