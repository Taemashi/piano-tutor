// Lector de archivos MIDI estándar (.mid). Devuelve notas en "tiempos" (negras).
(function () {
  function parse(arrayBuffer) {
    const d = new DataView(arrayBuffer);
    let p = 0;
    const str = (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(d.getUint8(p + i));
      p += n;
      return s;
    };
    if (d.byteLength < 14 || str(4) !== 'MThd') throw new Error('No es un archivo MIDI válido.');
    const headerLen = d.getUint32(p); p += 4;
    const ntrks = d.getUint16(p + 2);
    const division = d.getUint16(p + 4);
    p += headerLen;
    if (division & 0x8000) throw new Error('Este MIDI usa tiempo SMPTE (no soportado).');
    const ppq = division;

    const notes = [];
    const tempos = [];
    const tracks = [];
    let timeSig = null;
    let keySig = null;
    let title = '';

    for (let t = 0; t < ntrks && p + 8 <= d.byteLength; t++) {
      const id = str(4);
      const len = d.getUint32(p); p += 4;
      const end = Math.min(p + len, d.byteLength);
      if (id !== 'MTrk') { p = end; continue; }

      let tick = 0, running = 0, name = '', iname = '';
      const open = new Map();
      const tnotes = [];
      const vlq = () => {
        let v = 0, b;
        do { b = d.getUint8(p++); v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < end);
        return v;
      };

      while (p < end) {
        tick += vlq();
        let st = d.getUint8(p);
        if (st < 0x80) { st = running; } else { p++; if (st < 0xf0) running = st; }

        if (st === 0xff) {
          const type = d.getUint8(p++);
          const l = vlq();
          if (type === 0x51 && l === 3) {
            tempos.push({ tick, us: (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2) });
          } else if (type === 0x58 && l >= 2) {
            if (!timeSig) timeSig = { num: d.getUint8(p), den: 1 << d.getUint8(p + 1) };
          } else if (type === 0x59 && l >= 2) {
            if (!keySig) keySig = { sf: d.getInt8(p), minor: d.getUint8(p + 1) };
          } else if (type === 0x04) {
            iname = '';
            for (let i = 0; i < l; i++) iname += String.fromCharCode(d.getUint8(p + i));
          } else if (type === 0x03) {
            name = '';
            for (let i = 0; i < l; i++) name += String.fromCharCode(d.getUint8(p + i));
            if (t === 0 && !title) title = name;
          }
          p += l;
        } else if (st === 0xf0 || st === 0xf7) {
          p += vlq();
        } else {
          const type = st & 0xf0, ch = st & 0x0f;
          const a = d.getUint8(p++);
          const b = (type === 0xc0 || type === 0xd0) ? 0 : d.getUint8(p++);
          const k = ch * 128 + a;
          if (type === 0x90 && b > 0) {
            if (!open.has(k)) open.set(k, []);
            open.get(k).push({ tick, vel: b });
          } else if (type === 0x80 || (type === 0x90 && b === 0)) {
            const q = open.get(k);
            if (q && q.length) {
              const o = q.shift();
              if (ch !== 9) tnotes.push({ pitch: a, start: o.tick, dur: tick - o.tick, vel: o.vel, track: t });
            }
          }
        }
      }
      p = end;
      if (tnotes.length) {
        const avg = tnotes.reduce((s, n) => s + n.pitch, 0) / tnotes.length;
        tracks.push({ index: t, name: name || iname || ('Pista ' + (t + 1)), count: tnotes.length, avg });
        for (const n of tnotes) {
          notes.push({
            pitch: n.pitch,
            start: n.start / ppq,
            dur: Math.max(n.dur / ppq, 0.05),
            vel: n.vel,
            track: n.track
          });
        }
      }
    }

    if (!notes.length) throw new Error('El archivo no contiene notas.');
    notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
    tempos.sort((a, b) => a.tick - b.tick);
    const bpm = tempos.length ? 60000000 / tempos[0].us : 120;
    const num = timeSig ? timeSig.num : 4;
    const den = timeSig ? timeSig.den : 4;
    return {
      title, ppq, bpm: Math.round(bpm * 100) / 100,
      num, den, beatsPerMeasure: num * 4 / den,
      sf: keySig ? keySig.sf : 0,
      notes, tracks
    };
  }

  window.MidiParser = { parse };
})();
