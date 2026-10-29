// Runs the background-removal model off the main thread so the editor never freezes.
// Models are fetched from the Hugging Face Hub once, then served from the browser cache.
import { pipeline, env, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

export const MODELS = {
  general: { id: 'onnx-community/BiRefNet_lite-ONNX', label: 'Everything' },
  best: { id: 'onnx-community/BEN2-ONNX', label: 'Max detail' },
  portrait: { id: 'Xenova/modnet', label: 'People' },
};

let current = { key: null, seg: null, device: null };
let gpuOk = null;
// Models that failed on this GPU (e.g. shader limits on integrated graphics) run on CPU instead.
const noGpu = new Set();

async function hasWebGPU() {
  if (gpuOk !== null) return gpuOk;
  try {
    gpuOk = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter()));
  } catch { gpuOk = false; }
  return gpuOk;
}

function progressRelay(key) {
  const files = new Map();
  return (p) => {
    if (p.status === 'progress' && p.file) {
      files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      self.postMessage({ type: 'progress', key, loaded, total });
    } else if (p.status === 'initiate' && p.file) {
      self.postMessage({ type: 'status', key, text: `Downloading ${p.file.split('/').pop()}` });
    }
  };
}

async function load(key) {
  if (current.key === key && current.seg) return current;
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown model "${key}"`);
  if (current.seg?.dispose) { try { await current.seg.dispose(); } catch {} }
  current = { key: null, seg: null, device: null };

  const attempts = [];
  if (!noGpu.has(key) && (await hasWebGPU())) attempts.push({ device: 'webgpu', dtype: 'fp32' });
  attempts.push({ device: 'wasm', dtype: 'fp32' });

  let lastErr;
  for (const opts of attempts) {
    try {
      self.postMessage({ type: 'status', key, text: `Loading ${model.label} model (${opts.device === 'webgpu' ? 'GPU' : 'CPU'})` });
      const seg = await pipeline('image-segmentation', model.id, { ...opts, progress_callback: progressRelay(key) });
      current = { key, seg, device: opts.device };
      self.postMessage({ type: 'ready', key, device: opts.device });
      return current;
    } catch (err) {
      lastErr = err;
      console.warn(`[cutout] ${model.id} on ${opts.device} failed, trying next option`, err);
    }
  }
  throw lastErr;
}

async function run({ id, key, bitmap, skipGpu }) {
  for (const k of skipGpu || []) noGpu.add(k);
  let { seg, device } = await load(key);
  self.postMessage({ type: 'status', key, id, text: 'Finding the subject' });

  const { width: w, height: h } = bitmap;
  const oc = new OffscreenCanvas(w, h);
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const rgba = ctx.getImageData(0, 0, w, h).data;
  // Drop alpha: models expect RGB, and transparent PNG input reads as black otherwise.
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = rgba[i] * a + 255 * (1 - a);
    rgb[j + 1] = rgba[i + 1] * a + 255 * (1 - a);
    rgb[j + 2] = rgba[i + 2] * a + 255 * (1 - a);
  }
  const image = new RawImage(rgb, w, h, 3);

  const t0 = performance.now();
  let out;
  try {
    out = await seg(image);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // Loaded on the GPU but couldn't run there — switch this model to CPU and retry once.
    console.warn(`[cutout] ${key} failed on WebGPU, falling back to CPU`, err);
    noGpu.add(key);
    self.postMessage({ type: 'gpu-failed', key });
    current.key = null;
    ({ seg, device } = await load(key));
    self.postMessage({ type: 'status', key, id, text: 'Finding the subject (CPU)' });
    out = await seg(image);
  }
  const result = Array.isArray(out) ? out[0] : out;
  const mask = result.mask ?? result;

  let data = mask.data;
  if (mask.channels > 1) {
    const single = new Uint8ClampedArray(mask.width * mask.height);
    for (let i = 0, j = 0; j < single.length; i += mask.channels, j++) single[j] = data[i];
    data = single;
  }
  const buf = new Uint8ClampedArray(data).buffer;
  self.postMessage(
    { type: 'mask', id, key, width: mask.width, height: mask.height, data: buf, ms: Math.round(performance.now() - t0), device },
    [buf]
  );
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load(msg.key);
    else if (msg.type === 'run') await run(msg);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, key: msg.key, message: String(err?.message || err) });
  }
};
