# Auto Video Cleaner

App local para limpiar videos hablados: detecta silencios largos, genera una vista previa editada y permite exportar en MP4 o MOV.

## Descargas

Landing de descarga: https://raulg0mez.github.io/VideoCleaner/

Los instaladores se publican en GitHub Releases cuando se crea un tag `v*`, por ejemplo `v0.1.0`.

## Requisitos

- Node.js 20+
- Python 3.9+
- FFmpeg instalado y disponible como `ffmpeg` y `ffprobe`

En macOS:

```bash
brew install ffmpeg
```

## Instalacion

```bash
npm install
cd client && npm install
cd ../server && python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

## Desarrollo

Desde la raiz:

```bash
npm run dev
```

Frontend: http://localhost:5173

Backend: http://localhost:8000

Para probar la app como ventana nativa en desarrollo:

```bash
npm run dev:native
```

## App nativa instalable

El empaque usa Electron para la ventana nativa, PyInstaller para convertir el backend FastAPI en ejecutable local y electron-builder para generar instaladores.

En macOS genera un `.dmg` para arrastrar a Aplicaciones:

```bash
npm run dist:mac
```

En Windows genera instalador NSIS:

```bash
npm run dist:win
```

Los archivos finales salen en `release/`. Cada instalador debe construirse en su sistema destino (`dist:mac` en macOS, `dist:win` en Windows) porque el backend Python y FFmpeg son binarios nativos. El build incluye `ffmpeg` y `ffprobe` desde los paquetes `@ffmpeg-installer/*`/`@ffprobe-installer/*` y, si no estan disponibles, usa los binarios encontrados en el `PATH`.

## Flujo

1. Arrastra o selecciona un video.
2. Cuando quede cargado, aparecen los controles.
3. Ajusta presets, transcripcion editable e IA opcional.
4. Presiona `Ejecutar limpieza` para procesar con esa configuracion.
5. Revisa la transcripcion, selecciona palabras o frases y usa eliminar para cortar esa parte del video.
6. Deshaz o rehace cortes por texto si hace falta, revisa el antes/despues y usa `Exportar` para elegir el formato final.

## Transcripcion y limpieza con IA

La app funciona sin IA para recortar silencios largos. Para activar transcripcion editable y deteccion local de muletillas/repeticiones con timestamps de Whisper:

```bash
cd server
source .venv/bin/activate
pip install -e ".[ai]"
WHISPER_MODEL=base npm run dev:server
```

Variables utiles:

- `WHISPER_MODEL=base`: modelo de Whisper usado por `faster-whisper`.
- `WHISPER_DEVICE=auto`: cambia a `cpu`, `cuda` o `auto` segun tu maquina.
- `DISABLE_WHISPER=1`: desactiva temporalmente la etapa de transcripcion.

## Notas

- Los archivos procesados se guardan en `server/data/jobs`.
- La primera version usa un detector determinista de silencios con FFmpeg y deja el modulo de IA desacoplado para no depender de un proveedor.
- El render usa H.264/AAC en calidad maxima fija para no degradar el video.
