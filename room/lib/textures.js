// lib/textures.js — procedural canvas textures. Everything is drawn once at startup from the seeded PRNG;
// no image files. Colour maps are tagged sRGB, data maps (roughness / bump) are left linear.
//
// Quick reference (all sizes in px are clamped to <= 1024, except screen()):
//   setDefaults({ anisotropy })                    main.js sets this from the renderer
//   makeCanvas(w, h?)                              -> { canvas, ctx }
//   toTexture(canvas, { srgb, repeat, wrap, mipmaps, anisotropy }) -> CanvasTexture
//   screen(w, h, { mipmaps })                      -> { canvas, ctx, texture }     redraw, then texture.needsUpdate = true
//   wood({ kind: "planks" | "grain", ... })        -> { map, roughnessMap, bumpMap, worldSize, canvas }
//   ruledPaper({ text, scribble, ... })            -> { canvas, ctx, texture }
//   BOOK_PALETTE, drawSpine(ctx, x, y, w, h, o), spineAtlas({ titles, ... }) -> { canvas, ctx, texture, cells }
//   noise({ color, amount, ... })                  -> CanvasTexture (tileable mottled colour or data map)
//   weave({ color, threads, kind, ... })           -> { map, bumpMap }             tileable cloth / webbing
//   tatami({ width, depth, heri, ... })            -> { map, bumpMap, canvas }     whole mat top, heri along U at both V edges
//   leather({ color, ... })                        -> { map, bumpMap, roughnessMap, canvas, ctx }
//   washi({ color, ... })                          -> { map, canvas, ctx }         paper with fibres
//   rug({ colors, ... })                           -> { map, canvas, ctx }         muted bordered rug
//   noiseField(size, o), grainOverlay(ctx, w, h, o), fitText(ctx, text, maxWidth)
//   rgb(color), css(rgbArray, alpha), shade(color, amount, alpha), mix(a, b, t, alpha)

import { CanvasTexture, SRGBColorSpace, NoColorSpace, RepeatWrapping, LinearFilter } from "three";
import { createRng, SEED } from "./rng.js";

export const MAX_SIZE = 1024;

const defaults = { anisotropy: 4 };

/** Set module-wide defaults, e.g. setDefaults({ anisotropy: 8 }). */
export function setDefaults(next) {
  Object.assign(defaults, next);
}

const clampSize = (n) => Math.max(2, Math.min(MAX_SIZE, Math.round(n)));
const fallbackRng = (label) => createRng(SEED).fork(`textures:${label}`);

// ---- colour helpers -------------------------------------------------------------------------------

/** "#rgb" | "#rrggbb" | [r, g, b] -> [r, g, b] in 0..255. */
export function rgb(color) {
  if (Array.isArray(color)) return color;
  let h = String(color).replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [r, g, b] (+ alpha) -> CSS colour string. */
export function css(c, alpha = 1) {
  const r = Math.max(0, Math.min(255, Math.round(c[0])));
  const g = Math.max(0, Math.min(255, Math.round(c[1])));
  const b = Math.max(0, Math.min(255, Math.round(c[2])));
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

const shadeRgb = (c, amount) => {
  const t = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  return [c[0] + (t - c[0]) * k, c[1] + (t - c[1]) * k, c[2] + (t - c[2]) * k];
};
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Darken (amount < 0) or lighten (amount > 0) a colour; amount in −1..1. Returns a CSS string. */
export const shade = (color, amount, alpha = 1) => css(shadeRgb(rgb(color), amount), alpha);

/** Linear mix of two colours. Returns a CSS string. */
export const mix = (a, b, t, alpha = 1) => css(mixRgb(rgb(a), rgb(b), t), alpha);

const luminance = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

// ---- canvas + texture plumbing --------------------------------------------------------------------

/** @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }} */
export function makeCanvas(width, height = width) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return { canvas, ctx: canvas.getContext("2d") };
}

/**
 * Wrap a canvas in a CanvasTexture with the colour space set correctly.
 * @param {HTMLCanvasElement} canvas
 * @param {{ srgb?: boolean, repeat?: [number, number] | null, wrap?: boolean, mipmaps?: boolean, anisotropy?: number }} [opts]
 *   srgb: true for colour maps (default), false for roughness/bump/alpha data.
 *   repeat: sets RepeatWrapping + texture.repeat. wrap: RepeatWrapping without changing repeat.
 */
export function toTexture(canvas, opts = {}) {
  const { srgb = true, repeat = null, wrap = repeat != null, mipmaps = true, anisotropy = defaults.anisotropy } = opts;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  if (wrap) texture.wrapS = texture.wrapT = RepeatWrapping;
  if (repeat) texture.repeat.set(repeat[0], repeat[1]);
  if (!mipmaps) {
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
  }
  texture.anisotropy = anisotropy;
  return texture;
}

/**
 * Canvas for glowing / redrawn surfaces (projection, laptop, LCDs, labels). sRGB, no mipmaps by default
 * (cheap to re-upload). After redrawing set `texture.needsUpdate = true`. Use with MeshBasicMaterial
 * + toneMapped: false. Size is not clamped: the projection uses 1280 × 720, keep everything else <= 1024.
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, texture: CanvasTexture }}
 */
export function screen(width, height, opts = {}) {
  const { canvas, ctx } = makeCanvas(width, height);
  const texture = toTexture(canvas, { srgb: true, mipmaps: opts.mipmaps === true, anisotropy: opts.anisotropy });
  return { canvas, ctx, texture };
}

/** Shorten `text` with an ellipsis until it fits `maxWidth` in the ctx's current font. */
export function fitText(ctx, text, maxWidth) {
  let s = String(text ?? "");
  if (ctx.measureText(s).width <= maxWidth) return s;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxWidth) s = s.slice(0, -1);
  return s.replace(/[\s,.;:–—-]+$/, "") + "…";
}

