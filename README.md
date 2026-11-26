# Piano Tutor

Aprende a tocar canciones de piano nota por nota con tu piano MIDI. Abre un archivo `.mid`, separa melodía (derecha) y bajo (izquierda), practica con el modo Espera, Ritmo o Escuchar y sigue la partitura al lado.

## Instalar
Descarga `PianoTutor-Setup-x.y.z.exe` desde [Releases](https://github.com/Taemashi/piano-tutor/releases/latest) y ejecútalo. Crea un acceso directo en el escritorio y la app se actualiza sola.

## Desarrollo
```
npm install
npm start          # ejecutar
npm run dist       # generar instalador local en dist/
npm run release    # publicar nueva versión (patch por defecto) en GitHub
```

## SoundFonts
En el panel **Sonido** puedes cargar cualquier SoundFont (`.sf2`, `.sf3`, `.dls`) para cambiar cómo suena el piano; la app recuerda el último que usaste. Si no cargas ninguno, usa un sintetizador básico integrado.
Si cambias las librerías de sonido o partitura, ejecuta `npm run vendor` para regenerar `src/vendor`.
