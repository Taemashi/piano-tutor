// Decide qué notas son de la mano derecha (melodía) y cuáles de la izquierda (bajo).
// Orden: 1) nombres de pista  2) pistas separadas por altura  3) corte adaptable por compás.
// Cada nota recibe n.auto = 'R' | 'L'. Devuelve { level: 'ok'|'info'|'warn', title, detail, ambiguous }.
(function () {
  const RIGHT = /(^|[^a-z])(right|rh|r\.h\.?|derech\w*|melod\w*|lead|vocal\w*|treble|upper|agudo\w*)/i;
  const LEFT = /(^|[^a-z])(left|lh|l\.h\.?|izquierd\w*|izq\b|bass|bajo|accomp\w*|acomp\w*|lower|grave\w*)/i;

  function byNames(song, notes) {
    const tr = song.tracks;
    if (tr.length < 2) return null;
    const side = {};
    let nR = 0, nL = 0;
    for (const t of tr) {
      const r = RIGHT.test(t.name), l = LEFT.test(t.name);
      if (r && !l) { side[t.index] = 'R'; nR++; }
      else if (l && !r) { side[t.index] = 'L'; nL++; }
    }
    if (!nR && !nL) return null;
    const avgOf = (s) => {
      const a = tr.filter((t) => side[t.index] === s);
      return a.reduce((x, t) => x + t.avg, 0) / a.length;
    };
    const aR = nR ? avgOf('R') : null, aL = nL ? avgOf('L') : null;
    for (const t of tr) {
      if (side[t.index]) continue;
      if (aR != null && aL != null) side[t.index] = Math.abs(t.avg - aR) <= Math.abs(t.avg - aL) ? 'R' : 'L';
      else if (aR != null) side[t.index] = t.avg >= aR ? 'R' : 'L';
      else side[t.index] = t.avg <= aL ? 'L' : 'R';
    }
    for (const n of notes) n.auto = side[n.track] || 'R';
    const both = nR > 0 && nL > 0;
    const names = tr.map((t) => '«' + t.name + '»').join(', ');
    return {
      level: both ? 'ok' : 'info',
      title: both ? 'Seguro: dividido por nombres de pista' : 'Probable: una pista tiene nombre de mano',
      detail: 'Pistas: ' + names + '.'
    };
  }

  function byTracks(song, notes) {
    const tr = song.tracks;
    if (tr.length < 2) return null;
    const max = Math.max(...tr.map((t) => t.avg)), min = Math.min(...tr.map((t) => t.avg));
    if (max - min < 8) return null; // pistas mezcladas: no sirve separar por pista
    const mid = (max + min) / 2;
    const side = {};
    for (const t of tr) side[t.index] = t.avg >= mid ? 'R' : 'L';
    // ¿las pistas "izquierdas" invaden la zona de las "derechas"?
    const rp = notes.filter((n) => side[n.track] === 'R').map((n) => n.pitch).sort((a, b) => a - b);
    const lp = notes.filter((n) => side[n.track] === 'L');
    if (!rp.length || !lp.length) return null;
    const p15 = rp[Math.floor(rp.length * 0.15)];
    const invade = lp.filter((n) => n.pitch > p15).length / lp.length;
    if (invade > 0.3) return null;
    for (const n of notes) n.auto = side[n.track];
    return { level: 'info', title: 'Probable: dividido por pistas del archivo', detail: 'La pista más aguda es la derecha. Revísalo si algo suena raro.' };
  }

  // Corte que cambia compás a compás, buscando el mayor "hueco" entre notas graves y agudas.
  function adaptive(song, notes, bm, measures) {
    const byM = Array.from({ length: measures }, () => []);
    for (const n of notes) byM[Math.min(measures - 1, Math.floor(n.q / bm + 1e-9))].push(n);
    const split = new Array(measures).fill(null);
    for (let m = 0; m < measures; m++) {
      const u = [...new Set(byM[m].map((n) => n.pitch))].sort((a, b) => a - b);
      let best = null;
      for (let i = 0; i + 1 < u.length; i++) {
        const gap = u[i + 1] - u[i], mid = (u[i] + u[i + 1]) / 2;
        if (gap < 4 || mid < 43 || mid > 77) continue;
        const score = gap - Math.abs(mid - 60) * 0.05;
        if (!best || score > best.score) best = { score, mid };
      }
      if (best) split[m] = best.mid;
    }
    const good = split.map((s) => s != null);
    for (let m = 0; m < measures; m++) {
      if (good[m]) continue;
      let d = 1, v = null;
      while (v == null && (m - d >= 0 || m + d < measures)) {
        if (m - d >= 0 && good[m - d]) v = split[m - d];
        else if (m + d < measures && good[m + d]) v = split[m + d];
        d++;
      }
      split[m] = v == null ? 60 : v;
    }
    const ambiguous = [];
    for (let m = 0; m < measures; m++) {
      for (const n of byM[m]) n.auto = n.pitch >= split[m] ? 'R' : 'L';
      if (!good[m] && byM[m].length) {
        const lo = Math.min(...byM[m].map((n) => n.pitch)), hi = Math.max(...byM[m].map((n) => n.pitch));
        if (lo < split[m] + 7 && hi > split[m] - 7) ambiguous.push(m + 1);
      }
    }
    const withNotes = byM.filter((a) => a.length).length || 1;
    const bad = ambiguous.length / withNotes >= 0.1;
    return {
      level: bad ? 'warn' : 'info',
      title: bad ? 'Revisa: dividido por altura adaptable' : 'Probable: dividido por altura adaptable',
      detail: ambiguous.length
        ? 'Compases dudosos: ' + ambiguous.slice(0, 8).join(', ') + (ambiguous.length > 8 ? '…' : '') + '. Usa «Editar manos» para corregirlos.'
        : 'El corte se ajusta a cada compás.',
      ambiguous
    };
  }

  function detect(song, notes, bm, measures, mode, point) {
    if (mode === 'pitch') {
      for (const n of notes) n.auto = n.pitch >= point ? 'R' : 'L';
      return { level: 'info', title: 'Corte fijo manual', detail: 'Todas las notas desde el corte hacia arriba son la mano derecha.', ambiguous: [] };
    }
    return byNames(song, notes) || byTracks(song, notes) || adaptive(song, notes, bm, measures);
  }

  window.Hands = { detect };
})();
