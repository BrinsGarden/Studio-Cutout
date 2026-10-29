import { processMask, isDefaultEdges, decontaminate, colorSelect, softenSelection } from './mask.js';
import { composite, compositeOriginal, layout, makeCanvas, computeBounds } from './render.js';
import { makeSampleImage } from './sample.js';

const MAX_SIDE = 4096;      // working resolution cap (keeps memory sane on laptops)
const MODEL_SIDE = 2048;    // image size sent to the model; the mask is upscaled back
const UNDO_LIMIT = 20;

// ---------------------------------------------------------------- state
const DEFAULT_STYLE = {
  size: 'original', customW: 1500, customH: 1500,
  pad: 8, align: 'center', scale: 100, nudgeX: 0, nudgeY: 0, flip: false,
  bg: { type: 'none', color: '#ffffff', from: '#fde68a', to: '#f472b6', angle: 135, radial: false, imageBlur: 0, imageDim: 0, blur: 16, blurDim: 0, bw: false },
  fx: { shadow: 'none', shOpacity: 45, shBlur: 30, shX: 0, shY: 18, shColor: '#000000', refl: 0, olSize: 0, olColor: '#ffffff' },
  adj: { bright: 0, contrast: 0, sat: 0, warm: 0 },
};
const DEFAULT_EDGES = { feather: 0, shift: 0, firm: 0, clean: 0, decontam: false };

const S = {
  items: [],
  active: null,
  tab: 'cutout',
  tool: 'pan',
  brush: { size: 40, soft: 35 },
  wand: { tol: 32, contig: true },
  showRemoved: false,
  model: load('model', 'general'),
  style: deepMerge(structuredClone(DEFAULT_STYLE), load('style', {})),
  out: Object.assign({ fmt: 'png', quality: 92, suffix: '-cutout' }, load('export', {})),
  view: { zoom: 1, panX: 0, panY: 0, fitted: true },
  comparing: false,
  bgImage: null,
  engine: null,
};
S.style.flip = false; S.style.nudgeX = 0; S.style.nudgeY = 0; S.style.scale = 100;

function load(key, fallback) {
  try { const v = localStorage.getItem('cutout.' + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem('cutout.' + key, JSON.stringify(value)); } catch {}
}
function deepMerge(a, b) {
  for (const k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') deepMerge(a[k], b[k]);
    else if (k in a) a[k] = b[k];
  }
  return a;
}
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const st = structuredClone(S.style);
    delete st.flip; delete st.nudgeX; delete st.nudgeY; delete st.scale;
    if (st.bg.type === 'image') st.bg.type = 'none';
    save('style', st); save('export', S.out); save('model', S.model);
  }, 300);
}

// ---------------------------------------------------------------- dom
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const stage = $('#stage');
const view = $('#view');
const vctx = view.getContext('2d');
const cursorEl = $('#brush-cursor');

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 6000 : 2400);
}

const activeItem = () => S.items.find((i) => i.id === S.active) || null;
let nextId = 1;

