// Compositing: background, shadow, reflection, outline and subject, at any output scale.
import { maskBounds } from './mask.js?v=5';

const probe = document.createElement('canvas').getContext('2d');
probe.filter = 'blur(2px)';
export const FILTER_OK = probe.filter === 'blur(2px)';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Draw `src` blurred into ctx at (x, y, w, h). Falls back to a downscale blur where ctx.filter is missing (older Safari). */
export function drawBlurred(ctx, src, x, y, w, h, radius, extraFilter = '') {
  if (radius <= 0.3) {
    if (extraFilter && FILTER_OK) { ctx.filter = extraFilter; ctx.drawImage(src, x, y, w, h); ctx.filter = 'none'; }
    else ctx.drawImage(src, x, y, w, h);
    return;
  }
  if (FILTER_OK) {
    ctx.filter = `blur(${radius}px) ${extraFilter}`.trim();
    ctx.drawImage(src, x, y, w, h);
    ctx.filter = 'none';
    return;
  }
  const f = Math.max(1, radius / 2);
  const small = makeCanvas(Math.max(2, w / f), Math.max(2, h / f));
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(src, 0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, x, y, w, h);
}

export function parseSize(style, item) {
  const p = style.size;
  if (p === 'original' || p === 'subject') return null;
  if (p === 'custom') return { W: clampInt(style.customW, 16, 10000), H: clampInt(style.customH, 16, 10000) };
  const [W, H] = p.split('x').map(Number);
  return { W, H };
}
const clampInt = (v, a, b) => Math.min(b, Math.max(a, Math.round(+v || a)));

/**
 * Where the subject lands in the output.
 * Returns { W, H, s, ox, oy, box } where an image pixel (x, y) maps to (ox + x*s, oy + y*s),
 * and box is the subject bounds in output coordinates.
 */
export function layout(item, style) {
  const w = item.w, h = item.h;
  const b = item.bounds || { x: 0, y: 0, w, h };
  const preset = parseSize(style, item);
  let W, H, s, ox, oy;

  if (style.size === 'original') {
    W = w; H = h; s = 1; ox = 0; oy = 0;
  } else if (style.size === 'subject') {
    const pad = Math.round((style.pad / 100) * Math.max(b.w, b.h));
    W = b.w + pad * 2; H = b.h + pad * 2; s = 1;
    ox = pad - b.x; oy = pad - b.y;
  } else {
    ({ W, H } = preset);
    const padX = (style.pad / 100) * W, padY = (style.pad / 100) * H;
    const pad = Math.min(padX, padY);
    const innerW = Math.max(1, W - pad * 2), innerH = Math.max(1, H - pad * 2);
    s = Math.min(innerW / b.w, innerH / b.h) * (style.scale / 100);
    const bw = b.w * s, bh = b.h * s;
    const left = (W - bw) / 2 + (style.nudgeX / 100) * W;
    const top = (style.align === 'bottom' ? H - pad - bh : (H - bh) / 2) + (style.nudgeY / 100) * H;
    ox = left - b.x * s; oy = top - b.y * s;
  }
  const box = { x: ox + b.x * s, y: oy + b.y * s, w: b.w * s, h: b.h * s };
  return { W: Math.round(W), H: Math.round(H), s, ox, oy, box };
}

