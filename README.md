# Studio Cutout

A background remover and quick product-shot editor that runs entirely in the browser. Images never leave your device — the AI model runs locally on your GPU (WebGPU) or CPU (WebAssembly).

Companion to Studio Desktop and the Studio Android app.

## What it does

**Cutout**
- One-click AI background removal, three models:
  - **Everything** — BiRefNet Lite (products, pets, objects, people)
  - **Max detail** — BEN2 (hair, fur, fine edges; bigger download)
  - **People only** — MODNet (fastest)
- Batch: add many images, remove all backgrounds in one go
- Touch-up brushes: Erase / Restore with size and softness
- Erase color / Keep color (magic wand, contiguous or global) — works with no AI at all, good for logos on plain backgrounds
- Edge controls: smooth, shrink/grow, firmness, clean specks, remove color fringe
- Invert, reset, undo/redo, before/after compare, red overlay for removed areas

**Background** — transparent, solid color, gradient (linear/radial), your own photo (blur/dim), or a blurred version of the original (portrait-mode look)

**Effects** — soft / floor / hard shadow, reflection, outline (sticker), brightness / contrast / saturation / warmth on the subject only

**Canvas** — original size, crop to subject, or presets (square, marketplace 2000², portrait post, story, landscape, link preview, thumbnail, 18×24 poster @300dpi, custom), with padding, floor alignment, scale, nudge, flip

**Export** — PNG / WebP / JPG, copy to clipboard, download all as ZIP, download the mask

Background, effects and canvas settings apply to every image so a batch comes out matching. Settings are remembered between visits.

## Shortcuts

| Key | Action |
| --- | --- |
| H / E / R | Move / Erase / Restore |
| W / K | Erase color / Keep color |
| [ / ] | Brush smaller / bigger |
| Space (hold) | Show original |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S | Download current image |
| 0, + , − | Fit, zoom in, zoom out |
| ↑ / ↓ | Previous / next image |
| Alt-drag, middle-drag, wheel | Pan, pan, zoom |

Paste images straight from the clipboard, or drag files anywhere on the page.

## Hosting on GitHub Pages

No build step — it's plain HTML/CSS/JS.

1. Create a public repo (e.g. `BrinsGarden/studio-cutout`) and push these files to `main`.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.
3. Open `https://brinsgarden.github.io/studio-cutout/`. In Chrome/Edge you can install it as an app from the address bar.

Running locally: any static server works, e.g. `npx serve .` or `python -m http.server`, then open `http://localhost:3000` / `:8000`. (Opening `index.html` as a file won't work — module workers need http.)

## Notes

- First use of each model downloads it from the Hugging Face Hub (tens to a couple hundred MB); after that it's cached by the browser and works offline.
- Best in Chrome or Edge (WebGPU). Firefox/Safari fall back to CPU, which is slower but works.
- Images larger than 4096 px on the long side are scaled down to 4096 for editing.
- HEIC photos aren't readable by most browsers — convert to JPG first.

## Files

```
index.html             layout and controls
css/app.css            styles
js/app.js              state, UI, viewport, brushes, export
js/render.js           compositing (background, shadow, reflection, outline, subject)
js/mask.js             mask math (grow/shrink, blur, speck cleanup, color select, decontamination)
js/segment-worker.js   AI model in a Web Worker (transformers.js)
js/sample.js           generated sample image
sw.js                  offline app shell
```

## Credits

- [Transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0)
- Models: [BiRefNet Lite](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) (MIT), [BEN2](https://huggingface.co/onnx-community/BEN2-ONNX) (MIT), [MODNet](https://huggingface.co/Xenova/modnet) (Apache-2.0)
- [JSZip](https://stuk.github.io/jszip/) (MIT)