// ---------------------------------------------------------------- import
async function addFiles(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(f.name));
  if (!imgs.length) return;
  let first = null, failed = 0;
  for (const f of imgs) {
    try {
      const item = await createItem(f, f.name);
      S.items.push(item);
      first ??= item;
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  if (failed) toast(`${failed} file${failed > 1 ? 's' : ''} couldn't be opened. HEIC photos need converting to JPG first.`, true);
  renderTray();
  if (first) await activate(first.id);
  updateControls();
}

async function createItem(blob, name) {
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  let { width: w, height: h } = bmp;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (scale < 1) {
    w = Math.round(w * scale); h = Math.round(h * scale);
    const resized = await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    bmp.close();
    bmp = resized;
  }
  const item = {
    id: nextId++,
    name: (name || 'image').replace(/\.[^.]+$/, ''),
    w, h, source: bmp,
    status: 'new',
    aiMask: null, mask: null,
    edges: { ...DEFAULT_EDGES },
    processed: null, bounds: null,
    cutout: null, cutoutVersion: 0,
    undo: [], redo: [],
    thumb: '',
  };
  item.thumb = thumbFrom(bmp, w, h);
  return item;
}

function thumbFrom(src, w, h) {
  const s = 160 / Math.max(w, h);
  const c = makeCanvas(w * s, h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function getRGBA(item) {
  if (item._rgba) return item._rgba;
  const c = makeCanvas(item.w, item.h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(item.source, 0, 0);
  item._rgba = x.getImageData(0, 0, item.w, item.h).data;
  return item._rgba;
}

/** Free the heavy per-image buffers; everything can be rebuilt from source + mask. */
function release(item) {
  if (!item) return;
  item._rgba = null; item._cutData = null; item._cov = null; item._snap = null;
  item.cutout = null; item.processed = null;
  item._sil = null; item._subj = null; item._subjKey = null; item._red = null;
  item._comp = null;
}

function ensureBuilt(item) {
  if (item.mask && !item.cutout) rebuild(item);
}

// ---------------------------------------------------------------- cutout building
function rebuild(item) {
  if (!item.mask) {
    item.processed = null; item.cutout = null; item.bounds = null;
    item.cutoutVersion++;
    return;
  }
  const { w, h } = item;
  item.processed = isDefaultEdges(item.edges) ? item.mask : processMask(item.mask, w, h, item.edges);
  const rgba = getRGBA(item);
  const colors = item.edges.decontam ? decontaminate(rgba, item.processed, w, h) : rgba;
  const data = new ImageData(w, h);
  const d = data.data;
  d.set(colors);
  const p = item.processed;
  for (let i = 0, j = 3; i < p.length; i++, j += 4) d[j] = Math.min(d[j], p[i]);
  item._cutData = data;
  if (!item.cutout) item.cutout = makeCanvas(w, h);
  item.cutout.getContext('2d').putImageData(data, 0, 0);
  computeBounds(item);
  item.cutoutVersion++;
  item._comp = null;
}

let rebuildQueued = null;
function scheduleRebuild(item) {
  rebuildQueued = item;
  requestAnimationFrame(() => {
    if (rebuildQueued !== item) return;
    rebuildQueued = null;
    rebuild(item);
    refreshThumb(item);
    redraw();
    updateControls();
  });
}

let thumbTimer;
function refreshThumb(item) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    item.thumb = thumbFrom(item.cutout || item.source, item.w, item.h);
    const img = $(`.tray-item[data-id="${item.id}"] img`);
    if (img) img.src = item.thumb;
  }, 250);
}

function pushUndo(item) {
  item.undo.push(item.mask ? item.mask.slice() : null);
  if (item.undo.length > UNDO_LIMIT) item.undo.shift();
  item.redo.length = 0;
}
function undo() {
  const item = activeItem();
  if (!item?.undo.length) return;
  item.redo.push(item.mask ? item.mask.slice() : null);
  item.mask = item.undo.pop();
  rebuild(item); refreshThumb(item); redraw(); updateControls();
}
function redo() {
  const item = activeItem();
  if (!item?.redo.length) return;
  item.undo.push(item.mask ? item.mask.slice() : null);
  item.mask = item.redo.pop();
  rebuild(item); refreshThumb(item); redraw(); updateControls();
}

function ensureMask(item) {
  if (!item.mask) item.mask = new Uint8ClampedArray(item.w * item.h).fill(255);
}

// ---------------------------------------------------------------- AI segmentation (worker)
let worker = null;
const pending = new Map();
let currentRun = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') {
      const pct = m.total ? (m.loaded / m.total) * 100 : 0;
      setBusy('Downloading model (one time only)', `${mb(m.loaded)} of ${mb(m.total)} MB`, pct);
    } else if (m.type === 'status') {
      setBusy(m.text, currentRun ? currentRun.label : '', m.text.startsWith('Downloading') ? undefined : null);
    } else if (m.type === 'ready') {
      S.engine = m.device;
      $('#engine-label').textContent = `AI running on ${m.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)'}`;
    } else if (m.type === 'gpu-failed') {
      const list = new Set(load('noGpu', []));
      list.add(m.key);
      save('noGpu', [...list]);
    } else if (m.type === 'mask') {
      pending.get(m.id)?.resolve(m);
      pending.delete(m.id);
    } else if (m.type === 'error') {
      if (m.id != null && pending.has(m.id)) { pending.get(m.id).reject(new Error(m.message)); pending.delete(m.id); }
      else { for (const p of pending.values()) p.reject(new Error(m.message)); pending.clear(); }
    }
  };
  worker.onerror = (e) => {
    console.error('Worker error', e);
    for (const p of pending.values()) p.reject(new Error(e.message || 'The AI worker failed to start'));
    pending.clear();
    worker = null;
  };
  return worker;
}
const mb = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1);

async function segment(item) {
  const scale = Math.min(1, MODEL_SIDE / Math.max(item.w, item.h));
  const bitmap = await createImageBitmap(item.source, scale < 1
    ? { resizeWidth: Math.round(item.w * scale), resizeHeight: Math.round(item.h * scale), resizeQuality: 'high' }
    : {});
  const w = getWorker();
  const res = await new Promise((resolve, reject) => {
    pending.set(item.id, { resolve, reject });
    w.postMessage({ type: 'run', id: item.id, key: S.model, bitmap, skipGpu: load('noGpu', []) }, [bitmap]);
  });
  return upscaleMask(new Uint8ClampedArray(res.data), res.width, res.height, item.w, item.h);
}

function upscaleMask(data, mw, mh, w, h) {
  const small = new ImageData(mw, mh);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) { small.data[j + 3] = data[i]; }
  const a = makeCanvas(mw, mh);
  a.getContext('2d').putImageData(small, 0, 0);
  if (mw === w && mh === h) return data;
  const b = makeCanvas(w, h);
  const bx = b.getContext('2d', { willReadFrequently: true });
  bx.imageSmoothingEnabled = true;
  bx.imageSmoothingQuality = 'high';
  bx.drawImage(a, 0, 0, w, h);
  const big = bx.getImageData(0, 0, w, h).data;
  const out = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = big[j];
  return out;
}

let running = false;
async function removeBackgrounds(items) {
  if (running) return;
  const todo = items.filter((i) => i.status !== 'working');
  if (!todo.length) return;
  running = true;
  todo.forEach((i) => { i.status = 'queued'; });
  renderTray(); updateControls();
  let ok = 0;
  for (let n = 0; n < todo.length; n++) {
    const item = todo[n];
    item.status = 'working';
    currentRun = { label: todo.length > 1 ? `Image ${n + 1} of ${todo.length}` : item.name };
    setBusy('Finding the subject', currentRun.label, null);
    renderTray();
    try {
      const t0 = performance.now();
      const m = await segment(item);
      if (item.mask) pushUndo(item);
      item.aiMask = m;
      item.mask = m.slice();
      item.status = 'done';
      if (item.id === S.active) { rebuild(item); fitIfNeeded(); }
      else { rebuild(item); refreshThumbNow(item); release(item); }
      refreshThumb(item);
      ok++;
      console.info(`[cutout] ${item.name}: ${Math.round(performance.now() - t0)} ms`);
    } catch (err) {
      console.error(err);
      item.status = 'error';
      const offline = /fetch|network|Failed to load|404/i.test(err.message);
      toast(offline
        ? 'Couldn\'t download the AI model. Check your connection — it only needs to download once.'
        : `Background removal failed: ${err.message}`, true);
      if (offline) { todo.slice(n + 1).forEach((i) => { i.status = 'new'; }); break; }
    }
    renderTray(); redraw(); updateControls();
  }
  todo.forEach((i) => { if (i.status === 'queued') i.status = 'new'; });
  running = false; currentRun = null;
  setBusy(null);
  renderTray(); updateControls(); redraw();
  if (ok > 1) toast(`Removed ${ok} backgrounds`);
}
function refreshThumbNow(item) {
  item.thumb = thumbFrom(item.cutout || item.source, item.w, item.h);
}