// ---------- cached layers ----------
function silhouette(item, color) {
  const key = `${item.cutoutVersion}|${color}`;
  item._sil ??= new Map();
  if (item._sil.has(key)) return item._sil.get(key);
  if (item._sil.size > 3) item._sil.clear();
  const c = makeCanvas(item.w, item.h);
  const x = c.getContext('2d');
  x.drawImage(item.cutout, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  item._sil.set(key, c);
  return c;
}

function subjectLayer(item, adj) {
  const plain = !adj.bright && !adj.contrast && !adj.sat && !adj.warm;
  if (plain) return item.cutout;
  const key = `${item.cutoutVersion}|${adj.bright}|${adj.contrast}|${adj.sat}|${adj.warm}`;
  if (item._subjKey === key) return item._subj;
  const c = makeCanvas(item.w, item.h);
  const x = c.getContext('2d');
  if (FILTER_OK && (adj.bright || adj.contrast || adj.sat)) {
    x.filter = `brightness(${1 + adj.bright / 100}) contrast(${1 + adj.contrast / 100}) saturate(${1 + adj.sat / 100})`;
  }
  x.drawImage(item.cutout, 0, 0);
  x.filter = 'none';
  if (adj.warm) {
    x.globalCompositeOperation = 'soft-light';
    x.fillStyle = adj.warm > 0 ? `rgba(255,140,30,${adj.warm / 100 * 0.7})` : `rgba(40,120,255,${-adj.warm / 100 * 0.7})`;
    x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(item.cutout, 0, 0);
  }
  item._subj = c; item._subjKey = key;
  return c;
}

// ---------- background ----------
function drawBackground(ctx, item, style, L, k, bgImage) {
  const { W, H } = L;
  const bg = style.bg;
  if (bg.type === 'color') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'gradient') {
    let g;
    if (bg.radial) {
      g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
    } else {
      const a = ((bg.angle - 90) * Math.PI) / 180;
      const r = (Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))) / 2;
      const cx = W / 2, cy = H / 2;
      g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.addColorStop(0, bg.from);
    g.addColorStop(1, bg.to);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.type === 'image' && bgImage) {
    coverDraw(ctx, bgImage, W, H, bg.imageBlur * Math.max(W, H) / 1000, k, '');
    if (bg.imageDim) { ctx.fillStyle = `rgba(0,0,0,${bg.imageDim / 100})`; ctx.fillRect(0, 0, W, H); }
  } else if (bg.type === 'blur') {
    const r = bg.blur * Math.max(W, H) / 1000;
    const extra = bg.bw ? 'grayscale(1)' : '';
    if (style.size === 'original') {
      const pad = r * 2;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawBlurred(ctx, item.source, -pad * k, -pad * k, (W + pad * 2) * k, (H + pad * 2) * k, r * k, extra);
      ctx.restore();
    } else {
      coverDraw(ctx, item.source, W, H, r, k, extra);
    }
    if (bg.blurDim) { ctx.fillStyle = `rgba(0,0,0,${bg.blurDim / 100})`; ctx.fillRect(0, 0, W, H); }
  }
}

function coverDraw(ctx, img, W, H, blurOut, k, extra) {
  const iw = img.width, ih = img.height;
  const pad = blurOut * 2;
  const sc = Math.max((W + pad * 2) / iw, (H + pad * 2) / ih);
  const dw = iw * sc, dh = ih * sc;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath(); ctx.rect(0, 0, W * k, H * k); ctx.clip();
  drawBlurred(ctx, img, ((W - dw) / 2) * k, ((H - dh) / 2) * k, dw * k, dh * k, blurOut * k, extra);
  ctx.restore();
}

// ---------- subject placement ----------
function placeSubject(ctx, src, L, style, k, alpha = 1, blurOut = 0, dx = 0, dy = 0) {
  const { s, ox, oy, box } = L;
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.globalAlpha = alpha;
  if (style.flip) {
    const cx = box.x + box.w / 2;
    ctx.translate(cx * 2, 0);
    ctx.scale(-1, 1);
  }
  const x = ox + (style.flip ? -dx : dx), y = oy + dy;
  if (blurOut > 0.3 && FILTER_OK) {
    ctx.filter = `blur(${blurOut * k}px)`; // filter radius is in device pixels
    ctx.drawImage(src, x, y, src.width * s, src.height * s);
    ctx.filter = 'none';
  } else if (blurOut > 0.3) {
    const f = Math.max(1, blurOut / s / 2);
    const small = makeCanvas(Math.max(2, src.width / f), Math.max(2, src.height / f));
    const sx = small.getContext('2d');
    sx.imageSmoothingQuality = 'high';
    sx.drawImage(src, 0, 0, small.width, small.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, x, y, src.width * s, src.height * s);
  } else {
    ctx.drawImage(src, x, y, src.width * s, src.height * s);
  }
  ctx.restore();
}

