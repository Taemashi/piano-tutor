// Genera la partitura (clave de sol + clave de fa) con VexFlow a partir de las notas cuantizadas.
// Cada nota debe tener: pitch, q (inicio en tiempos, múltiplo de 0.25), qd (duración), hand ('R' | 'L').
(function () {
  const VF = Vex.Flow;
  const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const FLAT = ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b'];
  const DURS = [[4, 'w'], [3, 'hd'], [2, 'h'], [1.5, 'qd'], [1, 'q'], [0.75, '8d'], [0.5, '8'], [0.25, '16']];

  function keyName(p, useFlats) {
    const n = (useFlats ? FLAT : SHARP)[p % 12];
    return n + '/' + (Math.floor(p / 12) - 1);
  }

  function decompose(len) {
    const out = [];
    let left = len;
    while (left > 1e-6) {
      const d = DURS.find((x) => x[0] <= left + 1e-6);
      if (!d) break;
      out.push(d);
      left -= d[0];
    }
    return out;
  }

  // Construye las figuras de una mano dentro de un compás.
  function buildMeasure(notes, mStart, mLen, clef, useFlats) {
    const byOnset = new Map();
    for (const n of notes) {
      let e = byOnset.get(n.q);
      if (!e) { e = { q: n.q, pitches: new Set(), dur: 0 }; byOnset.set(n.q, e); }
      e.pitches.add(n.pitch);
      e.dur = Math.max(e.dur, n.qd);
    }
    const events = [...byOnset.values()].sort((a, b) => a.q - b.q);
    const mEnd = mStart + mLen;
    const restKey = clef === 'treble' ? 'b/4' : 'd/3';
    const out = []; // { vf, beat, rest, tieWithPrev }

    const addRest = (from, to) => {
      let at = from;
      for (const [len, code] of decompose(to - from)) {
        const vf = new VF.StaveNote({ keys: [restKey], duration: code + 'r', clef });
        if (code.length > 1 && code.endsWith('d')) VF.Dot.buildAndAttach([vf], { all: true });
        out.push({ vf, beat: at, rest: true });
        at += len;
      }
    };

    let cursor = mStart;
    events.forEach((ev, i) => {
      if (ev.q > cursor) addRest(cursor, ev.q);
      const next = i + 1 < events.length ? events[i + 1].q : mEnd;
      const limit = Math.min(next, mEnd);
      let end = Math.min(ev.q + ev.dur, limit);
      // Si queda un hueco pequeño (staccato/articulación), alarga la figura para que la partitura sea legible.
      if (limit - end <= 0.5) end = limit;
      const dur = Math.max(end - ev.q, 0.25);
      const keys = [...ev.pitches].sort((a, b) => a - b).map((p) => keyName(p, useFlats));
      let at = ev.q;
      decompose(dur).forEach(([len, code], idx) => {
        const vf = new VF.StaveNote({ keys, duration: code, clef });
        if (code.endsWith('d')) VF.Dot.buildAndAttach([vf], { all: true });
        out.push({ vf, beat: at, rest: false, tieWithPrev: idx > 0 });
        at += len;
      });
      cursor = Math.min(ev.q + dur, mEnd);
    });
    if (cursor < mEnd) addRest(cursor, mEnd);
    return out;
  }

  function render(container, song, notes, measures, useFlats) {
    container.innerHTML = '';
    const bm = song.beatsPerMeasure;
    const W = Math.max(container.clientWidth - 24, 500);

    // Agrupa notas por mano y compás
    const per = { R: [], L: [] };
    for (let m = 0; m < measures; m++) { per.R.push([]); per.L.push([]); }
    for (const n of notes) {
      const m = Math.floor(n.q / bm + 1e-9);
      if (m >= 0 && m < measures) per[n.hand][m].push(n);
    }

    // Construye figuras
    const built = [];
    for (let m = 0; m < measures; m++) {
      const tr = buildMeasure(per.R[m], m * bm, bm, 'treble', useFlats);
      const ba = buildMeasure(per.L[m], m * bm, bm, 'bass', useFlats);
      const slots = Math.max(tr.length, ba.length);
      built.push({ tr, ba, width: Math.max(150, 70 + slots * 34) });
    }

    // Reparte compases en filas
    const rows = [];
    let row = [], used = 0;
    built.forEach((b, m) => {
      const extra = row.length === 0 ? (rows.length === 0 ? 90 : 55) : 0;
      if (row.length && used + b.width + extra > W) { rows.push(row); row = []; used = 0; }
      const ex = row.length === 0 ? (rows.length === 0 ? 90 : 55) : 0;
      row.push(m); used += b.width + ex;
    });
    if (row.length) rows.push(row);

    const ROW_H = 250;
    const renderer = new VF.Renderer(container, VF.Renderer.Backends.SVG);
    renderer.resize(W + 20, rows.length * ROW_H + 30);
    const ctx = renderer.getContext();

    const noteEls = new Map(); // beat -> [{ el, hand }]
    const measureEl = [];
    const pending = [];

    rows.forEach((ms, r) => {
      const y = 20 + r * ROW_H;
      const exFirst = r === 0 ? 90 : 55;
      const totalBase = ms.reduce((s, m) => s + built[m].width, 0) + exFirst;
      const scale = Math.min(W / totalBase, r === rows.length - 1 ? 1.15 : 3);
      let x = 10;
      ms.forEach((m, k) => {
        const b = built[m];
        const w = b.width * scale + (k === 0 ? exFirst : 0);
        const treble = new VF.Stave(x, y, w);
        const bass = new VF.Stave(x, y + 100, w);
        if (k === 0) {
          treble.addClef('treble'); bass.addClef('bass');
          if (r === 0) {
            const ts = song.num + '/' + song.den;
            treble.addTimeSignature(ts); bass.addTimeSignature(ts);
          }
        }
        treble.setMeasure(m + 1);
        treble.setContext(ctx).draw();
        bass.setContext(ctx).draw();
        if (k === 0) {
          new VF.StaveConnector(treble, bass).setType(3).setContext(ctx).draw();
          new VF.StaveConnector(treble, bass).setType(1).setContext(ctx).draw();
        }
        new VF.StaveConnector(treble, bass).setType(0).setContext(ctx).draw();

        const mk = (list) => {
          const voice = new VF.Voice({ num_beats: bm * 4, beat_value: 16 }).setMode(VF.Voice.Mode.SOFT);
          voice.addTickables(list.map((o) => o.vf));
          return voice;
        };
        const vT = mk(b.tr), vB = mk(b.ba);
        VF.Accidental.applyAccidentals([vT], 'C');
        VF.Accidental.applyAccidentals([vB], 'C');
        const avail = Math.max(treble.getNoteEndX() - treble.getNoteStartX() - 14, 40);
        new VF.Formatter().joinVoices([vT]).joinVoices([vB]).format([vT, vB], avail);

        const beamsT = VF.Beam.generateBeams(b.tr.map((o) => o.vf));
        const beamsB = VF.Beam.generateBeams(b.ba.map((o) => o.vf));
        vT.draw(ctx, treble);
        vB.draw(ctx, bass);
        beamsT.concat(beamsB).forEach((bm2) => bm2.setContext(ctx).draw());

        // Ligaduras entre figuras partidas
        [[b.tr], [b.ba]].forEach(([list]) => {
          list.forEach((o, i) => {
            if (o.tieWithPrev && i > 0 && !list[i - 1].rest) {
              const idx = o.vf.getKeys().map((_, j) => j);
              new VF.StaveTie({ first_note: list[i - 1].vf, last_note: o.vf, first_indices: idx, last_indices: idx })
                .setContext(ctx).draw();
            }
          });
        });

        // Registro para colorear
        [[b.tr, 'R'], [b.ba, 'L']].forEach(([list, hand]) => {
          list.forEach((o) => {
            if (o.rest || o.tieWithPrev) return;
            const el = o.vf.getSVGElement();
            if (!el) return;
            if (!noteEls.has(o.beat)) noteEls.set(o.beat, []);
            noteEls.get(o.beat).push({ el, hand });
          });
        });
        measureEl[m] = { x, y, w };
        x += w;
      });
    });

    return { noteEls, measureEl, rows: rows.length, rowH: ROW_H };
  }

  window.Notation = { render };
})();