function setBusy(title, sub = '', pct) {
  const el = $('#busy');
  if (!title) { el.hidden = true; return; }
  el.hidden = false;
  $('#busy-title').textContent = title;
  $('#busy-sub').textContent = sub || '';
  const bar = $('#busy-bar');
  if (pct === undefined) return; // keep previous bar state
  if (pct === null) { bar.classList.add('indeterminate'); }
  else { bar.classList.remove('indeterminate'); bar.style.width = `${Math.max(2, Math.min(100, pct))}%`; }
}

// ---------------------------------------------------------------- tray
function renderTray() {
  const list = $('#tray-list');
  list.innerHTML = '';
  for (const item of S.items) {
    const li = document.createElement('li');
    li.className = 'tray-item' + (item.id === S.active ? ' is-active' : '');
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.title = item.name;
    const label = { queued: 'Waiting', working: 'Working…', done: 'Cut', error: 'Failed' }[item.status];
    li.innerHTML = `<img alt="" src="${item.thumb}">${label ? `<span class="state ${item.status === 'done' ? 'done' : ''}">${label}</span>` : ''}<button class="x" aria-label="Remove ${escapeHtml(item.name)}">×</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.x')) { removeItem(item.id); return; }
      activate(item.id);
    });
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(item.id); if (e.key === 'Delete') removeItem(item.id); });
    list.appendChild(li);
  }
  $('#tray-empty').hidden = S.items.length > 0;
  $('#dropzone').hidden = S.items.length > 0;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function removeItem(id) {
  const idx = S.items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [item] = S.items.splice(idx, 1);
  if (item.status === 'working') return; // let it finish; it will just not show
  release(item); item.source?.close?.();
  if (S.active === id) {
    S.active = null;
    const next = S.items[Math.min(idx, S.items.length - 1)];
    if (next) activate(next.id);
  }
  renderTray(); updateControls(); redraw();
}

async function activate(id) {
  const prev = activeItem();
  if (prev && prev.id !== id) release(prev);
  S.active = id;
  const item = activeItem();
  if (item) {
    ensureBuilt(item);
    syncEdgeControls(item);
  }
  renderTray();
  S.view.fitted = true;
  fit();
  updateControls();
}

// ---------------------------------------------------------------- view
let dpr = window.devicePixelRatio || 1;
function resizeView() {
  dpr = window.devicePixelRatio || 1;
  const r = stage.getBoundingClientRect();
  view.width = Math.max(1, Math.round(r.width * dpr));
  view.height = Math.max(1, Math.round(r.height * dpr));
  if (S.view.fitted) fit(); else redraw();
}
new ResizeObserver(resizeView).observe(stage);

function contentSize(item) {
  if (S.tab === 'cutout') return { W: item.w, H: item.h };
  const L = layout(item, S.style);
  return { W: L.W, H: L.H };
}

function fit() {
  const item = activeItem();
  if (!item) { redraw(); return; }
  const { W, H } = contentSize(item);
  const r = stage.getBoundingClientRect();
  const m = r.width < 600 ? 16 : 40;
  const z = Math.min((r.width - m * 2) / W, (r.height - m * 2) / H, 4);
  S.view.zoom = Math.max(0.02, z);
  S.view.panX = (r.width - W * S.view.zoom) / 2;
  S.view.panY = (r.height - H * S.view.zoom) / 2;
  S.view.fitted = true;
  redraw();
}
function fitIfNeeded() { if (S.view.fitted) fit(); }

function zoomAt(factor, sx, sy) {
  const v = S.view;
  const nz = Math.min(32, Math.max(0.02, v.zoom * factor));
  v.panX = sx - ((sx - v.panX) * nz) / v.zoom;
  v.panY = sy - ((sy - v.panY) * nz) / v.zoom;
  v.zoom = nz;
  v.fitted = false;
  redraw();
}

let checker;
function checkerPattern() {
  if (checker) return checker;
  const c = makeCanvas(16, 16);
  const x = c.getContext('2d');
  x.fillStyle = '#f4f6f2'; x.fillRect(0, 0, 16, 16);
  x.fillStyle = '#d9ddd6'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
  checker = vctx.createPattern(c, 'repeat');
  return checker;
}

let drawQueued = false;
function redraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  const item = activeItem();
  $('#zoom-label').textContent = `${Math.round(S.view.zoom * 100)}%`;
  if (!item) return;
  const { zoom, panX, panY } = S.view;
  const { W, H } = contentSize(item);
  const t = [dpr * zoom, 0, 0, dpr * zoom, dpr * panX, dpr * panY];

  // board shadow + checkerboard
  vctx.setTransform(...t);
  vctx.save();
  vctx.shadowColor = 'rgba(0,0,0,.35)';
  vctx.shadowBlur = 18 * dpr;
  vctx.shadowOffsetY = 4 * dpr;
  const pat = checkerPattern();
  pat.setTransform(new DOMMatrix().scale(1 / zoom));
  vctx.fillStyle = pat;
  vctx.fillRect(0, 0, W, H);
  vctx.restore();
  vctx.imageSmoothingEnabled = zoom < 2;
  vctx.imageSmoothingQuality = 'high';

  if (S.tab === 'cutout') {
    if (S.comparing || !item.cutout) {
      vctx.drawImage(item.source, 0, 0, W, H);
    } else {
      if (S.showRemoved) {
        vctx.globalAlpha = 0.55;
        vctx.drawImage(redTint(item), 0, 0, W, H);
        vctx.globalAlpha = 1;
      }
      vctx.drawImage(item.cutout, 0, 0, W, H);
    }
  } else {
    const k = Math.min(1, zoom * dpr);
    const key = `${item.cutoutVersion}|${k.toFixed(3)}|${JSON.stringify(S.style)}|${S.bgImage ? S.bgImage.id : 0}|${S.comparing}`;
    if (item._compKey !== key || !item._comp) {
      const c = makeCanvas(W * k, H * k);
      const cx = c.getContext('2d');
      if (S.comparing) compositeOriginal(cx, item, S.style, k);
      else composite(cx, item, S.style, k, { bgImage: S.bgImage?.bmp });
      item._comp = c; item._compKey = key;
    }
    vctx.drawImage(item._comp, 0, 0, W, H);
  }
}

function redTint(item) {
  if (item._red) return item._red;
  const c = makeCanvas(item.w, item.h);
  const x = c.getContext('2d');
  x.drawImage(item.source, 0, 0);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = 'rgba(214, 40, 20, 0.55)';
  x.fillRect(0, 0, c.width, c.height);
  item._red = c;
  return c;
}

// ---------------------------------------------------------------- pointer: pan, zoom, brush, wand
const pointers = new Map();
let gesture = null;

function toImage(sx, sy) {
  return { x: (sx - S.view.panX) / S.view.zoom, y: (sy - S.view.panY) / S.view.zoom };
}
function localPoint(e) {
  const r = stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
const isBrush = () => S.tab === 'cutout' && (S.tool === 'erase' || S.tool === 'restore');
const isWand = () => S.tab === 'cutout' && S.tool.startsWith('wand');

function updateStageCursor() {
  stage.classList.toggle('tool-pan', !isBrush() && !isWand());
  stage.classList.toggle('tool-brush', isBrush());
  stage.classList.toggle('tool-wand', isWand());
  if (!isBrush()) cursorEl.hidden = true;
}

view.addEventListener('pointerdown', (e) => {
  const item = activeItem();
  if (!item) return;
  view.setPointerCapture(e.pointerId);
  const p = localPoint(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2) {
    if (gesture?.type === 'stroke') endStroke(item);
    const [a, b] = [...pointers.values()];
    gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    return;
  }
  if (e.button === 1 || e.button === 2 || e.altKey || (!isBrush() && !isWand())) {
    gesture = { type: 'pan', x: p.x, y: p.y };
    stage.classList.add('dragging');
    return;
  }
  if (isWand()) {
    const ip = toImage(p.x, p.y);
    applyWand(item, Math.floor(ip.x), Math.floor(ip.y));
    gesture = null;
    return;
  }
  if (isBrush()) {
    startStroke(item);
    const ip = toImage(p.x, p.y);
    gesture = { type: 'stroke', last: ip };
    dab(item, ip.x, ip.y);
    flushStroke(item);
  }
});

view.addEventListener('pointermove', (e) => {
  const p = localPoint(e);
  if (isBrush()) {
    const size = S.brush.size;
    cursorEl.hidden = false;
    cursorEl.style.left = `${p.x}px`; cursorEl.style.top = `${p.y}px`;
    cursorEl.style.width = cursorEl.style.height = `${size}px`;
    cursorEl.classList.toggle('erase', S.tool === 'erase');
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, p);
  const item = activeItem();
  if (!gesture || !item) return;
  if (gesture.type === 'pan') {
    S.view.panX += p.x - gesture.x; S.view.panY += p.y - gesture.y;
    gesture.x = p.x; gesture.y = p.y;
    S.view.fitted = false;
    redraw();
  } else if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    S.view.panX += mid.x - gesture.mid.x; S.view.panY += mid.y - gesture.mid.y;
    zoomAt(dist / gesture.dist, mid.x, mid.y);
    gesture.dist = dist; gesture.mid = mid;
  } else if (gesture.type === 'stroke') {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const r = stage.getBoundingClientRect();
    for (const ev of events) {
      const ip = toImage(ev.clientX - r.left, ev.clientY - r.top);
      strokeTo(item, gesture.last, ip);
      gesture.last = ip;
    }
    flushStroke(item);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  const item = activeItem();
  if (gesture?.type === 'stroke' && item) endStroke(item);
  if (pointers.size === 0) { gesture = null; stage.classList.remove('dragging'); }
}
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);
view.addEventListener('pointerleave', () => { cursorEl.hidden = true; });
view.addEventListener('contextmenu', (e) => e.preventDefault());

view.addEventListener('wheel', (e) => {
  if (!activeItem()) return;
  e.preventDefault();
  const p = localPoint(e);
  if (e.ctrlKey || e.metaKey || !e.shiftKey) {
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  } else {
    S.view.panX -= e.deltaY; S.view.fitted = false; redraw();
  }
}, { passive: false });

// --- brush strokes: coverage buffer per stroke so soft edges don't build up
function startStroke(item) {
  ensureMask(item);
  if (!item._cutData) rebuild(item);
  pushUndo(item);
  item._snap = item.mask.slice();
  if (!item._cov || item._cov.length !== item.mask.length) item._cov = new Uint8Array(item.mask.length);
  else item._cov.fill(0);
  item._dirty = null;
}

function strokeTo(item, a, b) {
  const r = S.brush.size / 2 / S.view.zoom;
  const step = Math.max(0.75, r * 0.2);
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d / step));
  for (let i = 1; i <= n; i++) dab(item, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
}

function dab(item, cx, cy) {
  const { w, h, mask, _snap: snap, _cov: cov, _cutData: cut } = item;
  const r = Math.max(0.5, S.brush.size / 2 / S.view.zoom);
  const hard = 1 - S.brush.soft / 100;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  if (x0 > x1 || y0 > y1) return;
  const erase = S.tool === 'erase';
  const cd = cut?.data;
  const src = cd ? getRGBA(item) : null;
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / r;
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= 1) continue;
      let f = dist <= hard ? 1 : 1 - (dist - hard) / (1 - hard);
      f = f * f * (3 - 2 * f);
      const c = (f * 255) | 0;
      const p = y * w + x;
      if (c <= cov[p]) continue;
      cov[p] = c;
      const s = snap[p];
      const v = erase ? (s * (255 - c)) / 255 : s + ((255 - s) * c) / 255;
      mask[p] = v;
      if (cd) cd[p * 4 + 3] = Math.min(src[p * 4 + 3], v);
    }
  }
  const dr = item._dirty;
  item._dirty = dr
    ? { x0: Math.min(dr.x0, x0), y0: Math.min(dr.y0, y0), x1: Math.max(dr.x1, x1), y1: Math.max(dr.y1, y1) }
    : { x0, y0, x1, y1 };
}

function flushStroke(item) {
  const d = item._dirty;
  if (!d || !item.cutout) return;
  item.cutout.getContext('2d').putImageData(item._cutData, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
  item._dirty = null;
  item.cutoutVersion++;
  redraw();
}

function endStroke(item) {
  gesture = null;
  item._snap = null;
  if (!isDefaultEdges(item.edges) || item.edges.decontam) scheduleRebuild(item);
  else { computeBounds(item); refreshThumb(item); updateControls(); }
}

function applyWand(item, x, y) {
  if (x < 0 || y < 0 || x >= item.w || y >= item.h) return;
  ensureMask(item);
  pushUndo(item);
  const sel = colorSelect(getRGBA(item), item.w, item.h, x, y, S.wand.tol, S.wand.contig);
  const soft = softenSelection(sel, item.w, item.h);
  const m = item.mask;
  if (S.tool === 'wand-erase') for (let i = 0; i < m.length; i++) m[i] = (m[i] * (255 - soft[i])) / 255;
  else for (let i = 0; i < m.length; i++) m[i] = Math.max(m[i], soft[i]);
  rebuild(item); refreshThumb(item); redraw(); updateControls();
}

// ---------------------------------------------------------------- controls
function setTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((t) => { const on = t.dataset.tab === tab; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on); });
  $$('.tabpanel').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === tab));
  updateStageCursor();
  S.view.fitted = true;
  fit();
  updateControls();
}

function setTool(tool) {
  S.tool = tool;
  $$('.tool').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
  $$('[data-show-for]').forEach((el) => {
    const list = el.dataset.showFor.split(' ');
    el.hidden = !list.includes(tool);
  });
  updateStageCursor();
}

function updateControls() {
  const item = activeItem();
  const has = !!item;
  const anyNew = S.items.some((i) => i.status === 'new' || i.status === 'error');
  $('#btn-remove').disabled = !has || running;
  $('#btn-remove').textContent = item?.status === 'done' ? 'Run again' : running ? 'Working…' : 'Remove background';
  $('#btn-remove-all').disabled = running || !anyNew || S.items.length < 2;
  $('#btn-export').disabled = !has;
  $('#btn-dl-one').disabled = !has;
  $('#btn-copy').disabled = !has || !window.ClipboardItem;
  $('#btn-dl-all').disabled = S.items.length < 2;
  $('#btn-dl-mask').disabled = !item?.mask;
  $('#btn-invert').disabled = !has;
  $('#btn-reset-mask').disabled = !item?.mask;
  $('#btn-undo').disabled = !item?.undo.length;
  $('#btn-redo').disabled = !item?.redo.length;

  const size = S.style.size;
  $('#custom-size').hidden = size !== 'custom';
  const pg = $('#placement-group');
  const free = size !== 'original' && size !== 'subject';
  $('#pad').closest('.field').hidden = size === 'original';
  $('#align').hidden = !free;
  for (const id of ['sub-scale', 'sub-x', 'sub-y']) $('#' + id).closest('.field').hidden = !free;
  pg.querySelector('h2').textContent = size === 'original' ? 'Subject' : 'Subject placement';

  const f = S.out.fmt;
  $('#quality-field').hidden = f === 'png';
  $('#jpg-note').hidden = f !== 'jpeg' || S.style.bg.type !== 'none';
  if (item) {
    const L = layout(item, S.style);
    $('#export-dims').textContent = `${L.W} × ${L.H} px`;
  } else $('#export-dims').textContent = '';
}

/** Wire a range input to a getter/setter; keeps the <output> in sync. */
function bindRange(id, get, set, after) {
  const el = $('#' + id);
  const out = el.parentElement.querySelector('output');
  const show = () => { if (out) out.textContent = el.value; };
  el.value = get(); show();
  el.addEventListener('input', () => { set(+el.value); show(); after?.(); });
  el._sync = () => { el.value = get(); show(); };
}
function bindColor(id, get, set, after) {
  const el = $('#' + id);
  el.value = get();
  el.addEventListener('input', () => { set(el.value); after?.(); });
  el._sync = () => { el.value = get(); };
}
function bindCheck(id, get, set, after) {
  const el = $('#' + id);
  el.checked = get();
  el.addEventListener('change', () => { set(el.checked); after?.(); });
  el._sync = () => { el.checked = get(); };
}
function bindChips(containerId, attr, get, set, after) {
  const box = $('#' + containerId);
  const sync = () => $$('.chip', box).forEach((c) => c.classList.toggle('is-active', c.dataset[attr] === get()));
  box.addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    set(c.dataset[attr]); sync(); after?.();
  });
  sync();
  box._sync = sync;
}

const styleChanged = () => { persist(); updateControls(); if (S.tab !== 'cutout') { if (S.view.fitted) fit(); else redraw(); } };
const st = S.style;

// cutout tab
$('#model-select').value = S.model;
$('#model-select').addEventListener('change', (e) => { S.model = e.target.value; persist(); });
$('#btn-remove').addEventListener('click', () => { const it = activeItem(); if (it) removeBackgrounds([it]); });
$('#btn-remove-all').addEventListener('click', () => removeBackgrounds(S.items.filter((i) => i.status === 'new' || i.status === 'error')));
$$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
bindRange('brush-size', () => S.brush.size, (v) => { S.brush.size = v; });
bindRange('brush-soft', () => S.brush.soft, (v) => { S.brush.soft = v; });
bindRange('wand-tol', () => S.wand.tol, (v) => { S.wand.tol = v; });
bindCheck('wand-contig', () => S.wand.contig, (v) => { S.wand.contig = v; });
bindCheck('show-removed', () => S.showRemoved, (v) => { S.showRemoved = v; }, redraw);
$('#btn-invert').addEventListener('click', () => {
  const it = activeItem(); if (!it) return;
  ensureMask(it); pushUndo(it);
  for (let i = 0; i < it.mask.length; i++) it.mask[i] = 255 - it.mask[i];
  rebuild(it); refreshThumb(it); redraw(); updateControls();
});
$('#btn-reset-mask').addEventListener('click', () => {
  const it = activeItem(); if (!it?.mask) return;
  pushUndo(it);
  it.mask = it.aiMask ? it.aiMask.slice() : null;
  rebuild(it); refreshThumb(it); redraw(); updateControls();
});

const edgeIds = { 'edge-feather': 'feather', 'edge-shift': 'shift', 'edge-firm': 'firm', 'edge-clean': 'clean' };
for (const [id, key] of Object.entries(edgeIds)) {
  bindRange(id, () => activeItem()?.edges[key] ?? DEFAULT_EDGES[key], (v) => { const it = activeItem(); if (it) it.edges[key] = v; },
    () => { const it = activeItem(); if (it?.mask) scheduleRebuild(it); });
}
bindCheck('edge-decontam', () => activeItem()?.edges.decontam ?? false, (v) => { const it = activeItem(); if (it) it.edges.decontam = v; },
  () => { const it = activeItem(); if (it?.mask) scheduleRebuild(it); });
function syncEdgeControls() {
  for (const id of [...Object.keys(edgeIds), 'edge-decontam']) $('#' + id)._sync();
}

// background tab
const SWATCHES = ['#ffffff', '#f3f4f6', '#111111', '#fef3c7', '#fde2e4', '#dbeafe', '#dcfce7', '#ede9fe',
  '#f2c230', '#ef4444', '#f97316', '#22c55e', '#0ea5e9', '#6366f1', '#a855f7', '#ec4899'];
const GRADS = [['#fde68a', '#f472b6'], ['#a5f3fc', '#818cf8'], ['#bbf7d0', '#22d3ee'], ['#fecaca', '#fde68a'],
  ['#e0e7ff', '#fbcfe8'], ['#f5f5f4', '#d6d3d1'], ['#1e293b', '#0f172a'], ['#fb923c', '#9333ea']];
function buildSwatches() {
  const box = $('#swatches');
  box.innerHTML = SWATCHES.map((c) => `<button class="swatch" style="background:${c}" data-c="${c}" aria-label="${c}"></button>`).join('');
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    st.bg.color = b.dataset.c; $('#bg-color').value = b.dataset.c; syncSwatches(); styleChanged();
  });
  const gbox = $('#grad-swatches');
  gbox.innerHTML = GRADS.map(([a, b]) => `<button class="swatch" style="background:linear-gradient(135deg,${a},${b})" data-a="${a}" data-b="${b}" aria-label="Gradient ${a} to ${b}"></button>`).join('');
  gbox.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch'); if (!b) return;
    st.bg.from = b.dataset.a; st.bg.to = b.dataset.b;
    $('#grad-a').value = st.bg.from; $('#grad-b').value = st.bg.to; syncSwatches(); styleChanged();
  });
  syncSwatches();
}
function syncSwatches() {
  $$('#swatches .swatch').forEach((s) => s.classList.toggle('is-active', s.dataset.c === st.bg.color));
  $$('#grad-swatches .swatch').forEach((s) => s.classList.toggle('is-active', s.dataset.a === st.bg.from && s.dataset.b === st.bg.to));
}
buildSwatches();
function syncBgPanels() {
  $$('[data-bg-for]').forEach((el) => { el.hidden = el.dataset.bgFor !== st.bg.type; });
}
bindChips('bg-type', 'bg', () => st.bg.type, (v) => { st.bg.type = v; }, () => {
  syncBgPanels();
  if (st.bg.type === 'image' && !S.bgImage) $('#bg-image').click();
  styleChanged();
});
syncBgPanels();
bindColor('bg-color', () => st.bg.color, (v) => { st.bg.color = v; syncSwatches(); }, styleChanged);
bindColor('grad-a', () => st.bg.from, (v) => { st.bg.from = v; syncSwatches(); }, styleChanged);
bindColor('grad-b', () => st.bg.to, (v) => { st.bg.to = v; syncSwatches(); }, styleChanged);
bindRange('grad-angle', () => st.bg.angle, (v) => { st.bg.angle = v; }, styleChanged);
bindCheck('grad-radial', () => st.bg.radial, (v) => { st.bg.radial = v; }, styleChanged);
bindRange('bg-image-blur', () => st.bg.imageBlur, (v) => { st.bg.imageBlur = v; }, styleChanged);
bindRange('bg-image-dim', () => st.bg.imageDim, (v) => { st.bg.imageDim = v; }, styleChanged);
bindRange('bg-blur', () => st.bg.blur, (v) => { st.bg.blur = v; }, styleChanged);
bindRange('bg-blur-dim', () => st.bg.blurDim, (v) => { st.bg.blurDim = v; }, styleChanged);
bindCheck('bg-blur-bw', () => st.bg.bw, (v) => { st.bg.bw = v; }, styleChanged);
$('#bg-image').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    S.bgImage?.bmp.close?.();
    S.bgImage = { bmp, id: Date.now() };
    st.bg.type = 'image'; $('#bg-type')._sync(); syncBgPanels(); styleChanged();
  } catch { toast('That photo couldn\'t be opened.', true); }
});

// effects tab
function syncShadowOpts() { $('#shadow-opts').hidden = st.fx.shadow === 'none'; }
bindChips('shadow-type', 'shadow', () => st.fx.shadow, (v) => {
  st.fx.shadow = v;
  // sensible starting points per shadow style
  if (v === 'soft') Object.assign(st.fx, { shBlur: 30, shX: 0, shY: 18 });
  if (v === 'hard') Object.assign(st.fx, { shBlur: 20, shX: 12, shY: 12 });
  if (v === 'ground') Object.assign(st.fx, { shBlur: 40, shX: 0, shY: 0 });
  ['sh-blur', 'sh-x', 'sh-y'].forEach((id) => $('#' + id)._sync());
}, () => { syncShadowOpts(); styleChanged(); });
syncShadowOpts();
bindRange('sh-opacity', () => st.fx.shOpacity, (v) => { st.fx.shOpacity = v; }, styleChanged);
bindRange('sh-blur', () => st.fx.shBlur, (v) => { st.fx.shBlur = v; }, styleChanged);
bindRange('sh-x', () => st.fx.shX, (v) => { st.fx.shX = v; }, styleChanged);
bindRange('sh-y', () => st.fx.shY, (v) => { st.fx.shY = v; }, styleChanged);
bindColor('sh-color', () => st.fx.shColor, (v) => { st.fx.shColor = v; }, styleChanged);
bindRange('refl', () => st.fx.refl, (v) => { st.fx.refl = v; }, styleChanged);
bindRange('ol-size', () => st.fx.olSize, (v) => { st.fx.olSize = v; }, styleChanged);
bindColor('ol-color', () => st.fx.olColor, (v) => { st.fx.olColor = v; }, styleChanged);
const adjIds = { 'adj-bright': 'bright', 'adj-contrast': 'contrast', 'adj-sat': 'sat', 'adj-warm': 'warm' };
for (const [id, key] of Object.entries(adjIds)) bindRange(id, () => st.adj[key], (v) => { st.adj[key] = v; }, styleChanged);
$('#btn-adj-reset').addEventListener('click', () => {
  Object.assign(st.adj, DEFAULT_STYLE.adj);
  Object.keys(adjIds).forEach((id) => $('#' + id)._sync());
  styleChanged();
});

// canvas tab
$('#size-preset').value = st.size;
$('#size-preset').addEventListener('change', (e) => { st.size = e.target.value; S.view.fitted = true; styleChanged(); });
$('#custom-w').value = st.customW; $('#custom-h').value = st.customH;
$('#custom-w').addEventListener('change', (e) => { st.customW = +e.target.value; S.view.fitted = true; styleChanged(); });
$('#custom-h').addEventListener('change', (e) => { st.customH = +e.target.value; S.view.fitted = true; styleChanged(); });
bindRange('pad', () => st.pad, (v) => { st.pad = v; }, () => { S.view.fitted = st.size === 'subject' || S.view.fitted; styleChanged(); });
bindChips('align', 'align', () => st.align, (v) => { st.align = v; }, styleChanged);
bindRange('sub-scale', () => st.scale, (v) => { st.scale = v; }, styleChanged);
bindRange('sub-x', () => st.nudgeX, (v) => { st.nudgeX = v; }, styleChanged);
bindRange('sub-y', () => st.nudgeY, (v) => { st.nudgeY = v; }, styleChanged);
$('#btn-flip').addEventListener('click', () => { st.flip = !st.flip; styleChanged(); });
$('#btn-place-reset').addEventListener('click', () => {
  Object.assign(st, { scale: 100, nudgeX: 0, nudgeY: 0, flip: false, align: 'center', pad: 8 });
  ['sub-scale', 'sub-x', 'sub-y', 'pad'].forEach((id) => $('#' + id)._sync());
  $('#align')._sync();
  styleChanged();
});

// export tab
bindChips('fmt', 'fmt', () => S.out.fmt, (v) => { S.out.fmt = v; }, () => { persist(); updateControls(); });
bindRange('quality', () => S.out.quality, (v) => { S.out.quality = v; }, persist);
$('#suffix').value = S.out.suffix;
$('#suffix').addEventListener('input', (e) => { S.out.suffix = e.target.value; persist(); });

// ---------------------------------------------------------------- export
const EXT = { png: 'png', webp: 'webp', jpeg: 'jpg' };

async function renderBlob(item, fmt = S.out.fmt) {
  const built = !item.cutout && item.mask;
  ensureBuilt(item);
  const L = layout(item, S.style);
  const c = makeCanvas(L.W, L.H);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const opaque = fmt === 'jpeg' && st.bg.type === 'none' ? '#ffffff' : null;
  composite(ctx, item, S.style, 1, { bgImage: S.bgImage?.bmp, opaqueFill: opaque });
  if (built && item.id !== S.active) release(item);
  const blob = await new Promise((res) => c.toBlob(res, `image/${fmt}`, fmt === 'png' ? undefined : S.out.quality / 100));
  if (!blob) throw new Error('This browser couldn\'t encode the image. Try PNG.');
  return blob;
}

function fileName(item, ext) { return `${item.name}${S.out.suffix || ''}.${ext}`; }

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function downloadActive() {
  const item = activeItem(); if (!item) return;
  try {
    const blob = await renderBlob(item);
    download(blob, fileName(item, EXT[S.out.fmt]));
    toast(item.mask ? 'Downloaded' : 'Downloaded — background wasn\'t removed yet');
  } catch (err) { toast(err.message, true); }
}

async function downloadAll() {
  if (!window.JSZip) { toast('ZIP support is still loading — try again in a second.', true); return; }
  const unprocessed = S.items.filter((i) => !i.mask && i.status !== 'working');
  if (unprocessed.length) await removeBackgrounds(unprocessed);
  const zip = new window.JSZip();
  const used = new Set();
  setBusy('Packing ZIP', '', 0);
  for (let n = 0; n < S.items.length; n++) {
    const item = S.items[n];
    let name = fileName(item, EXT[S.out.fmt]);
    for (let k = 2; used.has(name); k++) name = `${item.name}${S.out.suffix}-${k}.${EXT[S.out.fmt]}`;
    used.add(name);
    zip.file(name, await renderBlob(item));
    setBusy('Packing ZIP', `${n + 1} of ${S.items.length}`, ((n + 1) / S.items.length) * 100);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  setBusy(null);
  download(blob, `cutouts-${new Date().toISOString().slice(0, 10)}.zip`);
  toast(`Downloaded ${S.items.length} images`);
}

async function copyActive() {
  const item = activeItem(); if (!item) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderBlob(item, 'png') })]);
    toast('Copied — paste it anywhere');
  } catch (err) {
    console.error(err);
    toast('Copy was blocked by the browser. Use Download instead.', true);
  }
}

async function downloadMask() {
  const item = activeItem(); if (!item?.mask) return;
  ensureBuilt(item);
  const p = item.processed;
  const data = new ImageData(item.w, item.h);
  for (let i = 0, j = 0; i < p.length; i++, j += 4) { data.data[j] = data.data[j + 1] = data.data[j + 2] = p[i]; data.data[j + 3] = 255; }
  const c = makeCanvas(item.w, item.h);
  c.getContext('2d').putImageData(data, 0, 0);
  c.toBlob((b) => download(b, `${item.name}-mask.png`), 'image/png');
}

$('#btn-export').addEventListener('click', downloadActive);
$('#btn-dl-one').addEventListener('click', downloadActive);
$('#btn-dl-all').addEventListener('click', downloadAll);
$('#btn-copy').addEventListener('click', copyActive);
$('#btn-dl-mask').addEventListener('click', downloadMask);

// ---------------------------------------------------------------- misc wiring
$$('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);
$('#btn-zoom-in').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); });
$('#btn-zoom-out').addEventListener('click', () => { const r = stage.getBoundingClientRect(); zoomAt(0.8, r.width / 2, r.height / 2); });
$('#btn-zoom-fit').addEventListener('click', fit);

const compareBtn = $('#btn-compare');
const setCompare = (on) => { if (S.comparing === on) return; S.comparing = on; redraw(); };
compareBtn.addEventListener('pointerdown', () => setCompare(true));
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => compareBtn.addEventListener(ev, () => setCompare(false)));

for (const id of ['#file-input', '#file-input-2']) {
  $(id).addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
}
$('#btn-sample').addEventListener('click', async () => {
  const blob = await makeSampleImage();
  const item = await createItem(blob, 'sample-mug');
  S.items.push(item);
  renderTray();
  await activate(item.id);
});

// drag & drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropzone').classList.add('is-over'); $('#dropzone').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.remove('is-over'); $('#dropzone').hidden = S.items.length > 0; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0;
  $('#dropzone').classList.remove('is-over');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  else $('#dropzone').hidden = S.items.length > 0;
});
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); addFiles(files.map((f, n) => new File([f], `pasted-${Date.now()}-${n}.png`, { type: f.type }))); }
});

// keyboard
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' && !['range', 'checkbox'].includes(document.activeElement.type)) return;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); downloadActive(); return; }
  if (mod) return;
  if (e.key === ' ' && !e.repeat && activeItem()) { e.preventDefault(); setCompare(true); return; }
  const k = e.key.toLowerCase();
  const tools = { h: 'pan', e: 'erase', r: 'restore', w: 'wand-erase', k: 'wand-keep' };
  if (tools[k]) { if (S.tab !== 'cutout') setTab('cutout'); setTool(tools[k]); return; }
  if (k === '[' || k === ']') {
    S.brush.size = Math.max(2, Math.min(400, Math.round(S.brush.size * (k === ']' ? 1.2 : 1 / 1.2))));
    $('#brush-size')._sync();
    return;
  }
  if (k === '0') fit();
  if (k === '=' || k === '+') $('#btn-zoom-in').click();
  if (k === '-') $('#btn-zoom-out').click();
  if (k === 'arrowdown' || k === 'arrowup') {
    const idx = S.items.findIndex((i) => i.id === S.active);
    const next = S.items[idx + (k === 'arrowdown' ? 1 : -1)];
    if (next) { e.preventDefault(); activate(next.id); }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') setCompare(false); });
window.addEventListener('blur', () => setCompare(false));

// offline support
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

setTool('pan');
setTab('cutout');
renderTray();
updateControls();

// handy for debugging from the console
window.__cutout = { S, rebuild, activeItem, upscaleMask };