/** Full composite into ctx (canvas must be W*k by H*k). */
export function composite(ctx, item, style, k, opts = {}) {
  const L = layout(item, style);
  ctx.save();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (opts.opaqueFill) { ctx.fillStyle = opts.opaqueFill; ctx.fillRect(0, 0, L.W, L.H); }
  drawBackground(ctx, item, style, L, k, opts.bgImage);
  ctx.restore();

  if (!item.cutout) {
    placeSubject(ctx, item.source, L, style, k);
    return L;
  }
  const { box } = L;
  const size = Math.max(box.w, box.h);
  const fx = style.fx;

  // shadow
  if (fx.shadow !== 'none' && fx.shOpacity > 0) {
    const a = fx.shOpacity / 100;
    if (fx.shadow === 'ground') {
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      const cx = box.x + box.w / 2 + (fx.shX / 100) * box.w * 0.5;
      const cy = box.y + box.h - box.h * 0.01 + (fx.shY / 100) * box.h * 0.08;
      const rx = box.w * 0.48, ry = Math.max(3, box.w * 0.07);
      const tmp = makeCanvas(rx * 2 * k + 4, ry * 2 * k + 4);
      const t = tmp.getContext('2d');
      const g = t.createRadialGradient(tmp.width / 2, tmp.height / 2, 0, tmp.width / 2, tmp.height / 2, tmp.width / 2);
      g.addColorStop(0, hexA(fx.shColor, a));
      g.addColorStop(0.5, hexA(fx.shColor, a * 0.45));
      g.addColorStop(1, hexA(fx.shColor, 0));
      t.setTransform(1, 0, 0, ry / rx, 0, (tmp.height / 2) * (1 - ry / rx));
      t.fillStyle = g;
      t.fillRect(0, 0, tmp.width, tmp.width);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const blur = (fx.shBlur / 100) * box.h * 0.04 * k;
      drawBlurred(ctx, tmp, (cx - rx) * k - 2, (cy - ry) * k - 2, tmp.width, tmp.height, blur);
      ctx.restore();
    } else {
      const sil = silhouette(item, fx.shColor);
      const soft = fx.shadow === 'soft';
      const blur = (fx.shBlur / 100) * size * (soft ? 0.08 : 0.012);
      const dx = (fx.shX / 100) * size * 0.3, dy = (fx.shY / 100) * size * 0.3;
      placeSubject(ctx, sil, L, style, k, a, blur, dx, dy);
    }
  }

  const subj = subjectLayer(item, style.adj);

  // reflection
  if (fx.refl > 0) {
    const tmp = makeCanvas(L.W * k, L.H * k);
    const t = tmp.getContext('2d');
    const bottom = box.y + box.h;
    t.setTransform(k, 0, 0, -k, 0, bottom * 2 * k);
    t.drawImage(subj, L.ox, L.oy, item.w * L.s, item.h * L.s);
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'destination-in';
    const g = t.createLinearGradient(0, bottom * k, 0, (bottom + box.h * 0.45) * k);
    g.addColorStop(0, `rgba(0,0,0,${fx.refl / 100})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    t.fillStyle = g;
    t.fillRect(0, 0, tmp.width, tmp.height);
    ctx.save();
    if (style.flip) { ctx.translate((box.x + box.w / 2) * 2 * k, 0); ctx.scale(-1, 1); }
    ctx.drawImage(tmp, 0, 0);
    ctx.restore();
  }

  // outline (sticker edge)
  if (fx.olSize > 0) {
    const sil = silhouette(item, fx.olColor);
    const r = (fx.olSize / 600) * size; // output pixels
    const rings = r > 6 ? [1, 0.66, 0.33] : [1, 0.5];
    for (const f of rings) {
      const steps = Math.max(12, Math.round(r * f * 1.2));
      for (let i = 0; i < Math.min(steps, 48); i++) {
        const ang = (i / Math.min(steps, 48)) * Math.PI * 2;
        placeSubject(ctx, sil, L, style, k, 1, 0, Math.cos(ang) * r * f, Math.sin(ang) * r * f);
      }
    }
  }

  placeSubject(ctx, subj, L, style, k);
  return L;
}

/** The untouched original placed where the subject sits — for the before/after compare. */
export function compositeOriginal(ctx, item, style, k) {
  const L = layout(item, style);
  placeSubject(ctx, item.source, L, style, k);
  return L;
}

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function computeBounds(item) {
  item.bounds = item.processed ? maskBounds(item.processed, item.w, item.h) || { x: 0, y: 0, w: item.w, h: item.h } : null;
}
