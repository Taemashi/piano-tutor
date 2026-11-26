// Empaqueta el sintetizador SoundFont (spessasynth) para usarlo sin bundler en la app.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
await build({ entryPoints: ['tools/synth-entry.js'], bundle: true, format: 'iife', minify: true, outfile: 'src/vendor/spessa.js' });
copyFileSync('node_modules/spessasynth_lib/dist/spessasynth_processor.min.js', 'src/vendor/spessasynth_processor.min.js');
copyFileSync('node_modules/vexflow/build/cjs/vexflow.js', 'src/vendor/vexflow.js');
console.log('vendor listo');
