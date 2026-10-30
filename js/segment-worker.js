// Runs the background-removal model off the main thread so the editor never freezes.
// Models are fetched from the Hugging Face Hub once, then served from the browser cache.
import {
  pipeline, AutoModel, ImageProcessor, env, RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

// kind 'pipeline': loaded through the background-removal pipeline.
// kind 'rmbg': ISNet-style model loaded directly with its own preprocessing (small and memory-friendly).
const MODELS = {
  fast: {
    id: 'briaai/RMBG-1.4', label: 'Fast', kind: 'rmbg',
    // Quantized on CPU (44 MB, low memory); full precision on GPU.
    dtype: { webgpu: 'fp32', wasm: 'q8' },
  },
  general: { id: 'onnx-community/BiRefNet_lite-ONNX', label: 'Sharp edges', kind: 'pipeline', dtype: { webgpu: 'fp32', wasm: 'fp32' } },
  best: { id: 'onnx-community/BEN2-ONNX', label: 'Hair & fur', kind: 'pipeline', dtype: { webgpu: 'fp32', wasm: 'fp32' } },
  portrait: { id: 'Xenova/modnet', label: 'People', kind: 'pipeline', dtype: { webgpu: 'fp32', wasm: 'fp32' } },
};

const RMBG_PREPROCESS = {
  do_normalize: true,
  do_pad: false,
  do_rescale: true,
  do_resize: true,
  image_mean: [0.5, 0.5, 0.5],
  image_std: [1, 1, 1],
  resample: 2,
  rescale_factor: 1 / 255,
  size: { width: 1024, height: 1024 },
};

let current = { key: null, run: null, dispose: null, device: null };
let gpuOk = null;
// Models that failed on this GPU (e.g. shader limits on integrated graphics) skip WebGPU.
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

/** Each loader returns { run(image: RawImage) => {data: Uint8ClampedArray, width, height}, dispose() }. */
async function loadPipeline(model, device, key) {
  const seg = await pipeline('image-segmentation', model.id, {
    device, dtype: model.dtype[device], progress_callback: progressRelay(key),
  });
  return {
    dispose: () => seg.dispose?.(),
    async run(image) {
      const out = await seg(image);
      const result = Array.isArray(out) ? out[0] : out;
      const mask = result.mask ?? result;
      let data = mask.data;
      if (mask.channels > 1) {
        const single = new Uint8ClampedArray(mask.width * mask.height);
        for (let i = 0, j = 0; j < single.length; i += mask.channels, j++) single[j] = data[i];
        data = single;
      }
      return { data: new Uint8ClampedArray(data), width: mask.width, height: mask.height };
    },
  };
}

async function loadRmbg(model, device, key) {
  const net = await AutoModel.from_pretrained(model.id, {
    device, dtype: model.dtype[device],
    config: { model_type: 'custom' },
    progress_callback: progressRelay(key),
  });
  const processor = new ImageProcessor(RMBG_PREPROCESS);
  return {
    dispose: () => net.dispose?.(),
    async run(image) {
      const { pixel_values } = await processor(image);
      const outputs = await net({ input: pixel_values });
      const t = outputs.output ?? Object.values(outputs)[0];
      const [, , h, w] = t.dims;
      const src = t.data;
      // Stretch to the full 0..1 range, as in the reference implementation.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < src.length; i++) { const v = src[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const scale = hi - lo > 1e-6 ? 255 / (hi - lo) : 255;
      const data = new Uint8ClampedArray(w * h);
      for (let i = 0; i < data.length; i++) data[i] = (src[i] - lo) * scale;
      t.dispose?.();
      return { data, width: w, height: h };
    },
  };
}

async function load(key) {
  if (current.key === key && current.run) return current;
  const model = MODELS[key];
  if (!model) throw new Error(`Unknown model "${key}"`);
  if (current.dispose) { try { await current.dispose(); } catch {} }
  current = { key: null, run: null, dispose: null, device: null };

  const devices = [];
  if (!noGpu.has(key) && (await hasWebGPU())) devices.push('webgpu');
  devices.push('wasm');

  let lastErr;
  for (const device of devices) {
    try {
      self.postMessage({ type: 'status', key, text: `Loading ${model.label} model (${device === 'webgpu' ? 'GPU' : 'CPU'})` });
      const loader = model.kind === 'rmbg' ? loadRmbg : loadPipeline;
      const m = await loader(model, device, key);
      current = { key, run: m.run, dispose: m.dispose, device };
      self.postMessage({ type: 'ready', key, device });
      return current;
    } catch (err) {
      lastErr = err;
      console.warn(`[cutout] ${model.id} on ${device} failed to load`, err);
    }
  }
  throw tag(lastErr, devices[devices.length - 1]);
}

const MEMORY_RE = /bad_alloc|out of memory|Array buffer allocation|memory access out of bounds|Aborted\(|could not allocate/i;
/** Prefix errors so the app can tell GPU trouble and memory trouble apart from everything else. */
function tag(err, device) {
  const msg = String(err?.message || err);
  if (device === 'webgpu') return new Error(`[webgpu] ${msg}`);
  if (MEMORY_RE.test(msg)) return new Error(`[memory] ${msg}`);
  return new Error(msg);
}

async function run({ id, key, bitmap, skipGpu }) {
  for (const k of skipGpu || []) noGpu.add(k);
  const { run: infer, device } = await load(key);
  self.postMessage({ type: 'status', key, id, text: device === 'wasm' ? 'Finding the subject (CPU, may take a bit)' : 'Finding the subject' });

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
  let mask;
  try {
    mask = await infer(image);
  } catch (err) {
    throw tag(err, device);
  }
  const buf = mask.data.buffer;
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