// ---- noise ----------------------------------------------------------------------------------------

/**
 * Tileable fractal value noise.
 * @param {number} [size=256]
 * @param {{ rng?: Function, scale?: number, octaves?: number, gain?: number }} [opts] scale = cells across at octave 0
 * @returns {Float32Array} size × size values in [0, 1]
 */
export function noiseField(size = 256, opts = {}) {
  const { scale = 4, octaves = 4, gain = 0.5 } = opts;
  const rng = opts.rng || fallbackRng("noiseField");
  const out = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.max(1, Math.min(size, Math.round(scale) << o));
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rng();
    const step = cells / size;
    for (let y = 0; y < size; y++) {
      const gy = y * step, y0 = Math.floor(gy), fy = gy - y0, sy = fy * fy * (3 - 2 * fy);
      const ya = (y0 % cells) * cells, yb = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const gx = x * step, x0 = Math.floor(gx), fx = gx - x0, sx = fx * fx * (3 - 2 * fx);
        const xa = x0 % cells, xb = (x0 + 1) % cells;
        const top = grid[ya + xa] + (grid[ya + xb] - grid[ya + xa]) * sx;
        const bot = grid[yb + xa] + (grid[yb + xb] - grid[yb + xa]) * sx;
        out[y * size + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/**
 * Multiply organic mottling into whatever is already drawn on a canvas (keeps it tileable).
 * @param {{ rng?: Function, amount?: number, scale?: number, octaves?: number, fine?: number }} [opts]
 *   amount: low-frequency brightness swing (0.08 = ±8 %). fine: per-pixel grain.
 */
export function grainOverlay(ctx, width, height, opts = {}) {
  const { amount = 0.08, scale = 5, octaves = 4, fine = 0.02 } = opts;
  const rng = opts.rng || fallbackRng("grainOverlay");
  const N = 256;
  const field = noiseField(N, { rng, scale, octaves });
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  const kx = N / width, ky = N / height;
  for (let y = 0; y < height; y++) {
    const fy = (Math.floor(y * ky) % N) * N;
    for (let x = 0; x < width; x++) {
      const n = field[fy + (Math.floor(x * kx) % N)];
      const k = 1 + (n - 0.5) * 2 * amount + (fine ? (rng() - 0.5) * 2 * fine : 0);
      const i = (y * width + x) * 4;
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/**
 * Tileable mottled texture: plaster, paint, rubber, felt, cast iron…
 * @param {{ size?: number, color?: string, amount?: number, scale?: number, octaves?: number, fine?: number,
 *           srgb?: boolean, repeat?: [number, number], rng?: Function }} [opts]
 *   srgb: false gives a data map (e.g. roughness: color "#c8c8c8", amount 0.15).
 * @returns {CanvasTexture}
 */
export function noise(opts = {}) {
  const { size = 256, color = "#808080", amount = 0.12, scale = 5, octaves = 4, fine = 0.02, srgb = true, repeat = [1, 1] } = opts;
  const rng = opts.rng || fallbackRng(`noise:${color}`);
  const s = clampSize(size);
  const { canvas, ctx } = makeCanvas(s);
  ctx.fillStyle = css(rgb(color));
  ctx.fillRect(0, 0, s, s);
  grainOverlay(ctx, s, s, { rng, amount, scale, octaves, fine });
  return toTexture(canvas, { srgb, repeat, anisotropy: opts.anisotropy });
}

// ---- wood -----------------------------------------------------------------------------------------

/**
 * Wood, drawn as boards running along U (canvas x).
 *   kind "planks": floorboards with staggered end joints and visible seams (tileable in U and V).
 *   kind "grain":  continuous glued boards, faint seams — desk tops, shelves, rails, rings (tileable).
 * One tile covers `worldSize` = [rows × plankWidth, rows × plankWidth] metres, so for a W × D surface use
 * repeat = [W / worldSize[0], D / worldSize[1]] (pass it as `repeat`, or set it on the returned maps).
 *
 * @param {Object} [opts]
 * @param {"planks"|"grain"} [opts.kind="planks"]
 * @param {number} [opts.size=1024]
 * @param {string} [opts.color="#c8a070"]      base tone
 * @param {number} [opts.rows]                 boards across V (default 20 planks / 4 grain)
 * @param {number} [opts.plankWidth=0.18]      metres, only used for worldSize and plank lengths
 * @param {[number, number]} [opts.plankLength=[0.8, 1.6]] metres (planks only)
 * @param {number} [opts.variation]            board-to-board tone variation, 0..0.2 (default 0.045 planks / 0.03 grain)
 * @param {number} [opts.grain=0.7]            grain contrast, 0..1
 * @param {number} [opts.knots=0.03]           chance of a small knot per board
 * @param {number} [opts.seam]                 seam darkness, 0..1
 * @param {boolean} [opts.maps=true]           also build roughnessMap + bumpMap (half resolution)
 * @param {[number, number]} [opts.repeat]
 * @param {Function} [opts.rng]
 * @returns {{ map: CanvasTexture, roughnessMap: CanvasTexture|null, bumpMap: CanvasTexture|null,
 *             worldSize: [number, number], canvas: HTMLCanvasElement }}
 *   roughnessMap is a multiplier in ~[0.66, 1] (effective roughness = material.roughness × map), with
 *   streaky board-to-board variation for a hand-polished sheen. bumpMap: seams are grooves; try bumpScale 0.4–1.
 */
export function wood(opts = {}) {
  const kind = opts.kind === "grain" ? "grain" : "planks";
  const planks = kind === "planks";
  const {
    color = "#c8a070", rows = planks ? 20 : 4, plankWidth = 0.18, plankLength = [0.8, 1.6],
    variation = planks ? 0.045 : 0.03, grain = 0.7, knots = 0.03, seam = planks ? 0.5 : 0.18, maps = true, repeat = null,
  } = opts;
  const rng = opts.rng || fallbackRng(`wood:${kind}:${color}`);
  const size = clampSize(opts.size ?? 1024);
  const world = rows * plankWidth;
  const pxPerM = size / world;
  const k = size / 1024; // line-weight scale

  const C = makeCanvas(size);
  const c = C.ctx;
  const half = Math.max(128, size >> 1);
  const R = maps ? makeCanvas(half) : null;
  const B = maps ? makeCanvas(half) : null;
  const r = R ? R.ctx : null;
  const b = B ? B.ctx : null;
  if (maps) {
    r.scale(half / size, half / size);
    b.scale(half / size, half / size);
    r.fillStyle = "#cfcfcf";
    r.fillRect(0, 0, size, size);
    b.fillStyle = "#808080";
    b.fillRect(0, 0, size, size);
  }
  const base = rgb(color);
  const ph = size / rows;

  const boardParams = (y, w) => {
    // per-board tone: lightness jitter plus a slight warm/cool drift
    let tone = shadeRgb(base, Math.max(-2.2 * variation, Math.min(2.2 * variation, rng.gauss(0, variation))));
    tone = mixRgb(tone, [tone[0] * 1.04, tone[1] * 0.97, tone[2] * 0.9], rng.float(0, 1) * Math.min(1, variation * 8));
    const flat = rng.chance(0.45); // flat-sawn boards show cathedral arches
    return {
      y, w, tone,
      yc: y + ph * rng.float(0.15, 0.85),
      xc: rng.float(0, 1),
      curv: flat ? rng.float(0.9, 3.2) : rng.float(0, 0.3),
      period: planks ? w * rng.float(1.6, 2.6) : size,
      wobA: ph * rng.float(0.01, 0.05), wobK: rng.int(1, 3), wobP: rng.float(0, Math.PI * 2),
      spacing: rng.float(1.5, 2.9) * k,
      rough: 207 + rng.int(-38, 34), lift: 128 + rng.int(-4, 4),
      knot: rng.chance(knots) ? { u: rng.float(0.15, 0.85), v: rng.float(0.25, 0.75), r: ph * rng.float(0.07, 0.14) } : null,
      seed: rng.int(1, 0x7fffffff),
    };
  };

  const renderBoard = (P, x) => {
    const lr = createRng(P.seed); // same strokes when a board is drawn twice across the wrap edge
    const { y, w } = P;
    const ctxs = maps ? [c, r, b] : [c];
    for (const g of ctxs) {
      g.save();
      g.beginPath();
      g.rect(x, y, w, ph);
      g.clip();
    }
    c.fillStyle = css(P.tone);
    c.fillRect(x, y, w, ph);
    if (maps) {
      r.fillStyle = css([P.rough, P.rough, P.rough]);
      r.fillRect(x, y, w, ph);
      b.fillStyle = css([P.lift, P.lift, P.lift]);
      b.fillRect(x, y, w, ph);
    }
    // slight cupping: board edges a touch darker than the crown
    const cup = c.createLinearGradient(0, y, 0, y + ph);
    cup.addColorStop(0, "rgba(40,22,8,0.07)");
    cup.addColorStop(0.18, "rgba(40,22,8,0)");
    cup.addColorStop(0.82, "rgba(40,22,8,0)");
    cup.addColorStop(1, "rgba(40,22,8,0.09)");
    c.fillStyle = cup;
    c.fillRect(x, y, w, ph);

    // grain: a family of lines spreading away from a centre line (cathedral figure when curv is large)
    const xc = x + P.xc * w;
    const twoPi = Math.PI * 2;
    const yAt = (v, xx) =>
      P.yc + v * ph * (1 + P.curv * (0.5 - 0.5 * Math.cos((twoPi * (xx - xc)) / P.period))) +
      P.wobA * Math.sin((twoPi * P.wobK * xx) / (planks ? P.period : size) + P.wobP);
    const n = Math.max(6, Math.round((2 * ph) / P.spacing));
    const step = 18 * k;
    const dark = shadeRgb(P.tone, -0.5);
    const light = shadeRgb(P.tone, 0.3);
    for (let i = 0; i < n; i++) {
      const v = ((i + lr.float(-0.4, 0.4)) / n) * 2 - 1;
      const path = new Path2D();
      path.moveTo(x - step, yAt(v, x - step));
      for (let xx = x; xx <= x + w + step; xx += step) path.lineTo(xx, yAt(v, xx));
      const band = lr.chance(0.14); // late-wood band: wide and soft
      const bright = !band && lr.chance(0.2);
      const a = grain * (band ? lr.float(0.06, 0.12) : lr.float(0.07, 0.36));
      c.lineWidth = (band ? lr.float(3.5, 7) : lr.float(0.5, 1.6)) * k;
      c.strokeStyle = css(bright ? light : dark, bright ? a * 0.6 : a);
      c.stroke(path);
      if (maps && !bright) {
        r.lineWidth = b.lineWidth = c.lineWidth;
        r.strokeStyle = `rgba(255,255,255,${a * 0.5})`;
        r.stroke(path);
        b.strokeStyle = `rgba(0,0,0,${a * 0.45})`;
        b.stroke(path);
      }
    }
    if (P.knot) {
      const kx = x + P.knot.u * w, ky = y + P.knot.v * ph, kr = P.knot.r;
      const kg = c.createRadialGradient(kx, ky, 0, kx, ky, kr * 1.6);
      kg.addColorStop(0, css(shadeRgb(P.tone, -0.55), 0.6));
      kg.addColorStop(0.45, css(shadeRgb(P.tone, -0.4), 0.3));
      kg.addColorStop(1, css(shadeRgb(P.tone, -0.3), 0));
      c.fillStyle = kg;
      c.beginPath();
      c.ellipse(kx, ky, kr * 1.9, kr * 1.1, 0, 0, twoPi);
      c.fill();
      c.strokeStyle = css(shadeRgb(P.tone, -0.5), 0.25);
      c.lineWidth = 1 * k;
      for (let q = 1; q <= 3; q++) {
        c.beginPath();
        c.ellipse(kx, ky, kr * (0.6 + q * 0.55), kr * (0.3 + q * 0.32), 0, 0, twoPi);
        c.stroke();
      }
    }
    // seams: long edge below, a hairline of light above, butt joint at the right end
    const sw = 1.25 * k;
    c.fillStyle = `rgba(24,13,5,${seam})`;
    c.fillRect(x, y + ph - sw, w, sw);
    if (planks) c.fillRect(x + w - sw, y, sw, ph);
    c.fillStyle = `rgba(255,240,215,${0.1 * seam})`;
    c.fillRect(x, y, w, 1 * k);
    if (maps) {
      r.fillStyle = `rgba(255,255,255,${Math.min(1, seam * 1.3)})`;
      r.fillRect(x, y + ph - sw, w, sw);
      b.fillStyle = `rgba(0,0,0,${Math.min(1, seam * 1.4)})`;
      b.fillRect(x, y + ph - sw * 1.2, w, sw * 1.2);
      if (planks) {
        r.fillRect(x + w - sw, y, sw, ph);
        b.fillRect(x + w - sw * 1.2, y, sw * 1.2, ph);
      }
    }
    for (const g of ctxs) g.restore();
  };

  for (let row = 0; row < rows; row++) {
    const y = row * ph;
    if (!planks) {
      renderBoard(boardParams(y, size), 0);
      continue;
    }
    const minL = plankLength[0] * pxPerM, maxL = plankLength[1] * pxPerM;
    const start = rng.float(0, size);
    let x = start;
    for (;;) {
      const remaining = start + size - x;
      let len = remaining;
      if (remaining > maxL) len = Math.max(Math.min(rng.float(minL, maxL), remaining - minL), Math.min(minL, remaining / 2));
      const P = boardParams(y, len);
      const x0 = x % size;
      renderBoard(P, x0);
      if (x0 + len > size) renderBoard(P, x0 - size);
      x += len;
      if (start + size - x < 0.5) break;
    }
  }
  grainOverlay(c, size, size, { rng, amount: 0.035, scale: 6, fine: 0.018 });

  const tex = (canvas, srgb) => toTexture(canvas, { srgb, wrap: true, repeat, anisotropy: opts.anisotropy });
  return {
    map: tex(C.canvas, true),
    roughnessMap: maps ? tex(R.canvas, false) : null,
    bumpMap: maps ? tex(B.canvas, false) : null,
    worldSize: [world, world],
    canvas: C.canvas,
  };
}

// ---- paper ----------------------------------------------------------------------------------------

/**
 * A ruled notebook page (portrait). Returns the canvas too, so you can keep drawing on it.
 * @param {Object} [opts]
 * @param {number} [opts.width=512]
 * @param {number} [opts.height=726]            A5 proportion by default
 * @param {string} [opts.color="#f3eedf"]
 * @param {number} [opts.pageHeight=0.21]       metres, used with lineSpacing
 * @param {number} [opts.lineSpacing=0.006]     metres between rules (6 mm)
 * @param {string} [opts.lineColor]
 * @param {boolean} [opts.margin=true]          faint red margin line on the left
 * @param {string[]} [opts.text]                real lines, written in a handwriting-ish face on the rules
 * @param {number} [opts.startLine=3]           first rule used by text / scribble
 * @param {number|false} [opts.scribble=5]      number of scribbled "handwriting" lines after the text
 * @param {string} [opts.ink="#1c2b5a"]
 * @param {Function} [opts.rng]
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, texture: CanvasTexture, lineHeight: number }}
 */
export function ruledPaper(opts = {}) {
  const {
    width = 512, height = 726, color = "#f3eedf", pageHeight = 0.21, lineSpacing = 0.006,
    lineColor = "rgba(70,105,150,0.26)", margin = true, text = null, startLine = 3, scribble = 5, ink = "#1c2b5a",
  } = opts;
  const rng = opts.rng || fallbackRng("ruledPaper");
  const w = clampSize(width), h = clampSize(height);
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  const shadeGrad = ctx.createLinearGradient(0, 0, w, 0); // soft shadow toward the gutter
  shadeGrad.addColorStop(0, "rgba(60,40,20,0.10)");
  shadeGrad.addColorStop(0.12, "rgba(60,40,20,0)");
  ctx.fillStyle = shadeGrad;
  ctx.fillRect(0, 0, w, h);

  const lh = (lineSpacing / pageHeight) * h;
  const left = w * 0.1, right = w * 0.94;
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = Math.max(1, h / 700);
  for (let y = lh * 2; y < h - lh * 0.5; y += lh) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  if (margin) {
    ctx.strokeStyle = "rgba(170,60,50,0.28)";
    ctx.beginPath();
    ctx.moveTo(left - w * 0.025, 0);
    ctx.lineTo(left - w * 0.025, h);
    ctx.stroke();
  }

  let line = startLine;
  const baseline = (i) => lh * (i + 2) - lh * 0.18;
  if (text && text.length) {
    ctx.fillStyle = ink;
    ctx.textBaseline = "alphabetic";
    ctx.font = `italic ${Math.round(lh * 0.86)}px "Snell Roundhand", "Segoe Script", "Bradley Hand", "Apple Chancery", cursive`;
    for (const raw of text) {
      if (baseline(line) > h - lh) break;
      ctx.save();
      ctx.translate(left + rng.float(-2, 4), baseline(line) + rng.float(-1, 1));
      ctx.rotate(rng.float(-0.006, 0.006));
      ctx.globalAlpha = rng.float(0.78, 0.95);
      ctx.fillText(fitText(ctx, raw, right - left), 0, 0);
      ctx.restore();
      line++;
    }
    line++;
  }
  if (scribble) {
    ctx.strokeStyle = ink;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < scribble && baseline(line) < h - lh; i++, line++) {
      const y = baseline(line);
      const end = left + (right - left) * rng.float(0.35, 1);
      let x = left + rng.float(0, w * 0.03);
      while (x < end) {
        const word = rng.float(w * 0.03, w * 0.11);
        ctx.globalAlpha = rng.float(0.6, 0.9);
        ctx.lineWidth = Math.max(1, (h / 700) * rng.float(0.9, 1.5));
        ctx.beginPath();
        ctx.moveTo(x, y - rng.float(0, lh * 0.3));
        for (let px = x; px < Math.min(x + word, end); px += lh * 0.18) {
          ctx.lineTo(px + rng.float(-1, 1), y - rng.float(0, lh * (rng.chance(0.15) ? 0.7 : 0.38)));
        }
        ctx.stroke();
        x += word + rng.float(w * 0.012, w * 0.03);
      }
    }
    ctx.globalAlpha = 1;
  }
  return { canvas, ctx, texture: toTexture(canvas, { srgb: true, anisotropy: opts.anisotropy }), lineHeight: lh };
}

/**
 * Handmade paper with fibres: shoji panels, the ceiling lamp, scroll mounts. Tileable enough for small repeats.
 * @param {{ size?: number, color?: string, fibres?: number, repeat?: [number, number], rng?: Function }} [opts]
 * @returns {{ map: CanvasTexture, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function washi(opts = {}) {
  const { size = 512, color = "#f2ead6", fibres = 420, repeat = null } = opts;
  const rng = opts.rng || fallbackRng("washi");
  const s = clampSize(size);
  const { canvas, ctx } = makeCanvas(s);
  const base = rgb(color);
  ctx.fillStyle = css(base);
  ctx.fillRect(0, 0, s, s);
  ctx.lineCap = "round";
  for (let i = 0; i < fibres; i++) {
    const x = rng.float(0, s), y = rng.float(0, s), len = rng.float(s * 0.03, s * 0.2), a = rng.float(0, Math.PI * 2);
    const bend = rng.float(-0.5, 0.5) * len;
    const lightFibre = rng.chance(0.55);
    ctx.strokeStyle = css(shadeRgb(base, lightFibre ? 0.5 : -0.22), rng.float(0.08, lightFibre ? 0.5 : 0.22));
    ctx.lineWidth = rng.float(0.5, 1.6) * (s / 512);
    for (const [ox, oy] of [[0, 0], [x < s / 2 ? s : -s, 0], [0, y < s / 2 ? s : -s]]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y + oy);
      ctx.quadraticCurveTo(
        x + ox + (Math.cos(a) * len) / 2 - Math.sin(a) * bend, y + oy + (Math.sin(a) * len) / 2 + Math.cos(a) * bend,
        x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len,
      );
      ctx.stroke();
    }
  }
  grainOverlay(ctx, s, s, { rng, amount: 0.05, scale: 4, fine: 0.015 });
  return { map: toTexture(canvas, { srgb: true, repeat, wrap: true, anisotropy: opts.anisotropy }), canvas, ctx };
}

// ---- books ----------------------------------------------------------------------------------------

/** Muted spine palette (SPEC §5.6). */
export const BOOK_PALETTE = ["#7a2e22", "#2f4858", "#8c7a5b", "#3d5a40", "#c4b59a", "#5a3e5d", "#1f2a36", "#a8642a"];

/**
 * Draw one book spine into a rectangle: cloth colour, rounded-spine shading, two bands, and a title
 * running top-to-bottom (ellipsised to fit).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ color?: string, title?: string, bands?: boolean, ink?: string, font?: string, rng?: Function }} [opts]
 */
export function drawSpine(ctx, x, y, w, h, opts = {}) {
  const { color = BOOK_PALETTE[0], title = "", bands = true, font = 'Georgia, "Iowan Old Style", "Times New Roman", serif' } = opts;
  const base = rgb(color);
  const ink = opts.ink || (luminance(base) > 0.5 ? "rgba(40,30,22,0.88)" : "rgba(238,226,200,0.9)");
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = css(base);
  ctx.fillRect(x, y, w, h);
  const round = ctx.createLinearGradient(x, 0, x + w, 0);
  round.addColorStop(0, "rgba(0,0,0,0.34)");
  round.addColorStop(0.22, "rgba(0,0,0,0.02)");
  round.addColorStop(0.5, "rgba(255,255,255,0.06)");
  round.addColorStop(0.78, "rgba(0,0,0,0.02)");
  round.addColorStop(1, "rgba(0,0,0,0.34)");
  ctx.fillStyle = round;
  ctx.fillRect(x, y, w, h);
  if (bands) {
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.55;
    const t = Math.max(1, h * 0.006);
    for (const f of [0.07, 0.085, 0.915, 0.93]) ctx.fillRect(x + w * 0.1, y + h * f, w * 0.8, t);
    ctx.globalAlpha = 1;
  }
  if (title) {
    const px = Math.max(7, Math.min(w * 0.46, h * 0.075));
    ctx.font = `${Math.round(px)}px ${font}`;
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(fitText(ctx, title, h * 0.76), 0, px * 0.05);
  }
  ctx.restore();
}

/**
 * Pack labelled spines into one texture. Use the returned UV rects on a merged geometry of spine quads
 * (one draw call; raycast faceIndex >> 1 gives the book index) or via a per-instance UV attribute.
 * @param {{ titles: string[], colors?: string[], size?: number, rows?: number, rng?: Function }} opts
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, texture: CanvasTexture,
 *             cells: { index: number, title: string, color: string, uv: [number, number, number, number] }[] }}
 *   uv = [u0, v0, u1, v1] with v up (three.js convention); the title reads top-to-bottom from v1 to v0.
 */
export function spineAtlas(opts = {}) {
  const { titles = [], colors = BOOK_PALETTE } = opts;
  const rng = opts.rng || fallbackRng("spineAtlas");
  const size = clampSize(opts.size ?? 1024);
  const n = Math.max(1, titles.length);
  const rows = opts.rows || Math.max(1, Math.min(8, Math.round(Math.sqrt(n / 7.5))));
  const cols = Math.ceil(n / rows);
  const cw = Math.floor(size / cols), ch = Math.floor(size / rows);
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = "#2a2420";
  ctx.fillRect(0, 0, size, size);
  const cells = [];
  let last = "";
  for (let i = 0; i < titles.length; i++) {
    const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
    let color = rng.pick(colors);
    if (color === last && colors.length > 1) color = colors[(colors.indexOf(color) + 1) % colors.length];
    last = color;
    drawSpine(ctx, cx, cy, cw, ch, { color, title: titles[i], rng });
    const inset = 0.5 / size; // half-texel inset against bleeding between cells
    cells.push({ index: i, title: titles[i], color, uv: [cx / size + inset, 1 - (cy + ch) / size + inset, (cx + cw) / size - inset, 1 - cy / size - inset] });
  }
  return { canvas, ctx, texture: toTexture(canvas, { srgb: true, anisotropy: opts.anisotropy }), cells };
}

// ---- cloth, tatami, leather, rug ------------------------------------------------------------------

/**
 * Tileable woven cloth: webbing, canvas, heri borders, upholstery.
 * @param {{ size?: number, color?: string, color2?: string, threads?: number, kind?: "plain"|"twill"|"basket",
 *           contrast?: number, repeat?: [number, number], rng?: Function }} [opts]
 *   threads = warp threads across one tile. color = warp, color2 = weft (defaults to a darker warp).
 * @returns {{ map: CanvasTexture, bumpMap: CanvasTexture }}
 */
export function weave(opts = {}) {
  const { size = 256, color = "#8a8478", threads = 32, kind = "plain", contrast = 0.22, repeat = [1, 1] } = opts;
  const rng = opts.rng || fallbackRng(`weave:${color}`);
  const s = clampSize(size);
  const n = Math.max(2, Math.round(threads / 4) * 4);
  const cell = s / n;
  const warp = rgb(color), weft = rgb(opts.color2 || shade(color, -0.14));
  const C = makeCanvas(s), B = makeCanvas(s);
  const c = C.ctx, b = B.ctx;
  b.fillStyle = "#606060";
  b.fillRect(0, 0, s, s);
  const over = (i, j) => (kind === "twill" ? (i + j) % 4 < 2 : kind === "basket" ? ((i >> 1) + (j >> 1)) % 2 === 0 : (i + j) % 2 === 0);
  const warpTone = [], weftTone = [];
  for (let i = 0; i < n; i++) {
    warpTone.push(shadeRgb(warp, rng.float(-0.06, 0.06)));
    weftTone.push(shadeRgb(weft, rng.float(-0.06, 0.06)));
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * cell, y = j * cell, up = over(i, j);
      const tone = up ? warpTone[i] : weftTone[j];
      c.fillStyle = css(tone);
      c.fillRect(x, y, cell + 0.5, cell + 0.5);
      // each crossing is a little cylinder: light crown, dark flanks, along the thread direction
      const g = up ? c.createLinearGradient(x, 0, x + cell, 0) : c.createLinearGradient(0, y, 0, y + cell);
      g.addColorStop(0, `rgba(0,0,0,${contrast})`);
      g.addColorStop(0.5, `rgba(255,255,255,${contrast * 0.35})`);
      g.addColorStop(1, `rgba(0,0,0,${contrast})`);
      c.fillStyle = g;
      c.fillRect(x, y, cell + 0.5, cell + 0.5);
      const h = up ? b.createLinearGradient(x, 0, x + cell, 0) : b.createLinearGradient(0, y, 0, y + cell);
      const top = up ? 235 : 150;
      h.addColorStop(0, "rgb(70,70,70)");
      h.addColorStop(0.5, `rgb(${top},${top},${top})`);
      h.addColorStop(1, "rgb(70,70,70)");
      b.fillStyle = h;
      b.fillRect(x, y, cell + 0.5, cell + 0.5);
    }
  }
  grainOverlay(c, s, s, { rng, amount: 0.05, scale: 6, fine: 0.03 });
  return {
    map: toTexture(C.canvas, { srgb: true, repeat, anisotropy: opts.anisotropy }),
    bumpMap: toTexture(B.canvas, { srgb: false, repeat, anisotropy: opts.anisotropy }),
  };
}

/**
 * Tatami top face for one whole mat: igusa rush surface with dark cloth heri borders.
 * UV 0..1 spans the mat. U = mat `width` (the heri run along U, at the v = 0 and v = 1 edges),
 * V = mat `depth`. Not tileable: map it once over the top of the mat.
 * @param {{ size?: number, width?: number, depth?: number, heri?: number, color?: string, heriColor?: string,
 *           rib?: number, rng?: Function }} [opts]   width/depth/heri/rib in metres (rib = ridge spacing, ~15 mm)
 * @returns {{ map: CanvasTexture, bumpMap: CanvasTexture, canvas: HTMLCanvasElement }}
 */
export function tatami(opts = {}) {
  const { width = 1.2, depth = 1.0, heri = 0.03, color = "#bfae78", heriColor = "#1d222b", rib = 0.015 } = opts;
  const rng = opts.rng || fallbackRng("tatami");
  const s = clampSize(opts.size ?? 1024);
  const C = makeCanvas(s), B = makeCanvas(s >> 1);
  const c = C.ctx, b = B.ctx;
  b.scale(0.5, 0.5);
  const base = rgb(color);
  const green = mixRgb(base, [150, 160, 96], 0.5);
  const gold = mixRgb(base, [214, 186, 118], 0.5);
  const pxU = s / width, pxV = s / depth;
  const heriPx = heri * pxV;

  // rushes: thin stalks lying across the mat (along V), each a slightly different straw tone
  const stalk = Math.max(2, Math.round(0.003 * pxU));
  b.fillStyle = "#808080";
  b.fillRect(0, 0, s, s);
  for (let x = 0; x < s; x += stalk) {
    const t = rng();
    const tone = shadeRgb(t < 0.3 ? mixRgb(base, green, rng()) : mixRgb(base, gold, rng()), rng.float(-0.07, 0.07));
    c.fillStyle = css(tone);
    c.fillRect(x, 0, stalk, s);
    c.fillStyle = "rgba(60,48,20,0.16)";
    c.fillRect(x + stalk - 1, 0, 1, s);
    b.fillStyle = "rgba(0,0,0,0.35)";
    b.fillRect(x + stalk - 1, 0, 1, s);
  }
  // ribs: the warp pulls the rush into fine ridges running along the mat (along U)
  const ribPx = rib * pxV;
  for (let y = heriPx; y < s - heriPx; y += ribPx) {
    const g = c.createLinearGradient(0, y, 0, y + ribPx);
    g.addColorStop(0, "rgba(50,38,12,0.2)");
    g.addColorStop(0.35, "rgba(255,246,214,0.07)");
    g.addColorStop(0.7, "rgba(255,246,214,0.02)");
    g.addColorStop(1, "rgba(50,38,12,0.2)");
    c.fillStyle = g;
    c.fillRect(0, y, s, ribPx + 0.5);
    const h = b.createLinearGradient(0, y, 0, y + ribPx);
    h.addColorStop(0, "rgba(0,0,0,0.55)");
    h.addColorStop(0.45, "rgba(255,255,255,0.4)");
    h.addColorStop(1, "rgba(0,0,0,0.55)");
    b.fillStyle = h;
    b.fillRect(0, y, s, ribPx + 0.5);
  }
  grainOverlay(c, s, s, { rng, amount: 0.045, scale: 5, fine: 0.02 });

  // heri: dark cloth bands with a faint woven diamond figure
  const hc = rgb(heriColor);
  for (const y0 of [0, s - heriPx]) {
    c.fillStyle = css(hc);
    c.fillRect(0, y0, s, heriPx);
    const d = heriPx / 3;
    c.strokeStyle = css(shadeRgb(hc, 0.22), 0.5);
    c.lineWidth = Math.max(1, d * 0.12);
    c.save();
    c.beginPath();
    c.rect(0, y0, s, heriPx);
    c.clip();
    for (let x = -heriPx; x < s + heriPx; x += d * 2) {
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x + heriPx, y0 + heriPx);
      c.moveTo(x + heriPx, y0);
      c.lineTo(x, y0 + heriPx);
      c.stroke();
    }
    c.restore();
    c.fillStyle = "rgba(0,0,0,0.35)"; // stitched inner edge
    c.fillRect(0, y0 === 0 ? heriPx - 1.5 : y0, s, 1.5);
    b.fillStyle = "#b0b0b0";
    b.fillRect(0, y0, s, heriPx);
  }
  return {
    map: toTexture(C.canvas, { srgb: true, anisotropy: opts.anisotropy }),
    bumpMap: toTexture(B.canvas, { srgb: false, anisotropy: opts.anisotropy }),
    canvas: C.canvas,
  };
}

/**
 * Tileable leather: mottled dye, fine pebble grain, a little wear. Returns ctx so seams / panels can be
 * drawn on top before first use (set map.needsUpdate = true afterwards).
 * @param {{ size?: number, color?: string, wear?: number, repeat?: [number, number], rng?: Function }} [opts]
 * @returns {{ map: CanvasTexture, bumpMap: CanvasTexture, roughnessMap: CanvasTexture, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function leather(opts = {}) {
  const { size = 512, color = "#5a1d12", wear = 0.5, repeat = [1, 1] } = opts;
  const rng = opts.rng || fallbackRng(`leather:${color}`);
  const s = clampSize(size);
  const C = makeCanvas(s), B = makeCanvas(s), R = makeCanvas(s >> 1);
  const c = C.ctx, b = B.ctx, r = R.ctx;
  const base = rgb(color);
  c.fillStyle = css(base);
  c.fillRect(0, 0, s, s);
  b.fillStyle = "#8a8a8a";
  b.fillRect(0, 0, s, s);
  r.fillStyle = "#d2d2d2";
  r.fillRect(0, 0, s >> 1, s >> 1);
  r.scale(0.5, 0.5);
  // pebble grain: small irregular cells separated by darker creases
  const count = Math.round((s * s) / 42);
  const crease = shadeRgb(base, -0.45);
  for (let i = 0; i < count; i++) {
    const x = rng.float(0, s), y = rng.float(0, s), rx = rng.float(1.2, 3.4) * (s / 512), ry = rx * rng.float(0.6, 1), a = rng.float(0, Math.PI);
    const wx = x < rx * 2 ? s : x > s - rx * 2 ? -s : 0, wy = y < rx * 2 ? s : y > s - rx * 2 ? -s : 0;
    for (let pass = 0; pass < 3; pass++) {
      // pass 0 draws the cell, passes 1–2 repeat it across the tile edge when it straddles one
      if ((pass === 1 && !wx) || (pass === 2 && !wy)) continue;
      const ox = pass === 1 ? wx : 0, oy = pass === 2 ? wy : 0;
      c.strokeStyle = css(crease, 0.16);
      c.lineWidth = 0.7;
      c.beginPath();
      c.ellipse(x + ox, y + oy, rx, ry, a, 0, Math.PI * 2);
      c.stroke();
      b.fillStyle = "rgba(255,255,255,0.22)";
      b.beginPath();
      b.ellipse(x + ox, y + oy, rx * 0.8, ry * 0.8, a, 0, Math.PI * 2);
      b.fill();
    }
  }
  // wear: a few soft, lighter scuffs (smoother, so slightly shinier)
  for (let i = 0; i < Math.round(14 * wear); i++) {
    const x = rng.float(0, s), y = rng.float(0, s), rad = rng.float(s * 0.04, s * 0.14);
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, css(shadeRgb(base, 0.22), 0.16 * wear));
    g.addColorStop(1, css(shadeRgb(base, 0.22), 0));
    c.fillStyle = g;
    c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    const q = r.createRadialGradient(x, y, 0, x, y, rad);
    q.addColorStop(0, `rgba(0,0,0,${0.3 * wear})`);
    q.addColorStop(1, "rgba(0,0,0,0)");
    r.fillStyle = q;
    r.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  grainOverlay(c, s, s, { rng, amount: 0.14, scale: 3, fine: 0.03 });
  const tex = (canvas, srgb) => toTexture(canvas, { srgb, repeat, anisotropy: opts.anisotropy });
  return { map: tex(C.canvas, true), bumpMap: tex(B.canvas, false), roughnessMap: tex(R.canvas, false), canvas: C.canvas, ctx: c };
}

/**
 * A quiet, worn rug: dark border, thin guard stripes, a field of small lozenges and a centre medallion,
 * all under a thread texture. UV 0..1 spans the rug (not tileable).
 * @param {{ size?: number, colors?: { field?: string, border?: string, accent?: string, ivory?: string }, rng?: Function }} [opts]
 * @returns {{ map: CanvasTexture, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function rug(opts = {}) {
  const rng = opts.rng || fallbackRng("rug");
  const s = clampSize(opts.size ?? 1024);
  const col = { field: "#5a3530", border: "#27262d", accent: "#a98556", ivory: "#cfc4ad", ...(opts.colors || {}) };
  const { canvas, ctx: c } = makeCanvas(s);
  c.fillStyle = col.border;
  c.fillRect(0, 0, s, s);
  const stripe = (inset, w, color) => {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.strokeRect(inset, inset, s - inset * 2, s - inset * 2);
  };
  stripe(s * 0.035, s * 0.006, col.accent);
  stripe(s * 0.075, s * 0.012, col.ivory);
  stripe(s * 0.092, s * 0.004, col.accent);
  // border motif: small alternating diamonds between the guard stripes
  const bm = s * 0.055;
  for (let i = 0; i < 28; i++) {
    const t = (i + 0.5) / 28;
    for (const [x, y] of [[t * s, bm], [t * s, s - bm], [bm, t * s], [s - bm, t * s]]) {
      c.fillStyle = i % 2 ? col.accent : shade(col.field, 0.12);
      c.beginPath();
      c.moveTo(x, y - s * 0.008);
      c.lineTo(x + s * 0.008, y);
      c.lineTo(x, y + s * 0.008);
      c.lineTo(x - s * 0.008, y);
      c.fill();
    }
  }
  const f0 = s * 0.105, fs = s - f0 * 2;
  c.fillStyle = col.field;
  c.fillRect(f0, f0, fs, fs);
  c.save();
  c.beginPath();
  c.rect(f0, f0, fs, fs);
  c.clip();
  const n = 14, cell = fs / n;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = f0 + i * cell + (j % 2 ? cell / 2 : 0), y = f0 + j * cell;
      c.fillStyle = (i + j) % 3 === 0 ? shade(col.accent, -0.1, 0.55) : shade(col.field, (i + j) % 2 ? 0.1 : -0.14, 0.8);
      c.beginPath();
      c.moveTo(x, y - cell * 0.3);
      c.lineTo(x + cell * 0.2, y);
      c.lineTo(x, y + cell * 0.3);
      c.lineTo(x - cell * 0.2, y);
      c.fill();
    }
  }
  const m = s / 2;
  const lozenge = (rx, ry, fill, strokeColor) => {
    c.beginPath();
    c.moveTo(m, m - ry);
    c.lineTo(m + rx, m);
    c.lineTo(m, m + ry);
    c.lineTo(m - rx, m);
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (strokeColor) {
      c.strokeStyle = strokeColor;
      c.lineWidth = s * 0.006;
      c.stroke();
    }
  };
  lozenge(s * 0.2, s * 0.27, col.border, col.ivory);
  lozenge(s * 0.15, s * 0.205, shade(col.field, 0.06), col.accent);
  lozenge(s * 0.085, s * 0.12, col.border, col.ivory);
  lozenge(s * 0.035, s * 0.05, col.accent, null);
  c.restore();
  // threads + wear
  c.fillStyle = "rgba(0,0,0,0.07)";
  for (let y = 0; y < s; y += 3) c.fillRect(0, y, s, 1);
  c.fillStyle = "rgba(255,255,255,0.025)";
  for (let x = 0; x < s; x += 3) c.fillRect(x, 0, 1, s);
  grainOverlay(c, s, s, { rng, amount: 0.12, scale: 4, fine: 0.035 });
  return { map: toTexture(canvas, { srgb: true, anisotropy: opts.anisotropy }), canvas, ctx: c };
}
