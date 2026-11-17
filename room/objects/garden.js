// objects/garden.js — the small garden outside the S wall: raked gravel, moss islands, tobi-ishi path,
// a momiji (Japanese maple), a stone lantern that glows at night, a tsukubai, a bamboo clump, clipped
// shrubs and a kenninji-gaki bamboo fence; plus the outdoor training strip on the east side (battle ropes
// you can set going, a prowler sled you can push along its lane, a yoga mat you can sit on) and the
// "elsewhere" notice post / mailbox by the path.
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots, dynamicColliders }.
//
// Draw calls (main pass, 19): ground, moss, rake ring, turf, stone, lantern paper, water, fence slats,
// fence frame, bark, foliage, bamboo culms, ropes, anchor steel, sled frame, sled plates, yoga, mailbox,
// mailbox plaque. Shadow casters (5): fence slats, fence frame, bark, foliage, bamboo culms.
// The only light is the lantern's small non-shadow PointLight; its intensity (and the lantern paper's
// emissive) follow ctx.time.night. The light is never added/removed or hidden (no shader recompiles).

import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const PI = Math.PI;
const TAU = PI * 2;
const FALLBACK_TIME = { hour: 12, day: 1, night: 0, golden: 0 };

// ---- small geometry helpers (build-time only) -------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

/** Apply position / euler rotation / scale to a geometry in place. */
function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
  return g.applyMatrix4(_m);
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** Per-vertex colour attribute; `jitter` adds a little per-vertex brightness noise (rng). */
function tint(g, hex, jitter = 0, rng = null) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = jitter && rng ? 1 + (rng() - 0.5) * 2 * jitter : 1;
    a[i * 3] = c.r * k;
    a[i * 3 + 1] = c.g * k;
    a[i * 3 + 2] = c.b * k;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

/** Hard-edged copy: non-indexed with per-face normals. */
function faceted(g) {
  const f = flat(g);
  f.computeVertexNormals();
  return f;
}

/** Keep only position / normal / uv / color so differently built geometries merge. */
function clean(g) {
  for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}

function merge(list) {
  return mergeGeometries(list.map((g) => clean(flat(g))), false);
}

/** Box-projected UVs from (already world/local placed) positions: tile = metres per texture repeat. */
function projectUV(g, tile, ou = 0, ov = 0) {
  const pos = g.attributes.position;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u / tile + ou;
    uv[i * 2 + 1] = v / tile + ov;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

// smooth deterministic 3D value noise (position-based, so shared polyhedron vertices stay welded)
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise3(x, y, z) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  let fx = x - x0, fy = y - y0, fz = z - z0;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (i, j, k) => hash3(x0 + i, y0 + j, z0 + k);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Rock / stepping-stone: noisy icosphere, bottom buried, optionally cut flat on top.
 * Local origin on the ground; spans w (x) × d (z), top at h. Faceted.
 */
function rockGeometry(w, d, h, seed, { detail = 2, rough = 0.2, flatTop = 0, bury = 0.3 } = {}) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const top = h * (1 + flatTop);
  for (let i = 0; i < p.count; i++) {
    _v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const n1 = vnoise3(_v.x * 1.6 + seed, _v.y * 1.6 + seed * 0.7, _v.z * 1.6 - seed);
    const n2 = vnoise3(_v.x * 4.1 - seed, _v.y * 4.1 + seed, _v.z * 4.1 + seed * 0.3);
    const r = 1 + rough * (n1 - 0.5) * 2 + rough * 0.35 * (n2 - 0.5) * 2;
    let y = ((_v.y * r + bury) / (1 + bury)) * top;
    if (flatTop) y = Math.min(y, h - (n2 - 0.5) * 0.004);
    p.setXYZ(i, (_v.x * r * w) / 2, y, (_v.z * r * d) / 2);
  }
  return faceted(g);
}

/** Smooth noisy blob (canopy pad, shrub, bamboo leaf clump). radii [rx, ry, rz]; underside flattened. */
function blobGeometry(radii, seed, { detail = 3, rough = 0.16, under = 0.55, clipY = null } = {}) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    _v.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
    const n1 = vnoise3(_v.x * 2.1 + seed, _v.y * 2.1 - seed, _v.z * 2.1 + seed * 1.3);
    const n2 = vnoise3(_v.x * 5.3 - seed, _v.y * 5.3 + seed * 0.4, _v.z * 5.3 + seed);
    const r = 1 + rough * (n1 - 0.5) * 2 + rough * 0.45 * (n2 - 0.5) * 2;
    let y = _v.y < 0 ? _v.y * under : _v.y;
    y *= r * radii[1];
    if (clipY !== null) y = Math.max(y, clipY);
    p.setXYZ(i, _v.x * r * radii[0], y, _v.z * r * radii[2]);
    // ambient term baked into the colour: darker underneath and in the noise hollows
    const ao = (0.66 + 0.34 * smooth(-1, 0.9, _v.y)) * (0.88 + 0.24 * n2);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Multiply a colour into a geometry's existing (grey AO) colour attribute, with per-vertex hue noise. */
function colorize(g, hexA, hexB, seed, freq = 1.4) {
  const a = new THREE.Color(hexA), b = new THREE.Color(hexB);
  const p = g.attributes.position;
  const col = g.attributes.color;
  for (let i = 0; i < p.count; i++) {
    const t = vnoise3(p.getX(i) * freq + seed, p.getY(i) * freq, p.getZ(i) * freq - seed);
    _c.copy(a).lerp(b, smooth(0.25, 0.75, t));
    col.setXYZ(i, col.getX(i) * _c.r, col.getY(i) * _c.g, col.getZ(i) * _c.b);
  }
  return g;
}

/**
 * Foliage UVs: un-weld (keeping the smooth normals + colours), then box-project each triangle along its own
 * dominant face axis, so no triangle is smeared across a projection switch. Returns the new geometry.
 */
function foliageUV(g, tile) {
  const f = g.index ? g.toNonIndexed() : g;
  const p = f.attributes.position;
  const uv = new Float32Array(p.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1);
    c.fromBufferAttribute(p, t + 2);
    b.sub(a);
    c.sub(a).cross(b);
    const nx = Math.abs(c.x), ny = Math.abs(c.y), nz = Math.abs(c.z);
    for (let k = 0; k < 3; k++) {
      const x = p.getX(t + k), y = p.getY(t + k), z = p.getZ(t + k);
      let u, v;
      if (ny >= nx && ny >= nz) { u = x; v = z; }
      else if (nx >= nz) { u = z; v = y; }
      else { u = x; v = y; }
      uv[(t + k) * 2] = u / tile;
      uv[(t + k) * 2 + 1] = v / tile;
    }
  }
  f.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return f;
}

/** Tube along a Catmull-Rom curve with radius tapering r0 -> r1 (and a root flare). */
function taperTube(points, segs, radial, r0, r1, flare = 0) {
  const curve = new THREE.CatmullRomCurve3(points);
  const g = new THREE.TubeGeometry(curve, segs, 1, radial, false);
  const pos = g.attributes.position;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    curve.getPointAt(t, _w);
    const r = (r0 + (r1 - r0) * Math.pow(t, 0.85)) * (1 + flare * Math.exp(-t * 14));
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      _v.set(pos.getX(k), pos.getY(k), pos.getZ(k)).sub(_w).multiplyScalar(r).add(_w);
      pos.setXYZ(k, _v.x, _v.y, _v.z);
    }
  }
  g.computeVertexNormals();
  return { geo: g, curve };
}

// ---- textures ---------------------------------------------------------------------------------------

/** CPU-backed canvas (all garden textures are generated per pixel; no thousands of path fills). */
function cv(w, h = w) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
}

/**
 * Tileable cellular texture: a jittered grid of round cells (pebbles, moss cushions, granite grains,
 * leaves), each with its own tone and radius, dome-shaded and lit from the upper left, with darker gaps.
 * Returns { canvas, ctx, height } where height (0..1 per pixel) feeds the bump map.
 */
