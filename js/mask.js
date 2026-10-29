// Mask math. A mask is a Uint8ClampedArray of w*h alpha values (0 = removed, 255 = kept).

/** Sliding-window max (grow) or min (shrink) along rows then columns. O(n) per pass via monotonic deque. */
export function morph(src, w, h, radius, grow) {
  if (radius <= 0) return src;
  const r = Math.round(radius);
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  const cmp = grow ? (a, b) => a >= b : (a, b) => a <= b;
  const len = Math.max(w, h);
  const dq = new Int32Array(len + 2 * r + 2);
  const line = new Uint8ClampedArray(len);

  const pass = (input, output, n, count, stride, step) => {
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      for (let i = 0; i < n; i++) line[i] = input[base + i * step];
      let head = 0, tail = 0;
      // window for index i is [i-r, i+r]
      let next = 0;
      for (let i = 0; i < n; i++) {
        const hi = Math.min(n - 1, i + r);
        while (next <= hi) {
          const v = line[next];
          while (tail > head && cmp(v, line[dq[tail - 1]])) tail--;
          dq[tail++] = next++;
        }
        while (dq[head] < i - r) head++;
        output[base + i * step] = line[dq[head]];
      }
    }
  };
  pass(src, tmp, w, h, w, 1);   // rows
  pass(tmp, out, h, w, 1, w);   // columns
  return out;
}

/** Approximate Gaussian blur with three box blurs (separable running sums). */
export function blurMask(src, w, h, sigma) {
  if (sigma <= 0) return src;
  const boxes = boxSizes(sigma, 3);
  let a = new Float32Array(src);
  let b = new Float32Array(src.length);
  for (const size of boxes) {
    const r = (size - 1) >> 1;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i];
  return out;
}

function boxSizes(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}
function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r - 1; x < r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      acc += src[row + Math.min(w - 1, x + r)] - src[row + Math.max(0, x - r - 1)];
      dst[row + x] = acc * iarr;
    }
  }
}
function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r - 1; y < r; y++) acc += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      acc += src[Math.min(h - 1, y + r) * w + x] - src[Math.max(0, y - r - 1) * w + x];
      dst[y * w + x] = acc * iarr;
    }
  }
}

/** Remove disconnected kept regions smaller than minArea pixels (4-connected, threshold 128). */
export function removeSpecks(src, w, h, minArea) {
  if (minArea <= 1) return src;
  const out = new Uint8ClampedArray(src);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const comp = new Int32Array(w * h);
  for (let start = 0; start < src.length; start++) {
    if (seen[start] || src[start] < 128) continue;
    let sp = 0, cn = 0;
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const p = stack[--sp];
      comp[cn++] = p;
      const x = p % w;
      if (x > 0 && !seen[p - 1] && src[p - 1] >= 128) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && src[p + 1] >= 128) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (p >= w && !seen[p - w] && src[p - w] >= 128) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (p < src.length - w && !seen[p + w] && src[p + w] >= 128) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (cn < minArea) {
      for (let i = 0; i < cn; i++) {
        const p = comp[i];
        out[p] = 0;
        // also clear the soft halo right around the speck
        const x = p % w;
        if (x > 0 && src[p - 1] < 128) out[p - 1] = 0;
        if (x < w - 1 && src[p + 1] < 128) out[p + 1] = 0;
        if (p >= w && src[p - w] < 128) out[p - w] = 0;
        if (p < src.length - w && src[p + w] < 128) out[p + w] = 0;
      }
    }
  }
  return out;
}

/** Apply edge settings to a raw mask. Settings: { clean, firm, shift, feather } (slider units). */
export function processMask(raw, w, h, s) {
  let m = raw;
  if (s.clean > 0) {
    const frac = Math.pow(s.clean / 100, 2) * 0.02; // up to 2% of the image
    m = removeSpecks(m, w, h, Math.max(4, Math.round(frac * w * h)));
  }
  if (s.firm > 0) {
    const k = 1 + (s.firm / 100) * 10;
    const out = new Uint8ClampedArray(m.length);
    for (let i = 0; i < m.length; i++) out[i] = (m[i] - 127.5) * k + 127.5;
    m = out;
  }
  const scale = Math.max(w, h) / 1000; // slider px are relative to a 1000px image
  if (s.shift !== 0) m = morph(m, w, h, Math.abs(s.shift) * scale, s.shift > 0);
  if (s.feather > 0) m = blurMask(m, w, h, s.feather * scale * 0.6);
  return m;
}

export function isDefaultEdges(s) {
  return !s.clean && !s.firm && !s.shift && !s.feather;
}

/**
 * Color decontamination: pull the subject's own colors into semi-transparent edge pixels,
 * so a cutout shot on a green wall doesn't keep a green rim.
 */
export function decontaminate(rgba, mask, w, h) {
  const n = w * h;
  const scale = Math.max(1, Math.round(Math.max(w, h) / 500));
  const sigma = 3 * scale;
  const wgt = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) wgt[i] = mask[i] > 235 ? 255 : 0;
  const wb = blurMask(wgt, w, h, sigma);
  const chans = [0, 1, 2].map((c) => {
    const ch = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) ch[i] = wgt[i] ? rgba[i * 4 + c] : 0;
    return blurMask(ch, w, h, sigma);
  });
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < n; i++) {
    const a = mask[i];
    if (a > 5 && a < 250 && wb[i] > 8) {
      const t = 1 - a / 255;
      const inv = 255 / wb[i];
      for (let c = 0; c < 3; c++) {
        const est = Math.min(255, chans[c][i] * inv);
        out[i * 4 + c] = rgba[i * 4 + c] * (1 - t) + est * t;
      }
    }
  }
  return out;
}

/** Select pixels similar to the color at (x, y). Returns Uint8Array(w*h) with 1 = selected. */
export function colorSelect(rgba, w, h, x, y, tolerance, contiguous) {
  const sel = new Uint8Array(w * h);
  const i0 = (y * w + x) * 4;
  const r0 = rgba[i0], g0 = rgba[i0 + 1], b0 = rgba[i0 + 2];
  const t2 = tolerance * tolerance * 3;
  const match = (p) => {
    const k = p * 4;
    const dr = rgba[k] - r0, dg = rgba[k + 1] - g0, db = rgba[k + 2] - b0;
    return dr * dr + dg * dg + db * db <= t2;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (match(p)) sel[p] = 1;
    return sel;
  }
  const stack = new Int32Array(w * h);
  let sp = 0;
  const start = y * w + x;
  stack[sp++] = start; sel[start] = 1;
  while (sp) {
    const p = stack[--sp];
    const px = p % w;
    const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * h - w ? p + w : -1];
    for (const q of nb) if (q >= 0 && !sel[q] && match(q)) { sel[q] = 1; stack[sp++] = q; }
  }
  return sel;
}

/** Grow a selection by 1px and soften it so wand edits blend instead of leaving jaggies. */
export function softenSelection(sel, w, h) {
  const m = new Uint8ClampedArray(sel.length);
  for (let i = 0; i < sel.length; i++) m[i] = sel[i] ? 255 : 0;
  return blurMask(morph(m, w, h, 1, true), w, h, 0.8);
}

/** Bounding box of pixels with alpha above threshold. Returns null when nothing is kept. */
export function maskBounds(mask, w, h, threshold = 12) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