function cells(T, rng, size, color, o = {}) {
  const { cell = 6, fill = [0.5, 0.75], tone = [-0.2, 0.16], warm = 0.04, gap = 0.62, light = 0.14, low = 0.06, green = 1 } = o;
  const n = Math.max(1, Math.round(size / cell)), cs = size / n, N = n * n;
  const ox = new Float32Array(N), oy = new Float32Array(N), ir = new Float32Array(N), tn = new Float32Array(N), wm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ox[i] = rng() * cs;
    oy[i] = rng() * cs;
    ir[i] = 1 / (cs * rng.float(fill[0], fill[1]));
    tn[i] = rng.float(tone[0], tone[1]);
    wm[i] = rng.float(-warm, warm);
  }
  const LN = 128;
  const lowF = T.noiseField(LN, { rng, scale: 4, octaves: 3 });
  const b = T.rgb(color);
  const { canvas, ctx } = cv(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const height = new Float32Array(size * size);
  const kL = LN / size;
  const wrap = new Int32Array(n + 2); // cell index -1..n -> 0..n-1
  for (let i = -1; i <= n; i++) wrap[i + 1] = ((i % n) + n) % n;
  for (let y = 0; y < size; y++) {
    const gy = Math.min(n - 1, Math.floor(y / cs));
    const lrow = Math.floor(y * kL) * LN;
    for (let x = 0; x < size; x++) {
      const gx = Math.min(n - 1, Math.floor(x / cs));
      let best = 1e9, bi = 0, bdx = 0, bdy = 0;
      for (let j = -1; j <= 1; j++) {
        const cy = gy + j;
        const row = wrap[cy + 1] * n;
        for (let i = -1; i <= 1; i++) {
          const cx = gx + i;
          const idx = row + wrap[cx + 1];
          const dx = (x + 0.5 - cx * cs - ox[idx]) * ir[idx];
          const dy = (y + 0.5 - cy * cs - oy[idx]) * ir[idx];
          const dd = dx * dx + dy * dy;
          if (dd < best) {
            best = dd;
            bi = idx;
            bdx = dx;
            bdy = dy;
          }
        }
      }
      const lf = 1 + low * (lowF[lrow + Math.floor(x * kL)] - 0.5) * 2;
      let k, h, w = 0, gk = 1;
      if (best < 1) {
        h = Math.sqrt(1 - best);
        k = (1 + tn[bi] - light * (bdx + bdy) * 0.7) * (0.8 + 0.2 * h);
        w = wm[bi];
        gk = 1 + (green - 1) * tn[bi];
      } else {
        h = 0;
        k = gap * (1 + tn[bi] * 0.4);
      }
      k *= lf;
      const i4 = (y * size + x) * 4;
      d[i4] = b[0] * k * (1 + w);
      d[i4 + 1] = b[1] * k * gk;
      d[i4 + 2] = b[2] * k * (1 - w * 1.2);
      d[i4 + 3] = 255;
      height[y * size + x] = h;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, ctx, height, size };
}

/** Grey canvas from a height array (+ optional per-pixel extra array in -1..1, NaN = none, and its weight). */
function heightCanvas(src, extra = null, wExtra = 0) {
  const { size, height } = src;
  const { canvas, ctx } = cv(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const e = extra ? extra[i] : 0;
      const v = (0.35 + 0.5 * height[i] * (1 - wExtra) + (Number.isNaN(e) ? 0 : 0.5 * wExtra * e)) * 255;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Rake a cellular gravel canvas in place: groove(x, y) in [-1, 1] (+1 ridge, NaN = untouched).
 * Returns { color, bump } canvases.
 */
function rake(src, groove, shadeAmt = 0.17) {
  const { size, ctx } = src;
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const gv = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = (gv[y * size + x] = groove(x, y));
      if (Number.isNaN(g)) continue;
      const i = (y * size + x) * 4;
      const k = 1 + shadeAmt * g;
      d[i] *= k;
      d[i + 1] *= k;
      d[i + 2] *= k;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { color: src.canvas, bump: heightCanvas(src, gv, 0.6) };
}

/** Tileable streaky grain running along x (wood, bark, frame timber, turf bump). */
function streaks(T, rng, w, h, color, amount = 0.18, fine = 0.06) {
  const { canvas, ctx } = cv(w, h);
  const b = T.rgb(color);
  const ph = Array.from({ length: 6 }, () => rng() * TAU);
  const rowA = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const t = (y / h) * TAU;
    rowA[y] = 0.45 * Math.sin(3 * t + ph[0]) + 0.3 * Math.sin(7 * t + ph[1]) + 0.22 * Math.sin(19 * t + ph[2]) + 0.16 * Math.sin(43 * t + ph[3]);
  }
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w) * TAU;
      const k = 1 + amount * (rowA[y] * (0.75 + 0.25 * Math.sin(2 * t + ph[4])) + 0.15 * Math.sin(5 * t + ph[5] + rowA[y] * 3)) + fine * (rng() - 0.5) * 2;
      const i = (y * w + x) * 4;
      d[i] = b[0] * k;
      d[i + 1] = b[1] * k;
      d[i + 2] = b[2] * k;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Colour + bump textures from a cellular canvas. */
function cellTextures(T, src, opts = {}) {
  return {
    map: T.toTexture(src.canvas, { srgb: true, wrap: true, ...opts }),
    bump: T.toTexture(heightCanvas(src), { srgb: false, wrap: true, ...opts }),
  };
}

// ---- build ------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const G = layout.garden;
  const rng = ctx.rng.fork("garden");
  const T = ctx.textures;
  const GY = G.groundY;
  const B = G.bounds;

  const root = new THREE.Group();
  root.name = "garden";

  const casters = (m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const receiver = (m) => {
    m.castShadow = false;
    m.receiveShadow = true;
    return m;
  };
  const invisible = new THREE.MeshBasicMaterial({ visible: false });
  invisible.name = "gardenPick";

  // ================================================================================================
  // ground: raked gravel, moss islands, rake ring, turf
  // ================================================================================================
  const GW = B.maxX - B.minX, GD = B.maxZ - B.minZ;
  const GCX = (B.minX + B.maxX) / 2, GCZ = (B.minZ + B.maxZ) / 2;
  const tile = G.gravel.tile;
  const S = 1024;
  const grooves = Math.max(1, Math.round(tile / G.gravel.rakePitch)); // whole number per tile: seamless
  const gravelCells = { cell: 6.5, fill: [0.48, 0.72], tone: [-0.2, 0.15], warm: 0.05, gap: 0.66, light: 0.16, low: 0.05 };
  const peb = cells(T, rng.fork("gravel"), S, G.gravel.color, gravelCells);
  const wav = (2 * PI * 3) / S; // three gentle wobbles per tile in x keeps it seamless
  const rakedGround = rake(peb, (x, y) => Math.cos(((y + 2.2 * Math.sin(x * wav)) / S) * grooves * TAU));
  const gravelMap = T.toTexture(rakedGround.color, { srgb: true, repeat: [GW / tile, GD / tile] });
  const gravelBump = T.toTexture(rakedGround.bump, { srgb: false, repeat: [GW / tile, GD / tile] });
  const gravelMat = new THREE.MeshStandardMaterial({ map: gravelMap, bumpMap: gravelBump, bumpScale: 1.6, roughness: 0.96, vertexColors: true });
  gravelMat.name = "gravel";

  // subdivided plane: low-frequency tone (damp edges along the fence + house, shade under the maple)
  const groundGeo = new THREE.PlaneGeometry(GW, GD, 50, 40).rotateX(-PI / 2);
  {
    const p = groundGeo.attributes.position;
    const col = new Float32Array(p.count * 3);
    const tr = G.tree.pos;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + GCX, z = p.getZ(i) + GCZ;
      let k = 1 + 0.08 * (vnoise3(x * 0.7, 3.1, z * 0.7) - 0.5) * 2;
      const edge = Math.min(x - B.minX, B.maxX - x, B.maxZ - z, z - B.minZ);
      k *= 0.86 + 0.14 * smooth(0.0, 0.5, edge);
      k *= 0.9 + 0.1 * smooth(0.6, 2.2, Math.hypot(x - tr[0], z - tr[2]));
      col[i * 3] = k;
      col[i * 3 + 1] = k;
      col[i * 3 + 2] = k * 0.99;
    }
    groundGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  }
  const ground = receiver(new THREE.Mesh(groundGeo, gravelMat));
  ground.name = "gardenGround";
  ground.position.set(GCX, GY, GCZ);
  root.add(ground);

  // moss islands: radial grids with a soft mound, clipped to the fence line
  const mossTile = 0.9;
  const mossTex = cellTextures(T, cells(T, rng.fork("moss"), 512, G.moss.color, { cell: 4, fill: [0.6, 0.95], tone: [-0.32, 0.26], warm: 0.03, gap: 0.55, light: 0.12, low: 0.2, green: 1.15 }));
  const mossMat = new THREE.MeshStandardMaterial({ map: mossTex.map, bumpMap: mossTex.bump, bumpScale: 2.5, roughness: 0.97, vertexColors: true });
  mossMat.name = "moss";
  const mossParts = [];
  const mossRng = rng.fork("mossShape");
  const inX0 = B.minX + 0.07, inX1 = B.maxX - 0.07, inZ0 = B.minZ + 0.04, inZ1 = B.maxZ - 0.07;
  for (const [mx, mz, rx, rz, mound = 0.03] of G.moss.patches) {
    const segs = 48, rings = 6;
    const ph = [mossRng.float(0, TAU), mossRng.float(0, TAU), mossRng.float(0, TAU)];
    const radius = (a) => 1 + 0.1 * Math.sin(3 * a + ph[0]) + 0.06 * Math.sin(5 * a + ph[1]) + 0.04 * Math.sin(9 * a + ph[2]);
    const verts = [], cols = [], idx = [];
    const seed = mossRng.float(0, 50);
    verts.push(mx, GY + 0.004 + mound, mz);
    cols.push(1, 1, 1);
    for (let r = 1; r <= rings; r++) {
      const rho = r / rings;
      for (let s = 0; s < segs; s++) {
        const a = (s / segs) * TAU;
        const R = radius(a) * rho;
        const x = Math.max(inX0, Math.min(inX1, mx + Math.cos(a) * rx * R));
        const z = Math.max(inZ0, Math.min(inZ1, mz + Math.sin(a) * rz * R));
        const n = vnoise3(x * 1.8 + seed, 0.5, z * 1.8);
        const h = 0.003 + mound * (1 - Math.pow(rho, 4)) * (0.55 + 0.9 * n);
        verts.push(x, GY + 0.001 + h + (r === rings ? 0 : 0.002), z);
        const k = (0.8 + 0.3 * n) * (r === rings ? 0.82 : 1);
        cols.push(k, k, k * 0.95);
      }
    }
    for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
    for (let r = 1; r < rings; r++) {
      const a0 = 1 + (r - 1) * segs, a1 = 1 + r * segs;
      for (let s = 0; s < segs; s++) {
        const s1 = (s + 1) % segs;
        idx.push(a0 + s, a0 + s1, a1 + s, a0 + s1, a1 + s1, a1 + s);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const uv = new Float32Array((verts.length / 3) * 2);
    for (let i = 0; i < verts.length / 3; i++) {
      uv[i * 2] = verts[i * 3] / mossTile;
      uv[i * 2 + 1] = verts[i * 3 + 2] / mossTile;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    mossParts.push(g);
  }
  const moss = receiver(new THREE.Mesh(merge(mossParts), mossMat));
  moss.name = "gardenMoss";
  root.add(moss);

  // rake rings: concentric grooves round the rock island (opaque disc over the straight raking)
  const ringParts = [];
  let ringMat = null;
  if (G.rings && G.rings.length) {
    const R0 = G.rings[0][2];
    const RS = Math.min(1024, Math.round(((2 * R0) / tile) * S));
    const rc = cells(T, rng.fork("ringGravel"), RS, G.gravel.color, gravelCells);
    const pitchPx = (G.gravel.rakePitch / tile) * S;
    const c0 = RS / 2;
    const ring = rake(rc, (x, y) => {
      const r = Math.hypot(x - c0, y - c0);
      return Math.cos((r / pitchPx) * TAU);
    });
    const rMap = T.toTexture(ring.color, { srgb: true });
    const rBump = T.toTexture(ring.bump, { srgb: false });
    ringMat = new THREE.MeshStandardMaterial({ map: rMap, bumpMap: rBump, bumpScale: 1.6, roughness: 0.96, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    ringMat.name = "rakeRing";
    for (const [x, z, r] of G.rings) {
      const g = new THREE.CircleGeometry(r, 72).rotateX(-PI / 2);
      g.translate(x, GY + 0.0015, z);
      ringParts.push(g);
    }
    const rings = receiver(new THREE.Mesh(merge(ringParts), ringMat));
    rings.name = "gardenRakeRings";
    root.add(rings);
  }

  // turf strip: dark artificial turf, lane lines for the sled, mapped once
  const TF = G.turf;
  const SL = G.sled;
  const turfMinX = TF.pos[0] - TF.width / 2, turfMinZ = TF.pos[2] - TF.length / 2;
  const turfCanvas = cv(256, 1024);
  {
    const c = turfCanvas.ctx;
    const W = 256, H = 1024;
    c.fillStyle = TF.color;
    c.fillRect(0, 0, W, H);
    const tr = rng.fork("turf");
    const b = T.rgb(TF.color);
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    const colTone = new Float32Array(W);
    for (let x = 0; x < W; x++) colTone[x] = tr.float(-0.12, 0.12);
    for (let i = 0; i < W * H; i++) {
      const k = 1 + colTone[i % W] + tr.float(-0.3, 0.35);
      d[i * 4] = b[0] * k;
      d[i * 4 + 1] = b[1] * k * 1.03;
      d[i * 4 + 2] = b[2] * k;
    }
    c.putImageData(img, 0, 0);
    T.grainOverlay(c, W, H, { rng: tr, amount: 0.1, scale: 3, fine: 0.03 });
    const px = (x) => ((x - turfMinX) / TF.width) * W;
    const pz = (z) => ((z - turfMinZ) / TF.length) * H;
    c.fillStyle = "rgba(226,222,208,0.55)"; // worn painted lines
    const lw = Math.max(2, (0.05 / TF.width) * W);
    const laneHalf = SL.width / 2 + 0.09;
    const zEnd0 = pz(SL.laneZ[0] - SL.length / 2 - 0.08), zEnd1 = pz(SL.laneZ[1] + SL.length / 2 + 0.08);
    for (const lx of [SL.laneX - laneHalf, SL.laneX + laneHalf]) c.fillRect(px(lx) - lw / 2, zEnd0, lw, zEnd1 - zEnd0);
    for (const zz of [zEnd0, zEnd1]) c.fillRect(px(SL.laneX - laneHalf), zz - lw / 2, px(SL.laneX + laneHalf) - px(SL.laneX - laneHalf), lw);
    // 5 m mark
    c.fillRect(px(SL.laneX - laneHalf), pz(SL.laneZ[0] - SL.length / 2 - 0.08 + 5) - lw / 4, px(SL.laneX + laneHalf) - px(SL.laneX - laneHalf), lw / 2);
    T.grainOverlay(c, W, H, { rng: tr, amount: 0.06, scale: 6, fine: 0.0 });
  }
  const turfMap = T.toTexture(turfCanvas.canvas, { srgb: true });
  turfMap.flipY = false; // canvas row 0 = north end (min z)
  const turfBump = T.toTexture(streaks(T, rng.fork("turfBump"), 128, 128, "#808080", 0.1, 0.45), { srgb: false, repeat: [TF.width / 0.2, TF.length / 0.2] });
  const turfMat = new THREE.MeshStandardMaterial({ map: turfMap, bumpMap: turfBump, bumpScale: 2.2, roughness: 0.93 });
  turfMat.name = "turf";
  const turfGeo = new THREE.BoxGeometry(TF.width, 0.012, TF.length);
  {
    // top face UVs: u = x across, v = z along (row 0 at min z, flipY off)
    const p = turfGeo.attributes.position, uv = turfGeo.attributes.uv, n = turfGeo.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      if (n.getY(i) > 0.5) uv.setXY(i, (p.getX(i) + TF.width / 2) / TF.width, (p.getZ(i) + TF.length / 2) / TF.length);
      else uv.setXY(i, 0.02, 0.02);
    }
  }
  const turf = receiver(new THREE.Mesh(turfGeo, turfMat));
  turf.name = "turf";
  turf.position.set(TF.pos[0], GY + 0.006, TF.pos[2]);
  root.add(turf);
  const turfTop = GY + 0.012;

  // ================================================================================================
  // stone: stepping stones, rocks, lantern, basin (one granite material, tinted per vertex)
  // ================================================================================================
  const graniteTex = cellTextures(T, cells(T, rng.fork("granite"), 512, "#b9b4ab", { cell: 2.6, fill: [0.7, 1.0], tone: [-0.42, 0.34], warm: 0.03, gap: 0.8, light: 0, low: 0.14 }));
  const stoneMat = new THREE.MeshStandardMaterial({ map: graniteTex.map, bumpMap: graniteTex.bump, bumpScale: 1.4, roughness: 0.86, vertexColors: true });
  stoneMat.name = "gardenStone";
  const stoneParts = [];
  const srng = rng.fork("stones");

  // tobi-ishi: flat-topped, sunk so the top sits ~4 cm proud
  for (const [x, z, size] of G.stones) {
    const w = size * srng.float(0.95, 1.12), d = size * srng.float(0.78, 0.95);
    const g = rockGeometry(w, d, 0.045, srng.float(0, 90), { detail: 2, rough: 0.12, flatTop: 1.6, bury: 0.6 });
    xf(g, [x, GY, z], [0, srng.float(0, PI), 0]);
    projectUV(g, 0.6, srng(), srng());
    stoneParts.push(tint(g, srng.pick(["#d6d1c6", "#cdc8be", "#c4c0b8", "#dcd5c8"]), 0.05, srng));
  }
  // rocks
  for (const [x, z, w, d, h, r] of G.rocks) {
    const g = rockGeometry(w, d, h, srng.float(0, 90), { detail: 3, rough: 0.2, bury: 0.45 });
    xf(g, [x, GY, z], [0, r, 0]);
    projectUV(g, 0.8, srng(), srng());
    // lichen-dark at the foot, paler on top
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const base = new THREE.Color(srng.pick(["#bdb8ae", "#c6c0b5", "#b3afa7"]));
    const foot = new THREE.Color("#69744f");
    for (let i = 0; i < p.count; i++) {
      const t = smooth(0, h * 0.45, p.getY(i) - GY);
      _c.copy(foot).lerp(base, 0.35 + 0.65 * t).multiplyScalar(0.92 + 0.16 * srng());
      col.set([_c.r, _c.g, _c.b], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    stoneParts.push(g);
  }

  // stone lantern (Kasuga-style): base, pillar, platform, light box (corner posts), roof, finial
  const LN = G.lantern;
  const lanternParts = [];
  const lantStone = "#d2cdc3";
  {
    const H = LN.height / 1.32; // proportions authored for 1.32 m
    const add = (g, y, ry = 0) => {
      xf(g, [0, y * H, 0], [0, ry, 0]);
      lanternParts.push(tint(faceted(g), lantStone, 0.06, srng));
    };
    add(new THREE.CylinderGeometry(0.2, 0.23, 0.1 * H, 6), 0.05);
    add(new THREE.CylinderGeometry(0.15, 0.19, 0.05 * H, 6), 0.125);
    add(new THREE.CylinderGeometry(0.068, 0.078, 0.45 * H, 12), 0.375);
    add(new THREE.CylinderGeometry(0.075, 0.075, 0.025 * H, 12), 0.5);
    add(new THREE.CylinderGeometry(0.2, 0.13, 0.09 * H, 6), 0.645);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + PI / 6;
      const post = new THREE.BoxGeometry(0.045, 0.24 * H, 0.045);
      xf(post, [Math.sin(a) * 0.135, 0, Math.cos(a) * 0.135], [0, a, 0]);
      add(post, 0.81);
    }
    add(new THREE.CylinderGeometry(0.17, 0.165, 0.03 * H, 6), 0.945);
    add(new THREE.CylinderGeometry(0.315, 0.3, 0.03 * H, 6), 0.975);
    add(new THREE.CylinderGeometry(0.05, 0.3, 0.17 * H, 6), 1.075);
    add(new THREE.CylinderGeometry(0.045, 0.055, 0.04 * H, 8), 1.18);
    const hoju = new THREE.SphereGeometry(0.052, 10, 8);
    hoju.scale(1, 1.15, 1);
    add(hoju, 1.245);
    const tip = new THREE.ConeGeometry(0.022, 0.045, 8);
    add(tip, 1.3);
    // weathering: darker, mossy toward the foot
    const foot = new THREE.Color("#7a8360");
    for (const g of lanternParts) {
      xf(g, [LN.pos[0], GY, LN.pos[2]], [0, 0, 0]);
      const p = g.attributes.position, col = g.attributes.color;
      for (let i = 0; i < p.count; i++) {
        const t = smooth(0, 0.35, p.getY(i) - GY);
        _c.setRGB(col.getX(i), col.getY(i), col.getZ(i)).lerp(foot, 0.55 * (1 - t));
        col.setXYZ(i, _c.r, _c.g, _c.b);
      }
    }
    // yaw about the lantern's axis
    for (const g of lanternParts) {
      g.translate(-LN.pos[0], 0, -LN.pos[2]);
      g.rotateY(LN.rotY);
      g.translate(LN.pos[0], 0, LN.pos[2]);
      projectUV(g, 0.5, 0.3, 0.7);
      stoneParts.push(g);
    }
  }

  // tsukubai: lathe bowl
  const BS = G.basin;
  {
    const R = BS.diameter / 2, H = BS.height;
    const prof = [
      [0.001, -0.05], [R * 0.82, -0.05], [R * 0.96, H * 0.25], [R, H * 0.6], [R * 0.95, H * 0.93], [R * 0.88, H],
      [R * 0.58, H * 1.01], [R * 0.52, H * 0.95], [R * 0.47, H * 0.7], [R * 0.3, H * 0.58], [0.001, H * 0.56],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(prof, 22);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = 1 + 0.06 * (vnoise3(x * 9, y * 9, z * 9) - 0.5);
      p.setXYZ(i, x * k, y, z * k);
    }
    const fg = faceted(g);
    xf(fg, [BS.pos[0], GY, BS.pos[2]]);
    projectUV(fg, 0.5);
    tint(fg, "#c8c3b9", 0.06, srng);
    const pc = fg.attributes.position, cc = fg.attributes.color;
    for (let i = 0; i < pc.count; i++) {
      const t = smooth(0, 0.18, pc.getY(i) - GY);
      _c.setRGB(cc.getX(i), cc.getY(i), cc.getZ(i)).lerp(new THREE.Color("#6d7a52"), 0.5 * (1 - t));
      cc.setXYZ(i, _c.r, _c.g, _c.b);
    }
    stoneParts.push(fg);
  }
  const stone = receiver(new THREE.Mesh(merge(stoneParts), stoneMat));
  stone.name = "gardenStone";
  root.add(stone);

  // water in the basin
  const waterMat = new THREE.MeshStandardMaterial({ color: "#1d2a27", roughness: 0.06, metalness: 0.0, envMapIntensity: 1.2 });
  waterMat.name = "basinWater";
  const water = new THREE.Mesh(new THREE.CircleGeometry((BS.diameter / 2) * 0.5, 24).rotateX(-PI / 2), waterMat);
  water.name = "basinWater";
  water.position.set(BS.pos[0], GY + BS.height * 0.86, BS.pos[2]);
  water.receiveShadow = true;
  root.add(water);

  // lantern paper (glows at night) + the small light
  const LH = LN.height / 1.32;
  const paperMap = T.toTexture(streaks(T, rng.fork("paper"), 128, 128, "#efe2c4", 0.05, 0.05), { srgb: true, wrap: true });
  const paperMat = new THREE.MeshStandardMaterial({ map: paperMap, color: "#eedcb8", roughness: 0.9, emissive: new THREE.Color("#ff9a3c"), emissiveIntensity: 0.0 });
  paperMat.name = "lanternPaper";
  const paperGeo = new THREE.CylinderGeometry(0.112, 0.112, 0.22 * LH, 6);
  const paper = new THREE.Mesh(paperGeo, paperMat);
  paper.name = "lanternPaper";
  paper.position.set(LN.pos[0], GY + 0.81 * LH, LN.pos[2]);
  paper.rotation.y = LN.rotY + PI / 6;
  root.add(paper);
  const lanternLight = new THREE.PointLight("#ffb466", 0, 4.5, 2);
  lanternLight.name = "lanternLight";
  lanternLight.castShadow = false;
  lanternLight.position.set(LN.pos[0], GY + 0.83 * LH, LN.pos[2]);
  root.add(lanternLight);

  // ================================================================================================
  // fence: kenninji-gaki (split bamboo slats, instanced in units of 4) + timber posts + bamboo rails
  // ================================================================================================
  const F = G.fence;
  const slatR = F.slatWidth / 2;
  const slatH = F.height - 0.07;
  const slatCanvas = cv(64, 1024);
  {
    const c = slatCanvas.ctx;
    const fr = rng.fork("slat");
    c.fillStyle = "#e6dcc0";
    c.fillRect(0, 0, 64, 1024);
    for (let i = 0; i < 90; i++) {
      // fibres along the slat (v)
      c.fillStyle = fr.chance(0.5) ? "rgba(120,100,60,0.12)" : "rgba(255,250,235,0.18)";
      c.fillRect(fr() * 64, 0, fr.float(0.6, 2), 1024);
    }
    for (let y = fr.float(60, 180); y < 1024; y += fr.float(200, 260)) {
      // nodes: dark ring with a pale ridge
      c.fillStyle = "rgba(70,55,35,0.3)";
      c.fillRect(0, y, 64, 4);
      c.fillStyle = "rgba(255,248,225,0.3)";
      c.fillRect(0, y + 5, 64, 3);
    }
    T.grainOverlay(c, 64, 1024, { rng: fr, amount: 0.12, scale: 4, fine: 0.04 });
  }
  const slatMap = T.toTexture(slatCanvas.canvas, { srgb: true, wrap: true });
  const slatMat = new THREE.MeshStandardMaterial({ color: F.bamboo, map: slatMap, roughness: 0.66, side: THREE.DoubleSide });
  slatMat.name = "fenceSlats";
  const UNIT = 4;
  const unitParts = [];
  for (let k = 0; k < UNIT; k++) {
    const g = new THREE.CylinderGeometry(slatR, slatR, 1, 6, 1, true, -PI / 2, PI);
    g.translate(0, 0.5, 0);
    const uv = g.attributes.uv;
    const off = (k * 0.37) % 1;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 0.95 + off);
    g.translate((k - (UNIT - 1) / 2) * F.slatWidth, 0, (k % 2) * 0.003);
    unitParts.push(g);
  }
  const unitGeo = merge(unitParts);
  const fenceRng = rng.fork("fence");
  const runs = F.runs.map(([x0, z0, x1, z1]) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len, dz = (z1 - z0) / len;
    // inward normal: the side the garden centre is on
    let nx = -dz, nz = dx;
    if ((GCX - x0) * nx + (GCZ - z0) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { x0, z0, x1, z1, len, dx, dz, nx, nz };
  });
  let unitCount = 0;
  for (const r of runs) unitCount += Math.floor((r.len - F.postSize) / (F.slatWidth * UNIT));
  const slats = casters(new THREE.InstancedMesh(unitGeo, slatMat, unitCount));
  slats.name = "fenceSlats";
  const frameParts = [];
  const timber = F.timber, railHex = T.shade(F.bamboo, -0.12);
  let ui = 0;
  for (const r of runs) {
    const n = Math.floor((r.len - F.postSize) / (F.slatWidth * UNIT));
    const used = n * F.slatWidth * UNIT;
    const start = (r.len - used) / 2 + (F.slatWidth * UNIT) / 2;
    const yaw = Math.atan2(r.nx, r.nz); // local +z -> inward
    const ox = r.x0 + r.nx * F.inset, oz = r.z0 + r.nz * F.inset;
    for (let i = 0; i < n; i++) {
      const s = start + i * F.slatWidth * UNIT;
      _e.set(0, yaw, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(ox + r.dx * s, GY + 0.025, oz + r.dz * s), _q, _s.set(1, slatH - 0.02, 1));
      slats.setMatrixAt(ui, _m);
      const k = fenceRng.float(0.88, 1.06);
      slats.setColorAt(ui, _c.setRGB(k, k * fenceRng.float(0.98, 1.02), k * fenceRng.float(0.94, 1.0)));
      ui++;
    }
    // posts
    const posts = Math.max(1, Math.round(r.len / F.postSpacing));
    for (let i = 0; i <= posts; i++) {
      const s = (i / posts) * r.len;
      const g = new THREE.BoxGeometry(F.postSize, F.height + 0.12, F.postSize);
      xf(g, [ox + r.dx * s, GY + (F.height + 0.12) / 2 - 0.02, oz + r.dz * s], [0, yaw, 0]);
      frameParts.push(tint(g, timber, 0.04, fenceRng));
      const cap = new THREE.BoxGeometry(F.postSize + 0.02, 0.025, F.postSize + 0.02);
      xf(cap, [ox + r.dx * s, GY + F.height + 0.1 + 0.0125, oz + r.dz * s], [0, yaw, 0]);
      frameParts.push(tint(cap, T.shade(timber, -0.2)));
    }
    // horizontal split-bamboo rails on both faces + a round bamboo cap along the top
    const railLen = r.len;
    const mx = ox + (r.dx * railLen) / 2, mz = oz + (r.dz * railLen) / 2;
    for (const side of [1, -1]) {
      for (const y of F.rails) {
        const g = new THREE.CylinderGeometry(0.017, 0.017, railLen, 8, 1, true);
        g.rotateZ(PI / 2);
        xf(g, [0, 0, 0], [0, yaw, 0]);
        xf(g, [mx + side * r.nx * (slatR + 0.016), GY + y, mz + side * r.nz * (slatR + 0.016)]);
        frameParts.push(tint(g, railHex, 0.05, fenceRng));
      }
    }
    const cap = new THREE.CylinderGeometry(0.038, 0.038, railLen, 10, 1, true);
    cap.rotateZ(PI / 2);
    xf(cap, [0, 0, 0], [0, yaw, 0]);
    xf(cap, [mx, GY + slatH + 0.03, mz]);
    frameParts.push(tint(cap, T.shade(F.bamboo, -0.05), 0.04, fenceRng));
    // dark palm-rope ties where the rails cross the posts
    for (let i = 0; i <= posts; i++) {
      const s = (i / posts) * r.len;
      for (const y of F.rails) {
        const t = new THREE.BoxGeometry(F.postSize + 0.03, 0.03, F.postSize + 0.055);
        xf(t, [ox + r.dx * s, GY + y, oz + r.dz * s], [0, yaw, 0]);
        frameParts.push(tint(t, "#1c1814"));
      }
    }
  }
  slats.instanceMatrix.needsUpdate = true;
  if (slats.instanceColor) slats.instanceColor.needsUpdate = true;
  root.add(slats);
  const frameTex = T.toTexture(streaks(T, rng.fork("frameTex"), 256, 256, "#d8d2c8", 0.14, 0.05), { srgb: true, wrap: true });
  const frameMat = new THREE.MeshStandardMaterial({ map: frameTex, vertexColors: true, roughness: 0.78, side: THREE.DoubleSide });
  frameMat.name = "fenceFrame";
  const frameGeo = merge(frameParts);
  projectUV(frameGeo, 0.7);
  const frame = casters(new THREE.Mesh(frameGeo, frameMat));
  frame.name = "fenceFrame";
  root.add(frame);

  // ================================================================================================
  // planting: maple (bark + foliage), shrubs, bamboo (culms + leaf clumps into the foliage mesh)
  // ================================================================================================
  const TR = G.tree;
  const tx = TR.pos[0], tz = TR.pos[2];
  const barkCanvas = { canvas: streaks(T, rng.fork("bark"), 256, 256, "#6f655c", 0.35, 0.1) };
  const barkMap = T.toTexture(barkCanvas.canvas, { srgb: true, repeat: [5, 1] });
  const barkMat = new THREE.MeshStandardMaterial({ map: barkMap, bumpMap: barkMap, bumpScale: 1.5, color: "#c9bfb6", roughness: 0.9 });
  barkMat.name = "bark";

  const trng = rng.fork("tree");
  const P = (x, y, z) => new THREE.Vector3(tx + x, GY + y, tz + z);
  const trunkPts = [P(0, -0.1, 0), P(0.03, 0.45, 0.02), P(0.17, 0.95, -0.03), P(0.3, 1.4, 0.0), P(0.27, 1.85, 0.07), P(0.12, 2.35, 0.02), P(0.2, 2.7, -0.05)];
  const trunk = taperTube(trunkPts, 28, 9, TR.trunk, TR.trunk * 0.32, 0.55);
  const barkParts = [trunk.geo];
  // canopy pads: [x, y, z, rx, ry, rz] relative to the trunk base (y above ground)
  const sc = TR.canopy / 1.75;
  const pads = [
    [0.25, 2.95, 0.0, 1.0, 0.42, 0.9],
    [-0.75, 2.25, 0.35, 0.85, 0.34, 0.75],
    [1.1, 2.15, -0.35, 0.82, 0.32, 0.72],
    [0.05, 2.2, -0.9, 0.72, 0.3, 0.62],
    [0.85, 2.55, 0.75, 0.72, 0.32, 0.62],
    [-0.35, 2.9, -0.4, 0.62, 0.3, 0.56],
    [1.55, 1.75, 0.3, 0.55, 0.26, 0.5],
    [-0.55, 1.75, -0.35, 0.5, 0.24, 0.45],
  ].map(([x, y, z, rx, ry, rz]) => [x * sc, y * (TR.height / 3.5), z * sc, rx * sc, ry * 1.45, rz * sc]);
  for (const [x, y, z] of pads) {
    // branch from the trunk to under the pad's centre
    const t0 = Math.max(0.3, Math.min(0.85, (y - 0.9) / 2.4));
    const a = trunk.curve.getPointAt(t0, new THREE.Vector3());
    const end = P(x * 0.85, y - 0.12, z * 0.85);
    const mid = a.clone().lerp(end, 0.5);
    mid.y += 0.12;
    const br = taperTube([a, mid, end], 10, 6, 0.045 * (1 - t0 * 0.5), 0.012);
    barkParts.push(br.geo);
    // two twigs fanning into the pad
    for (let k = 0; k < 2; k++) {
      const tip = P(x + trng.float(-0.35, 0.35), y + trng.float(-0.05, 0.12), z + trng.float(-0.35, 0.35));
      const tw = taperTube([end, end.clone().lerp(tip, 0.5).add(_v.set(0, 0.06, 0)), tip], 6, 4, 0.014, 0.004);
      barkParts.push(tw.geo);
    }
  }
  const bark = casters(new THREE.Mesh(merge(barkParts.map((g) => tint(g, "#ffffff"))), barkMat));
  bark.name = "mapleBark";
  root.add(bark);

  // foliage texture: small leaf speckles, near white (vertex colour carries the hue)
  const leafTex = cellTextures(T, cells(T, rng.fork("leaf"), 512, "#c4c4c4", { cell: 9, fill: [0.6, 0.9], tone: [-0.38, 0.28], warm: 0, gap: 0.42, light: 0.22, low: 0.12 }));
  const leafMap = leafTex.map;
  const leafBump = leafTex.bump;
  const foliageMat = new THREE.MeshStandardMaterial({ map: leafMap, bumpMap: leafBump, bumpScale: 3, vertexColors: true, roughness: 0.8 });
  foliageMat.name = "foliage";
  const foliageParts = [];
  const leafHue = new THREE.Color(TR.color);
  pads.forEach(([x, y, z, rx, ry, rz], i) => {
    const g = blobGeometry([rx, ry, rz], 11 + i * 7.3, { detail: 3, rough: 0.22, under: 0.5 });
    g.translate(tx + x, GY + y, tz + z);
    colorize(g, leafHue.getStyle(), i % 3 === 0 ? "#c4602c" : "#8e2a1e", i * 3.1, 1.6);
    foliageParts.push(foliageUV(g, 0.8));
  });
  // shrubs: clipped mounds
  G.shrubs.forEach(([x, z, dia, h], i) => {
    const g = blobGeometry([dia / 2, h, dia / 2], 40 + i * 5.1, { detail: 3, rough: 0.1, under: 0.3, clipY: -0.02 });
    g.translate(x, GY, z);
    colorize(g, "#3c5230", "#556b34", i * 2.3, 2.2);
    foliageParts.push(foliageUV(g, 0.3));
  });
  // bamboo: culms (instanced) + leaf clumps
  const BB = G.bamboo;
  const brng = rng.fork("bamboo");
  const culmCanvas = cv(64, 512);
  {
    const c = culmCanvas.ctx;
    const grd = c.createLinearGradient(0, 0, 64, 0);
    grd.addColorStop(0, "#c9c98f");
    grd.addColorStop(0.5, "#e6e6b8");
    grd.addColorStop(1, "#c9c98f");
    c.fillStyle = grd;
    c.fillRect(0, 0, 64, 512);
    for (let y = 30; y < 512; y += 42) {
      c.fillStyle = "rgba(80,85,40,0.55)";
      c.fillRect(0, y, 64, 3);
      c.fillStyle = "rgba(255,255,240,0.6)";
      c.fillRect(0, y + 3, 64, 4);
    }
    T.grainOverlay(c, 64, 512, { rng: brng, amount: 0.08, scale: 4, fine: 0.03 });
  }
  const culmMap = T.toTexture(culmCanvas.canvas, { srgb: true, wrap: true });
  const culmMat = new THREE.MeshStandardMaterial({ map: culmMap, color: "#8d9a4a", roughness: 0.45 });
  culmMat.name = "bambooCulm";
  const culmGeo = new THREE.CylinderGeometry(1, 1.08, 1, 8, 1, true).translate(0, 0.5, 0);
  const culms = casters(new THREE.InstancedMesh(culmGeo, culmMat, BB.culms));
  culms.name = "bambooCulms";
  const culmTops = [];
  for (let i = 0; i < BB.culms; i++) {
    const a = (i / BB.culms) * TAU + brng.float(-0.3, 0.3);
    const rr = BB.radius * Math.sqrt(brng.float(0.05, 1));
    const x = BB.pos[0] + Math.cos(a) * rr, z = BB.pos[2] + Math.sin(a) * rr;
    const h = brng.float(BB.height[0], BB.height[1]);
    const rad = brng.float(BB.culmRadius[0], BB.culmRadius[1]);
    // lean outward a little, mostly toward the open garden (north-east)
    const lx = 0.05 + 0.04 * Math.cos(a), lz = -0.05 + 0.04 * Math.sin(a);
    _e.set(lz * -1, 0, -lx);
    _q.setFromEuler(_e);
    _m.compose(_p.set(x, GY - 0.02, z), _q, _s.set(rad, h, rad));
    culms.setMatrixAt(i, _m);
    const k = brng.float(0.85, 1.08);
    culms.setColorAt(i, _c.setRGB(k, k, k * brng.float(0.9, 1.0)));
    _v.set(0, h, 0).applyQuaternion(_q);
    culmTops.push([x + _v.x, GY + _v.y, z + _v.z]);
  }
  culms.instanceMatrix.needsUpdate = true;
  if (culms.instanceColor) culms.instanceColor.needsUpdate = true;
  root.add(culms);
  for (let i = 0; i < 12; i++) {
    // airy clumps along the upper third of the culms
    const tp = culmTops[i % culmTops.length];
    const f = brng.float(0.05, 0.4);
    const x = BB.pos[0] + (tp[0] - BB.pos[0]) * (1 - f) + brng.float(-0.25, 0.3);
    const z = BB.pos[2] + (tp[2] - BB.pos[2]) * (1 - f) + brng.float(-0.3, 0.2);
    const y = GY + (tp[1] - GY) * (1 - f * 0.9);
    const g = blobGeometry([brng.float(0.22, 0.38), brng.float(0.16, 0.26), brng.float(0.22, 0.36)], 70 + i * 3.7, { detail: 2, rough: 0.3, under: 0.6 });
    g.translate(x, y, z);
    colorize(g, "#7c9440", "#9cb052", i * 1.7, 3);
    foliageParts.push(foliageUV(g, 0.25));
  }
  const foliage = casters(new THREE.Mesh(merge(foliageParts), foliageMat));
  foliage.name = "foliage";
  root.add(foliage);

  // ================================================================================================
  // training strip: battle ropes, prowler sled, yoga mat
  // ================================================================================================
  const steelMat = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.6, roughness: 0.45 });
  steelMat.name = "gardenSteel";

  // ---- battle ropes ----
  const RP = G.ropes;
  const ax = RP.anchor[0], az = RP.anchor[2];
  const SEG = 0.05;
  const N = Math.round(RP.length / SEG); // segments per rope
  const NP = N + 1; // points per rope
  const ropeR = RP.radius;
  const restY = turfTop + ropeR + 0.002;
  const rest = [new Float32Array(NP * 3), new Float32Array(NP * 3)];
  const work = [new Float32Array(NP * 3), new Float32Array(NP * 3)];
  const ropePhase = [0.4, 2.2];
  for (let ri = 0; ri < 2; ri++) {
    const sgn = ri === 0 ? -1 : 1;
    // dense polyline northward from the anchor, then resample at equal arc length
    const dense = [];
    for (let d = 0; d <= 6.5; d += 0.005) {
      const x = ax + sgn * (0.05 + (RP.spread / 2 - 0.05) * smooth(0, 0.9, d)) + RP.curve * Math.sin((d / RP.wavelength) * TAU + ropePhase[ri]) * smooth(0.3, 1.2, d);
      dense.push(x, az - 0.07 - d);
    }
    let acc = 0, k = 0;
    const out = rest[ri];
    out[0] = dense[0];
    out[1] = restY;
    out[2] = dense[1];
    k = 1;
    for (let j = 2; j < dense.length && k < NP; j += 2) {
      const seg = Math.hypot(dense[j] - dense[j - 2], dense[j + 1] - dense[j - 1]);
      acc += seg;
      if (acc >= k * SEG) {
        out[k * 3] = dense[j];
        out[k * 3 + 1] = restY;
        out[k * 3 + 2] = dense[j + 1];
        k++;
      }
    }
    work[ri].set(out);
  }
  // rope texture: twisted strands, one twist per segment length
  const ropeCanvas = cv(64, 64);
  {
    const c = ropeCanvas.ctx;
    c.fillStyle = "#9a9a9a";
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = "rgba(255,255,255,0.55)";
    c.lineWidth = 6;
    for (let i = -2; i < 4; i++) {
      c.beginPath();
      c.moveTo(i * 21, 0);
      c.lineTo(i * 21 + 64, 64);
      c.stroke();
    }
    c.strokeStyle = "rgba(0,0,0,0.45)";
    c.lineWidth = 2;
    for (let i = -2; i < 4; i++) {
      c.beginPath();
      c.moveTo(i * 21 + 9, 0);
      c.lineTo(i * 21 + 73, 64);
      c.stroke();
    }
  }
  const ropeMap = T.toTexture(ropeCanvas.canvas, { srgb: true, wrap: true });
  const ropeMat = new THREE.MeshStandardMaterial({ map: ropeMap, bumpMap: ropeMap, bumpScale: 2, roughness: 0.92 });
  ropeMat.name = "ropes";
  const LOOP = 8;
  const ropeGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  const ropes = new THREE.InstancedMesh(ropeGeo, ropeMat, 2 * N + LOOP);
  ropes.name = "battleRopes";
  ropes.frustumCulled = false; // instances move; the static bounds would go stale
  ropes.receiveShadow = true;
  const handleSegs = Math.round(RP.handle / SEG);
  const ropeCol = new THREE.Color(RP.color), tapeCol = new THREE.Color(RP.tape);
  for (let ri = 0; ri < 2; ri++) {
    for (let s = 0; s < N; s++) ropes.setColorAt(ri * N + s, s >= N - handleSegs ? tapeCol : ropeCol);
  }
  // the fold round the anchor post: a half loop behind it (south side), static
  const postR = 0.055;
  for (let i = 0; i < LOOP; i++) {
    const a0 = PI + (i / LOOP) * PI, a1 = PI + ((i + 1) / LOOP) * PI;
    const rr = postR + ropeR;
    const x0 = ax + Math.cos(a0) * rr, z0 = az - Math.sin(a0) * rr;
    const x1 = ax + Math.cos(a1) * rr, z1 = az - Math.sin(a1) * rr;
    setSegment(2 * N + i, x0, restY + 0.03, z0, x1, restY + 0.03, z1, 1);
    ropes.setColorAt(2 * N + i, ropeCol);
  }
  function setSegment(i, x0, y0, z0, x1, y1, z1, thick) {
    _v.set(x1 - x0, y1 - y0, z1 - z0);
    const len = _v.length() || 1e-4;
    _v.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_up, _v);
    _m.compose(_p.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), _q, _s.set(ropeR * thick, len * 1.06, ropeR * thick));
    ropes.setMatrixAt(i, _m);
  }
  function writeRopes() {
    for (let ri = 0; ri < 2; ri++) {
      const w = work[ri];
      for (let s = 0; s < N; s++) {
        const a = s * 3, b = a + 3;
        setSegment(ri * N + s, w[a], w[a + 1], w[a + 2], w[b], w[b + 1], w[b + 2], s >= N - handleSegs ? 1.18 : 1);
      }
    }
    ropes.instanceMatrix.needsUpdate = true;
  }
  // the first segment of each half starts at the post, joined to the loop ends
  for (let ri = 0; ri < 2; ri++) {
    const sgn = ri === 0 ? -1 : 1;
    rest[ri][0] = ax + sgn * (postR + ropeR);
    rest[ri][1] = restY + 0.03;
    rest[ri][2] = az;
    work[ri].set(rest[ri]);
  }
  writeRopes();
  if (ropes.instanceColor) ropes.instanceColor.needsUpdate = true;
  root.add(ropes);

  // rope pick proxy: a low invisible box over both ropes
  let rminX = Infinity, rmaxX = -Infinity, rminZ = Infinity, rmaxZ = -Infinity;
  for (const r of rest) {
    for (let k = 0; k < NP; k++) {
      rminX = Math.min(rminX, r[k * 3]);
      rmaxX = Math.max(rmaxX, r[k * 3]);
      rminZ = Math.min(rminZ, r[k * 3 + 2]);
      rmaxZ = Math.max(rmaxZ, r[k * 3 + 2]);
    }
  }
  const ropeProxy = new THREE.Mesh(new THREE.BoxGeometry(rmaxX - rminX + 0.16, 0.3, rmaxZ - rminZ + 0.12), invisible);
  ropeProxy.name = "battleRopesPick";
  ropeProxy.position.set((rminX + rmaxX) / 2, GY + 0.15, (rminZ + rmaxZ) / 2);
  root.add(ropeProxy);

  // anchor: low steel bollard on a ground plate
  const steelParts = [];
  {
    const plate = new RoundedBoxGeometry(0.22, 0.014, 0.22, 2, 0.004);
    xf(plate, [ax, turfTop + 0.007, az]);
    steelParts.push(tint(plate, "#4a4c50"));
    const post = new THREE.CylinderGeometry(postR, postR, 0.26, 16);
    xf(post, [ax, turfTop + 0.13, az]);
    steelParts.push(tint(post, "#2e3034"));
    const cap = new THREE.CylinderGeometry(postR + 0.012, postR + 0.012, 0.025, 16);
    xf(cap, [ax, turfTop + 0.27, az]);
    steelParts.push(tint(cap, "#3a3c40"));
    for (const [dx, dz] of [[-0.08, -0.08], [0.08, -0.08], [-0.08, 0.08], [0.08, 0.08]]) {
      const bolt = new THREE.CylinderGeometry(0.009, 0.009, 0.01, 8);
      xf(bolt, [ax + dx, turfTop + 0.018, az + dz]);
      steelParts.push(tint(bolt, "#8a8d92"));
    }
  }
  const anchorSteel = receiver(new THREE.Mesh(merge(steelParts), steelMat));
  anchorSteel.name = "ropeAnchor";
  root.add(anchorSteel);

  // ---- prowler sled ----
  const sled = new THREE.Group();
  sled.name = "sled";
  const sledFrameParts = [];
  const sledPlateParts = [];
  {
    const L = SL.length, Wd = SL.width;
    const fr = "#25272a", grip = "#141414", skid = "#55585c", collar = "#9a9da1";
    const sx = Wd / 2 - 0.035;
    for (const side of [-1, 1]) {
      const sk = new THREE.BoxGeometry(0.06, 0.025, L - 0.16);
      xf(sk, [side * sx, 0.0125, 0]);
      sledFrameParts.push(tint(sk, skid));
      for (const end of [-1, 1]) {
        const up = new THREE.BoxGeometry(0.06, 0.025, 0.11);
        xf(up, [side * sx, 0.04, end * (L / 2 - 0.05)], [end * 0.55, 0, 0]);
        sledFrameParts.push(tint(up, skid));
      }
      const rail = new THREE.BoxGeometry(0.04, 0.04, L - 0.1);
      xf(rail, [side * sx, 0.045, 0]);
      sledFrameParts.push(tint(rail, fr));
    }
    for (const z of [-0.42, 0.12, 0.42]) {
      const cross = new THREE.BoxGeometry(2 * sx + 0.04, 0.04, 0.04);
      xf(cross, [0, 0.07, z]);
      sledFrameParts.push(tint(cross, fr));
    }
    // plate horn + collar
    const horn = new THREE.CylinderGeometry(0.025, 0.025, 0.4, 14);
    xf(horn, [0, 0.29, 0.12]);
    sledFrameParts.push(tint(horn, collar));
    // push poles at the north end (local −z), leaning back toward the pusher
    const poleLean = 0.16;
    const poleBase = -L / 2 + 0.08;
    const pH = SL.poleHeight;
    for (const side of [-1, 1]) {
      const x = side * (Wd / 2 - 0.06);
      const len = (pH - 0.06) / Math.cos(poleLean);
      const pole = new THREE.CylinderGeometry(0.021, 0.021, len, 12);
      xf(pole, [x, 0.06 + (pH - 0.06) / 2, poleBase - (Math.tan(poleLean) * (pH - 0.06)) / 2], [-poleLean, 0, 0]);
      sledFrameParts.push(tint(pole, fr));
      const g = new THREE.CylinderGeometry(0.029, 0.029, 0.26, 12);
      xf(g, [x, pH - 0.16, poleBase - Math.tan(poleLean) * (pH - 0.22)], [-poleLean, 0, 0]);
      sledFrameParts.push(tint(g, grip));
      // low handle stub
      const lowH = new THREE.CylinderGeometry(0.02, 0.02, 0.2, 10);
      xf(lowH, [x, 0.36, poleBase - Math.tan(poleLean) * 0.3 - 0.1], [PI / 2, 0, 0]);
      sledFrameParts.push(tint(lowH, grip));
      // brace from pole to frame
      const by = 0.5, bz0 = poleBase - Math.tan(poleLean) * (by - 0.06), bz1 = 0.0;
      const blen = Math.hypot(bz1 - bz0, by - 0.07);
      const brace = new THREE.CylinderGeometry(0.014, 0.014, blen, 8);
      xf(brace, [x, (by + 0.07) / 2, (bz0 + bz1) / 2], [Math.atan2(bz1 - bz0, by - 0.07), 0, 0]);
      sledFrameParts.push(tint(brace, fr));
    }
    // bumper plates on the horn
    const prng = rng.fork("plates");
    for (let i = 0; i < SL.plates; i++) {
      const R = 0.225 - 0.004;
      const shape = new THREE.Shape();
      shape.absarc(0, 0, R, 0, TAU, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, 0.03, 0, TAU, true);
      shape.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(shape, { depth: 0.042, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 36 });
      g.translate(0, 0, 0.004);
      g.rotateX(-PI / 2);
      xf(g, [prng.float(-0.006, 0.006), 0.09 + i * 0.05, 0.12 + prng.float(-0.006, 0.006)], [0, prng.float(0, TAU), 0]);
      sledPlateParts.push(tint(flat(g), "#18181a"));
      const stripe = new THREE.RingGeometry(0.168, 0.18, 48).rotateX(-PI / 2);
      xf(stripe, [0, 0.09 + i * 0.05 + 0.0504, 0.12]);
      sledPlateParts.push(tint(stripe, i === SL.plates - 1 ? "#3d5a7a" : "#2f4a63"));
    }
  }
  const sledFrame = receiver(new THREE.Mesh(merge(sledFrameParts), steelMat));
  sledFrame.name = "sledFrame";
  const plateMat = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.8, metalness: 0.02 });
  plateMat.name = "sledPlates";
  const sledPlates = receiver(new THREE.Mesh(merge(sledPlateParts), plateMat));
  sledPlates.name = "sledPlates";
  const sledProxy = new THREE.Mesh(new THREE.BoxGeometry(SL.width, SL.poleHeight, SL.length), invisible);
  sledProxy.name = "sledPick";
  sledProxy.position.y = SL.poleHeight / 2;
  sled.add(sledFrame, sledPlates, sledProxy);
  sled.position.set(SL.laneX, turfTop, SL.startZ);
  root.add(sled);

  // sled physics: 1-D along the lane (z). push() drives it while the player presses; friction eases it out.
  const sim = { z: SL.startZ, v: 0, drive: 0, driveTime: 0 };
  const zMin = SL.laneZ[0], zMax = SL.laneZ[1];
  const sledCollider = {
    x: SL.laneX, z: SL.startZ, w: SL.width + 0.02, d: SL.length + 0.06, rotY: 0, y0: GY, y1: GY + SL.poleHeight,
    push(dx, dz) {
      const h = Math.hypot(dx, dz);
      if (!(h > 1e-6)) return;
      // only the along-lane part of the press moves it; a side press does nothing
      const along = dz / h;
      if (Math.abs(along) < 0.35) return;
      sim.drive = Math.sign(along);
      sim.driveTime = 0.06;
    },
  };
  const SLED_ACCEL = 3.2; // 1/s approach to maxSpeed while driven
  const SLED_DRAG = 3.0; // 1/s viscous + Coulomb when free
  const SLED_COULOMB = 0.5; // m/s²
  function stepSled(dt) {
    if (sim.driveTime > 0) {
      sim.driveTime -= dt;
      sim.v += (sim.drive * SL.maxSpeed - sim.v) * (1 - Math.exp(-SLED_ACCEL * dt));
    } else if (sim.v !== 0) {
      const s = Math.sign(sim.v);
      sim.v -= sim.v * (1 - Math.exp(-SLED_DRAG * dt)) + s * SLED_COULOMB * dt;
      if (Math.sign(sim.v) !== s || Math.abs(sim.v) < 0.01) sim.v = 0;
    }
    if (sim.v === 0) return;
    sim.z += sim.v * dt;
    if (sim.z < zMin || sim.z > zMax) {
      sim.z = Math.max(zMin, Math.min(zMax, sim.z));
      if (Math.abs(sim.v) > 0.3) sound("thump", 0.12);
      sim.v = 0;
      sim.driveTime = 0;
    }
    sledCollider.z = sim.z;
    sled.position.z = sim.z;
  }

  // ---- yoga mat (+ cork block, rolled strap) ----
  const YM = G.yogaMat;
  const ymCanvas = cv(256);
  {
    const c = ymCanvas.ctx;
    const yr = rng.fork("yoga");
    c.fillStyle = "#d6d6d6";
    c.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 4) {
      c.fillStyle = "rgba(0,0,0,0.07)";
      c.fillRect(0, y, 256, 2);
    }
    T.grainOverlay(c, 256, 256, { rng: yr, amount: 0.05, scale: 4, fine: 0.1 });
  }
  const ymMap = T.toTexture(ymCanvas.canvas, { srgb: true, wrap: true });
  const ymBump = T.toTexture(ymCanvas.canvas, { srgb: false, wrap: true });
  ymMap.repeat.set(1 / 0.12, 1 / 0.12);
  ymBump.repeat.set(1 / 0.12, 1 / 0.12);
  const yogaMatMat = new THREE.MeshStandardMaterial({ map: ymMap, bumpMap: ymBump, bumpScale: 0.8, vertexColors: true, roughness: 0.88 });
  yogaMatMat.name = "yoga";
  const yogaParts = [];
  {
    const rr = 0.03, w = YM.width, d = YM.depth;
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + rr, -d / 2);
    shape.lineTo(w / 2 - rr, -d / 2);
    shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + rr);
    shape.lineTo(w / 2, d / 2 - rr);
    shape.quadraticCurveTo(w / 2, d / 2, w / 2 - rr, d / 2);
    shape.lineTo(-w / 2 + rr, d / 2);
    shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - rr);
    shape.lineTo(-w / 2, -d / 2 + rr);
    shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + rr, -d / 2);
    const g = new THREE.ExtrudeGeometry(shape, { depth: YM.height, bevelEnabled: false, curveSegments: 4 });
    g.rotateX(-PI / 2); // extrude along +y; shape y -> −z
    yogaParts.push(tint(g, YM.color));
    // cork block at the west (head) end, beside the mat
    const blk = new RoundedBoxGeometry(0.23, 0.076, 0.152, 2, 0.01);
    xf(blk, [-w / 2 + 0.16, YM.height + 0.038, -d / 2 - 0.13], [0, 0.25, 0]);
    yogaParts.push(tint(blk, "#b48a5c", 0.08, rng));
    // rolled strap (a flat coil) with a D-ring
    const coil = new THREE.CylinderGeometry(0.04, 0.04, 0.038, 18);
    xf(coil, [-w / 2 + 0.42, 0.019, -d / 2 - 0.12]);
    yogaParts.push(tint(coil, "#cfc3a5"));
    const ring = new THREE.TorusGeometry(0.018, 0.0028, 6, 16);
    xf(ring, [-w / 2 + 0.42 + 0.048, 0.02, -d / 2 - 0.12], [0, PI / 2, 0]);
    yogaParts.push(tint(ring, "#9a9da1"));
  }
  const yoga = receiver(new THREE.Mesh(merge(yogaParts), yogaMatMat));
  yoga.name = "yogaMat";
  yoga.position.set(YM.pos[0], GY + 0.0045, YM.pos[2]);
  yoga.rotation.y = YM.rotY;
  root.add(yoga);
  const yogaProxy = new THREE.Mesh(new THREE.BoxGeometry(YM.width, 0.12, YM.depth), invisible);
  yogaProxy.name = "yogaMatPick";
  yogaProxy.position.set(YM.pos[0], GY + 0.06, YM.pos[2]);
  yogaProxy.rotation.y = YM.rotY;
  root.add(yogaProxy);

  // ================================================================================================
  // "elsewhere" notice post / mailbox
  // ================================================================================================
  const MB = G.mailbox;
  const mailbox = new THREE.Group();
  mailbox.name = "mailbox";
  mailbox.position.set(MB.pos[0], GY, MB.pos[2]);
  mailbox.rotation.y = MB.rotY;
  const cedar = T.toTexture(streaks(T, rng.fork("cedar"), 256, 256, "#8a6a4c", 0.22, 0.05), { srgb: true, wrap: true });
  const mbMat = new THREE.MeshStandardMaterial({ map: cedar, vertexColors: true, roughness: 0.75 });
  mbMat.name = "mailboxWood";
  {
    const H = MB.height;
    const parts = [];
    const post = new THREE.BoxGeometry(0.075, H - 0.2, 0.075);
    xf(post, [0, (H - 0.2) / 2, -0.02]);
    parts.push(tint(post, "#ffffff"));
    const box = new RoundedBoxGeometry(0.32, 0.2, 0.2, 2, 0.008);
    xf(box, [0, H - 0.2 + 0.1 - 0.06, 0]);
    parts.push(tint(box, "#ffffff"));
    // gabled roof, dark timber
    for (const side of [-1, 1]) {
      const slab = new THREE.BoxGeometry(0.2, 0.014, 0.28);
      xf(slab, [side * 0.09, H - 0.03, 0], [0, 0, side * -0.55]);
      parts.push(tint(slab, "#4a3828"));
    }
    // mail slot lip + small copper latch
    const lip = new THREE.BoxGeometry(0.2, 0.012, 0.012);
    xf(lip, [0, H - 0.12, 0.104]);
    parts.push(tint(lip, "#3a2a1e"));
    const latch = new THREE.BoxGeometry(0.03, 0.04, 0.008);
    xf(latch, [0.12, H - 0.18, 0.103]);
    parts.push(tint(latch, "#b07a4a"));
    const g = merge(parts);
    projectUV(g, 0.5);
    const mb = receiver(new THREE.Mesh(g, mbMat));
    mb.name = "mailboxBody";
    mailbox.add(mb);
    // plaque with the word, hung on the post below the box
    const pc = cv(256, 96);
    const c = pc.ctx;
    c.fillStyle = "#d9c7a6";
    c.fillRect(0, 0, 256, 96);
    T.grainOverlay(c, 256, 96, { rng: rng.fork("plaque"), amount: 0.12, scale: 4, fine: 0.05 });
    c.fillStyle = "#2a2018";
    c.font = "italic 44px Georgia, 'Times New Roman', serif";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText("elsewhere", 128, 50);
    c.strokeStyle = "rgba(60,44,30,0.6)";
    c.lineWidth = 4;
    c.strokeRect(4, 4, 248, 88);
    const plaqueMat = new THREE.MeshStandardMaterial({ map: T.toTexture(pc.canvas, { srgb: true }), roughness: 0.8 });
    plaqueMat.name = "mailboxPlaque";
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.09, 0.012), plaqueMat);
    plaque.name = "mailboxPlaque";
    plaque.position.set(0, H - 0.42, 0.024);
    mailbox.add(receiver(plaque));
  }
  root.add(mailbox);

  scene.add(root);

  // ================================================================================================
  // runtime: lantern by ctx.time, rope waves, sled
  // ================================================================================================
  const A = ctx.audio;
  function sound(kind, gain) {
    try {
      if (A && typeof A[kind] === "function") A[kind](gain);
    } catch {
      /* audio is optional */
    }
  }

  const waves = { active: false, t0: 0, now: 0, lastDraw: -1, lastBeat: -1 };
  const RW = {
    H: 0.26, // mean lift at the handle while the ropes are worked
    a: 0.2, // wave amplitude at the handle
    k: TAU / 1.5, // wave number (wavelength 1.5 m along the rope)
    w: TAU * 2.1, // 2.1 Hz
  };
  function drawWaves(t) {
    const tt = t - waves.t0;
    const dur = RP.seconds;
    const env = smooth(0, 0.35, tt) * (1 - smooth(dur - 1.0, dur, tt));
    for (let ri = 0; ri < 2; ri++) {
      const r = rest[ri], w = work[ri];
      const ph = ri === 0 ? 0 : PI; // alternating
      const sgn = ri === 0 ? -1 : 1;
      for (let k = 1; k < NP; k++) {
        const u = k / N; // 0 at the anchor, 1 at the handle
        const dHandle = (N - k) * SEG;
        const lift = u * u;
        const s = Math.sin(RW.k * dHandle - RW.w * tt + ph);
        w[k * 3 + 1] = r[k * 3 + 1] + env * lift * (RW.H + RW.a * s);
        w[k * 3] = r[k * 3] + env * u * 0.05 * sgn * Math.sin(RW.k * dHandle - RW.w * tt + ph + 1.1);
        w[k * 3 + 2] = r[k * 3 + 2] + env * lift * 0.12; // lifting shortens the run toward the anchor a touch
      }
    }
    writeRopes();
    // a soft slap on the turf each half cycle, alternating ropes
    const beat = Math.floor((RW.w * tt) / PI);
    if (beat !== waves.lastBeat && env > 0.3) {
      waves.lastBeat = beat;
      sound("thump", 0.1 + 0.08 * env);
    }
    if (tt >= dur) {
      waves.active = false;
      for (let ri = 0; ri < 2; ri++) work[ri].set(rest[ri]);
      writeRopes();
    }
  }
  function startWaves() {
    if (waves.active) return;
    waves.active = true;
    waves.t0 = waves.now;
    waves.lastBeat = -1;
    waves.lastDraw = -1;
  }

  const lantern = { night: -1, flicker: !ctx.reducedMotion };
  function applyNight(night, t) {
    const f = lantern.flicker ? 1 + 0.035 * Math.sin(t * 7.3) + 0.025 * Math.sin(t * 13.1 + 1.3) : 1;
    lanternLight.intensity = 2.4 * night * f;
    paperMat.emissiveIntensity = (0.03 + 1.1 * night) * f;
  }

  let lastLight = -1;
  function update(dt, t) {
    waves.now = t;
    stepSled(dt);
    if (waves.active && t - waves.lastDraw >= 1 / 60) {
      waves.lastDraw = t;
      drawWaves(t);
    }
    if (t - lastLight >= 1 / 30) {
      lastLight = t;
      const time = ctx.time || FALLBACK_TIME;
      const night = Math.max(0, Math.min(1, Number(time.night) || 0));
      if (night !== lantern.night || (lantern.flicker && night > 0)) {
        lantern.night = night;
        applyNight(night, t);
      }
    }
  }
  applyNight(Math.max(0, Math.min(1, Number((ctx.time || FALLBACK_TIME).night) || 0)), 0);

  // ================================================================================================
  // hotspots + colliders
  // ================================================================================================
  const hotspots = [
    {
      zone: null,
      label: "battle ropes",
      objects: [ropeProxy],
      onActivate() {
        startWaves();
        return true;
      },
    },
    {
      zone: null,
      label: "sled · push",
      objects: [sledProxy],
      onActivate() {
        const pl = ctx.player;
        let dir = pl && Number.isFinite(pl.z) ? Math.sign(sim.z - pl.z) : 0;
        if (!dir) dir = sim.z > (zMin + zMax) / 2 ? -1 : 1;
        if ((dir > 0 && sim.z >= zMax - 0.01) || (dir < 0 && sim.z <= zMin + 0.01)) dir = -dir;
        sim.drive = 0;
        sim.driveTime = 0;
        sim.v = dir * 1.7;
        sound("thump", 0.08);
        return true;
      },
    },
    {
      zone: null,
      label: "yoga mat · sit",
      objects: [yogaProxy],
      onActivate() {
        if (typeof ctx.vantage !== "function") return false;
        ctx.vantage({ pos: YM.seat.slice(), target: YM.look.slice(), label: "yoga mat" });
        return true;
      },
    },
    {
      zone: "door",
      label: "elsewhere",
      objects: [mailbox],
    },
  ];

  return {
    root,
    update,
    hotspots,
    dynamicColliders: [sledCollider],
    // test hooks (not part of the contract)
    ropes: { start: startWaves, active: () => waves.active, sample: (ri, k) => work[ri][k * 3 + 1] },
    sled: sim,
  };
}
