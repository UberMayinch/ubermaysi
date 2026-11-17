// objects/shell.js — the house: polished dark dojo floor, genkan (stone entry one step down, step beams,
// getabako with shoes, bench, umbrella stand, slippers), walls with timber inside and out, the south facade, ceiling + roof, the sliding
// shoji door, ensō scroll, washi ceiling lamp. The quiet dojo character of the room lives here.
//
// Returns { root, walls: { N, S, E, W, ceiling }, door, update, hotspots }. main.js toggles walls.*.visible for
// the cutaway. Each wall is a Group holding its plaster box plus its own timber inside AND outside (the S group
// carries the whole south facade); `ceiling` is a Group with the ceiling slab and the roof. The door, the scroll,
// the lamp and the genkan joinery are MOUNTED and stay outside the wall groups (the scroll copies the
// visibility of the wall it hangs on, layout enso.wall, in update()).
// door = { toggle(), open(instant?), close(instant?), isOpen(), openness } — openness (0..1) is a live field,
// eased in update(). The door hotspot (zone null) toggles it; its pick proxy covers the doorway from both sides.
// Shadows: wall plaster, the S facade timber, ceiling and roof cast (so the sun cannot shine through the house);
// everything else only receives. No lights are created here: the lamp and the shoji glow are emissive.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { footprints, ROOM } from "../layout.js";

const AX = ["x", "y", "z"];

// Soft "baked" contact shadows on the floor under grounded objects, from their layout.js footprints.
// [footprint id, outer margin m, inner core inset m, strength 0..1]. One merged mesh, one draw call.
// Strengths are tuned for the dark polished floor (a blob must read darker than dark wood, not grey on it).
const CONTACT = [
  ["library", 0.16, 0.04, 0.68], ["desk", 0.12, 0.12, 0.4], ["swedishBar", 0.1, 0.02, 0.52], ["mat", 0.05, 0.0, 0.45],
  ["kettlebell1", 0.07, 0.04, 0.72], ["kettlebell2", 0.08, 0.04, 0.72], ["kettlebell3", 0.09, 0.05, 0.72],
  ["dumbbellsA", 0.06, 0.03, 0.6], ["dumbbellsB", 0.07, 0.03, 0.6], ["plates", 0.08, 0.06, 0.66],
  ["getabako", 0.06, 0.02, 0.6], ["slippers", 0.025, 0.0, 0.42],
  ["genkanBench", 0.05, 0.03, 0.5], ["umbrellaStand", 0.05, 0.03, 0.62],
];

/**
 * 9-slice soft rounded rectangles, so the penumbra width stays in metres whatever the footprint aspect.
 * Each blob lies on its footprint's base level (y0) and is clamped to that level's floor (room or genkan).
 */
function contactShadows(T, genkan, extra = []) {
  const N = 64;
  const { canvas: c, ctx: g } = T.makeCanvas(N, N);
  const img = g.createImageData(N, N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const r = Math.min(1, 2 * Math.hypot((i + 0.5) / N - 0.5, (j + 0.5) / N - 0.5));
    const a = Math.pow(1 - r * r * (3 - 2 * r), 1.6); // smoothstep falloff, softened toward the edge
    const k = 4 * (j * N + i);
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 0;
    img.data[k + 3] = Math.round(255 * a);
  }
  g.putImageData(img, 0, 0);
  const tex = T.toTexture(c, { srgb: false, wrap: false });

  const byId = new Map(footprints().map((f) => [f.id, f]));
  const pos = [], uv = [], col = [], idx = [];
  const U = [0, 0.5, 0.5, 1];
  // `extra`: [footprint-like { x, z, w, d, rotY, y0 }, margin, inset, strength] for props without a footprint
  for (const [id, m, s, a] of [...CONTACT, ...extra]) {
    const f = typeof id === "string" ? byId.get(id) : id;
    if (!f) continue;
    const hw = f.w / 2, hd = f.d / 2;
    const xs = [-hw - m, -hw + s, hw - s, hw + m], zs = [-hd - m, -hd + s, hd - s, hd + m];
    const cs = Math.cos(f.rotY), sn = Math.sin(f.rotY);
    const low = f.y0 < -0.05; // standing on the genkan stone
    const bx0 = low ? genkan.x[0] : ROOM.minX, bx1 = low ? genkan.x[1] : ROOM.maxX;
    const bz0 = low ? genkan.z[0] : ROOM.minZ, bz1 = low ? genkan.z[1] : ROOM.maxZ;
    const y = (low ? genkan.y : 0) + 0.0025;
    const base = pos.length / 3;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const lx = xs[i], lz = zs[j];
      // clamp to the floor so nothing shows past a cut-away wall or over the step edge
      const wx = Math.min(bx1, Math.max(bx0, f.x + lx * cs + lz * sn));
      const wz = Math.min(bz1, Math.max(bz0, f.z - lx * sn + lz * cs));
      pos.push(wx, y, wz);
      uv.push(U[i], 1 - U[j]);
      col.push(1, 1, 1, a);
    }
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const v = base + j * 4 + i;
      idx.push(v, v + 4, v + 1, v + 1, v + 4, v + 5);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, map: tex, vertexColors: true, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "contactShadows";
  mesh.renderOrder = 1;
  mesh.raycast = () => {};
  return mesh;
}

// ---- geometry helpers -------------------------------------------------------------------------------

/**
 * Box-projected UVs in metres. For each face, U follows `uAxis` when it lies in the face plane (otherwise the
 * longer remaining axis), V the other one. `tile` metres per texture repeat, plus an offset for variety.
 */
function projectUV(geo, { uAxis, tile = 1, ou = 0, ov = 0, dims }) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const n = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))];
    const na = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
    const axes = [0, 1, 2].filter((a) => a !== na);
    let ua = axes.includes(uAxis) ? uAxis : dims && dims[axes[0]] < dims[axes[1]] ? axes[1] : axes[0];
    const va = axes[0] === ua ? axes[1] : axes[0];
    p[0] = pos.getX(i); p[1] = pos.getY(i); p[2] = pos.getZ(i);
    uv.setXY(i, p[ua] / tile + ou, p[va] / tile + ov);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Axis-aligned box from min/max corners, with grain UVs running along its longest side. */
function timberBox(x0, y0, z0, x1, y1, z1, rng, tile) {
  const w = x1 - x0, h = y1 - y0, d = z1 - z0;
  const dims = [w, h, d];
  const long = dims.indexOf(Math.max(w, h, d));
  const g = new THREE.BoxGeometry(w, h, d);
  projectUV(g, { uAxis: long, tile, ou: rng.float(0, 1), ov: rng.float(0, 1), dims });
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/** Plain box from min/max corners, UVs untouched (0..1 per face). */
function plainBox(x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

function merged(list, material, name) {
  const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- canvas helpers ---------------------------------------------------------------------------------

/**
 * Soft ambient-occlusion map for a rectangle `lenU` × `lenV` metres: darker within a few decimetres of
 * the edges listed in `edges` ({ u0, u1, v0, v1 } -> [strength, falloff m]) plus faint large-scale mottling.
 */
function aoCanvas(T, w, h, lenU, lenV, edges, rng) {
  const { canvas, ctx } = T.makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const N = 64;
  const field = T.noiseField(N, { rng, scale: 3, octaves: 3 });
  for (let j = 0; j < h; j++) {
    const v = 1 - (j + 0.5) / h; // canvas row 0 = top = v 1 (flipY)
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w;
      const du0 = u * lenU, du1 = (1 - u) * lenU, dv0 = v * lenV, dv1 = (1 - v) * lenV;
      let ao = 1;
      if (edges.u0) ao *= 1 - edges.u0[0] * Math.exp(-du0 / edges.u0[1]);
      if (edges.u1) ao *= 1 - edges.u1[0] * Math.exp(-du1 / edges.u1[1]);
      if (edges.v0) ao *= 1 - edges.v0[0] * Math.exp(-dv0 / edges.v0[1]);
      if (edges.v1) ao *= 1 - edges.v1[0] * Math.exp(-dv1 / edges.v1[1]);
      ao *= 0.96 + 0.08 * field[Math.floor(v * (N - 1)) * N + Math.floor(u * (N - 1))];
      const c = Math.max(0, Math.min(255, Math.round(ao * 255)));
      const k = (j * w + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = c;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** One brush-painted ensō: a single breath, wet at the start, splitting into dry bristle streaks at the end. */
function drawEnso(g, cx, cy, R, rng) {
  const a0 = rng.float(1.95, 2.25); // canvas angle (y down): start at about seven o'clock
  const sweep = rng.float(5.3, 5.55); // ~305–318°, the circle stays open
  const steps = 360;
  const B = 64;
  const wob = rng.float(0, Math.PI * 2);
  const width = (t) =>
    R * 0.27 * (0.8 + 0.28 * Math.sin(Math.PI * Math.min(1, t * 1.5 + 0.12))) * (1 - 0.7 * smooth(0.6, 1, t)) * (1 + 0.3 * Math.exp(-t / 0.03));
  const radius = (t, a) => R * (1 + 0.022 * Math.sin(2.2 * a + wob) - 0.035 * t + 0.012 * Math.sin(9 * t + wob));
  const bristles = [];
  for (let b = 0; b < B; b++) {
    bristles.push({
      o: (b / (B - 1)) * 2 - 1 + rng.float(-0.012, 0.012),
      load: rng.float(0.5, 1.05),
      alpha: rng.float(0.6, 0.95),
      f: rng.float(18, 55), ph: rng.float(0, Math.PI * 2),
    });
  }
  g.save();
  g.lineCap = "round";
  // wet pool where the brush first touched the paper, with a little bleed into the fibres
  {
    const t = 0, a = a0, r = radius(t, a), w = width(0);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const bleed = g.createRadialGradient(x, y, 0, x, y, w * 0.62);
    bleed.addColorStop(0, "rgba(20,18,16,0.95)");
    bleed.addColorStop(0.75, "rgba(20,18,16,0.9)");
    bleed.addColorStop(1, "rgba(20,18,16,0)");
    g.fillStyle = bleed;
    g.beginPath();
    g.ellipse(x, y, w * 0.62, w * 0.5, a, 0, Math.PI * 2);
    g.fill();
  }
  for (const br of bristles) {
    let px = null, py = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const a = a0 + sweep * t;
      const w = width(t);
      const r = radius(t, a) + (br.o * w) / 2;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const ink = br.load - t * t * 1.25 * (0.5 + Math.abs(br.o) * 1.1) + 0.16 * Math.sin(t * br.f + br.ph);
      if (ink > 0 && px !== null) {
        g.strokeStyle = `rgba(20,18,16,${(br.alpha * Math.min(1, 0.35 + ink * 1.4)).toFixed(3)})`;
        g.lineWidth = Math.max(0.6, (w / B) * 2.6);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(x, y);
        g.stroke();
      }
      px = ink > 0 ? x : null;
      py = y;
    }
  }
  g.restore();
}

/** The scroll face: mounting silk, gold ichimonji bands, fūtai strips, washi with the ensō and a seal. */
function scrollFace(T, wM, hM, rng) {
  const H = 1024;
  const W = Math.round((H * wM) / hM);
  const s = H / hM; // px per metre
  const { canvas, ctx } = T.makeCanvas(W, H);
  const silk = "#8f8574", gold = "#a98a52", indigo = "#5a6370";

  ctx.fillStyle = silk;
  ctx.fillRect(0, 0, W, H);
  // woven silk: fine warp and weft
  for (let y = 0; y < H; y += 2) {
    ctx.fillStyle = `rgba(40,30,20,${rng.float(0.02, 0.06).toFixed(3)})`;
    ctx.fillRect(0, y, W, 1);
  }
  for (let x = 0; x < W; x += 2) {
    ctx.fillStyle = `rgba(255,245,225,${rng.float(0.01, 0.04).toFixed(3)})`;
    ctx.fillRect(x, 0, 1, H);
  }
  T.grainOverlay(ctx, W, H, { rng, amount: 0.05, scale: 5, fine: 0.015 });

  // inner border (chūmawashi) around the art: a darker indigo silk
  const side = 0.03 * s, top = 0.255 * s, bottom = 0.135 * s;
  const cx0 = side, cx1 = W - side, cy0 = top, cy1 = H - bottom;
  ctx.fillStyle = indigo;
  ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
  for (let y = cy0; y < cy1; y += 2) {
    ctx.fillStyle = `rgba(0,0,0,${rng.float(0.03, 0.08).toFixed(3)})`;
    ctx.fillRect(cx0, y, cx1 - cx0, 1);
  }

  // art panel (honshi) with ichimonji brocade above and below
  const ax0 = cx0 + 0.022 * s, ax1 = cx1 - 0.022 * s;
  const ay0 = cy0 + 0.07 * s, ay1 = cy1 - 0.05 * s;
  const ich = (y, h) => {
    ctx.fillStyle = gold;
    ctx.fillRect(ax0, y, ax1 - ax0, h);
    ctx.fillStyle = "rgba(255,236,190,0.35)";
    for (let x = ax0 + 3; x < ax1; x += 7) ctx.fillRect(x, y + h * 0.3, 2, h * 0.4);
    ctx.fillStyle = "rgba(60,40,10,0.35)";
    ctx.fillRect(ax0, y + h - 1, ax1 - ax0, 1);
  };
  ich(ay0 - 0.024 * s, 0.024 * s);
  ich(ay1, 0.012 * s);

  const paper = T.washi({ size: 512, color: "#efe6d1", fibres: 520, rng: rng.fork("paper") });
  ctx.save();
  ctx.beginPath();
  ctx.rect(ax0, ay0, ax1 - ax0, ay1 - ay0);
  ctx.clip();
  ctx.drawImage(paper.canvas, 2, 2, 508, 508, ax0, ay0, ax1 - ax0, ay1 - ay0); // one sheet: no tile seams
  ctx.restore();
  // faint age toning toward the edges of the paper
  const tone = ctx.createLinearGradient(ax0, 0, ax1, 0);
  tone.addColorStop(0, "rgba(120,90,50,0.10)");
  tone.addColorStop(0.15, "rgba(120,90,50,0)");
  tone.addColorStop(0.85, "rgba(120,90,50,0)");
  tone.addColorStop(1, "rgba(120,90,50,0.10)");
  ctx.fillStyle = tone;
  ctx.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);

  const aw = ax1 - ax0;
  drawEnso(ctx, (ax0 + ax1) / 2, ay0 + (ay1 - ay0) * 0.4, aw * 0.36, rng.fork("enso"));

  // a few small signature strokes and a red seal, lower left
  ctx.save();
  ctx.strokeStyle = "rgba(24,20,18,0.8)";
  ctx.lineCap = "round";
  const sx = ax0 + aw * 0.16;
  let sy = ay0 + (ay1 - ay0) * 0.72;
  for (let i = 0; i < 3; i++) {
    const len = rng.float(0.008, 0.016) * s;
    ctx.lineWidth = rng.float(1.2, 2.4);
    ctx.beginPath();
    ctx.moveTo(sx + rng.float(-3, 3), sy);
    ctx.quadraticCurveTo(sx + rng.float(-6, 6), sy + len / 2, sx + rng.float(-4, 4), sy + len);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 5, sy + len * 0.4);
    ctx.lineTo(sx + 6, sy + len * 0.35 + rng.float(-2, 2));
    ctx.stroke();
    sy += len + 0.006 * s;
  }
  const seal = 0.02 * s;
  ctx.fillStyle = "rgba(164,48,38,0.88)";
  ctx.fillRect(sx - seal / 2, sy + 0.004 * s, seal, seal);
  ctx.strokeStyle = "rgba(239,230,209,0.8)";
  ctx.lineWidth = 1.2;
  const ox = sx - seal / 2, oy = sy + 0.004 * s;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(ox + seal * rng.float(0.2, 0.8), oy + seal * rng.float(0.15, 0.4));
    ctx.lineTo(ox + seal * rng.float(0.2, 0.8), oy + seal * rng.float(0.6, 0.85));
    ctx.stroke();
  }
  ctx.restore();

  // fūtai: two narrow strips hanging from the top rod
  for (const fx of [0.3, 0.7]) {
    const x = W * fx, fw = 0.02 * s, fh = 0.2 * s;
    ctx.fillStyle = "rgba(0,0,0,0.18)"; // the strip's soft shadow on the silk
    ctx.fillRect(x - fw / 2 + 2, 0, fw, fh + 2);
    ctx.fillStyle = indigo;
    ctx.fillRect(x - fw / 2, 0, fw, fh);
    ctx.fillStyle = gold;
    ctx.fillRect(x - fw / 2, 0, 2, fh);
    ctx.fillRect(x + fw / 2 - 2, 0, 2, fh);
    ctx.fillRect(x - fw / 2, fh - 0.012 * s, fw, 2);
  }
  // shade under the top rod
  const rod = ctx.createLinearGradient(0, 0, 0, 0.02 * s);
  rod.addColorStop(0, "rgba(0,0,0,0.22)");
  rod.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = rod;
  ctx.fillRect(0, 0, W, 0.02 * s);
  return canvas;
}

/** Lamp shade: washi fibres, warmer and brighter in the middle like paper with a bulb behind it. */
function lampCanvas(T, rng) {
  const paper = T.washi({ size: 256, color: "#f6ead4", fibres: 260, rng });
  const { canvas, ctx } = T.makeCanvas(256);
  ctx.drawImage(paper.canvas, 0, 0);
  const glow = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  glow.addColorStop(0, "rgba(255,248,232,0.55)");
  glow.addColorStop(0.7, "rgba(255,240,215,0.1)");
  glow.addColorStop(1, "rgba(200,160,110,0.18)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);
  return canvas;
}

/**
 * Genkan stone atlas at `ppm` px per metre. Rows 0..gd·ppm: the genkan floor (gw × gd m, north edge at the
 * top) laid as large rectangular stones in three courses with fine mortar joints. Rows from `stepRow`:
 * one plain, jointless stone face for the step stone outside. Returns { map, bump, ppm, stepRow, S }.
 */
function stoneAtlas(T, gw, gd, color, rng, course = 0.27) {
  const S = 1024;
  const ppm = S / gw;
  const gH = Math.ceil(gd * ppm);
  const stepRow = gH + 8;
  const { canvas, ctx } = T.makeCanvas(S, S);
  const B = T.makeCanvas(S, S);
  const img = ctx.createImageData(S, S), bimg = B.ctx.createImageData(S, S);
  const lo = T.noiseField(128, { rng: rng.fork("lo"), scale: 3, octaves: 4 });
  const hi = T.noiseField(128, { rng: rng.fork("hi"), scale: 22, octaves: 2 });
  const base = T.rgb(color);

  // courses along z (canvas y), stones along x with staggered joints
  const courses = [];
  {
    const n = Math.max(2, Math.round(gd / course)); // keep the stone scale whatever the genkan depth
    let y = 0;
    for (let c = 0; c < n; c++) {
      const h = c === n - 1 ? gH - y : Math.round((gd / n) * ppm * rng.float(0.9, 1.1));
      const cuts = [0];
      let x = Math.round(rng.float(0.12, 0.4) * ppm * (c % 2 ? 1 : 0.6));
      while (x < S - 0.2 * ppm) {
        if (x > 0.14 * ppm) cuts.push(x);
        x += Math.round(rng.float(0.3, 0.48) * ppm);
      }
      cuts.push(S);
      const tones = [];
      for (let k = 0; k < cuts.length - 1; k++) {
        const f = rng.float(0.84, 1.12), hue = rng.float(-0.045, 0.045);
        tones.push([base[0] * f * (1 + hue), base[1] * f, base[2] * f * (1 - hue)]);
      }
      courses.push({ y0: y, y1: y + h, cuts, tones });
      y += h;
    }
  }
  const mortar = [base[0] * 0.62, base[1] * 0.6, base[2] * 0.56];
  const stepTone = [base[0] * 0.8, base[1] * 0.79, base[2] * 0.78];
  let c = 0;
  for (let py = 0; py < S; py++) {
    while (c < courses.length - 1 && py >= courses[c].y1) c++;
    const course = courses[c];
    const inGenkan = py < gH, inStep = py >= stepRow;
    let k = 0;
    for (let px = 0; px < S; px++) {
      const i = (py * S + px) * 4;
      const nl = lo[((py >> 2) & 127) * 128 + ((px >> 2) & 127)];
      const nh = hi[(py & 127) * 128 + (px & 127)];
      const speck = rng() < 0.035 ? rng.float(-0.12, 0.1) : 0;
      let col, bump;
      if (inGenkan) {
        while (k < course.cuts.length - 2 && px >= course.cuts[k + 1]) k++;
        const d = Math.min(px - course.cuts[k], course.cuts[k + 1] - px, py - course.y0, course.y1 - py);
        const tone = course.tones[k];
        const m = 0.86 + 0.22 * nl + 0.1 * (nh - 0.5) + speck;
        if (d < 1.6) {
          col = mortar;
          bump = 70;
          col = [mortar[0] * (0.95 + 0.1 * nh), mortar[1] * (0.95 + 0.1 * nh), mortar[2] * (0.95 + 0.1 * nh)];
        } else {
          const edge = d < 5 ? 0.9 + 0.1 * ((d - 1.6) / 3.4) : 1; // softly worn arrises
          col = [tone[0] * m * edge, tone[1] * m * edge, tone[2] * m * edge];
          bump = 150 + 40 * (nh - 0.5) + 30 * (nl - 0.5) - (d < 5 ? (5 - d) * 10 : 0);
        }
      } else if (inStep) {
        const m = 0.84 + 0.26 * nl + 0.12 * (nh - 0.5) + speck;
        col = [stepTone[0] * m, stepTone[1] * m, stepTone[2] * m];
        bump = 140 + 60 * (nh - 0.5) + 40 * (nl - 0.5);
      } else {
        col = mortar;
        bump = 128;
      }
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = bump;
      bimg.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  B.ctx.putImageData(bimg, 0, 0);
  return {
    map: T.toTexture(canvas, { srgb: true }),
    bump: T.toTexture(B.canvas, { srgb: false }),
    ppm, stepRow, S,
  };
}

/** Adds a constant vertex colour (linear) to a geometry, so differently tinted parts merge into one mesh. */
const _c = new THREE.Color();
function tint(geo, color, k = 1) {
  _c.set(color).multiplyScalar(k);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = _c.r; a[i * 3 + 1] = _c.g; a[i * 3 + 2] = _c.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return geo;
}

/** Box from min/max corners with a vertex colour. */
const cbox = (x0, y0, z0, x1, y1, z1, color, k) => tint(plainBox(x0, y0, z0, x1, y1, z1), color, k);

/** Flattened rounded sole (an elongated 14-gon puck), toe toward +z, sitting on y = 0. */
function sole(w, h, l, color, toeBias = 0.12) {
  const g = new THREE.CylinderGeometry(0.5, 0.5, h, 14, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    // a shoe-ish outline: the toe end a little wider than the heel
    p.setX(i, p.getX(i) * w * (1 + toeBias * Math.max(-1, Math.min(1, z * 2))));
    p.setZ(i, z * l);
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return tint(g, color);
}

/**
 * One shoe (local: toe toward +z, sole on y = 0, centred). Kinds: geta, zori, sneaker, leather, slipper.
 * Returns an array of coloured geometries.
 */
function shoe(kind, tone) {
  const out = [];
  if (kind === "geta") {
    const wood = "#b48f63", strap = "#2b1d1b";
    out.push(cbox(-0.048, 0.045, -0.11, 0.048, 0.064, 0.11, wood)); // dai
    out.push(cbox(-0.046, 0, 0.035, 0.046, 0.045, 0.06, wood, 0.86)); // ha (teeth)
    out.push(cbox(-0.046, 0, -0.075, 0.046, 0.045, -0.05, wood, 0.86));
    for (const s of [-1, 1]) { // hanao: a V from the toe hole back to the sides
      const g = new THREE.BoxGeometry(0.009, 0.012, 0.1);
      g.rotateY(s * 0.42);
      g.translate(s * 0.021, 0.07, 0.025);
      out.push(tint(g, strap));
    }
    out.push(cbox(-0.006, 0.064, 0.07, 0.006, 0.074, 0.082, strap));
  } else if (kind === "zori") {
    out.push(sole(0.095, 0.022, 0.24, "#cdbf9f", 0.1));
    for (const s of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.01, 0.012, 0.1);
      g.rotateY(s * 0.42);
      g.translate(s * 0.021, 0.028, 0.02);
      out.push(tint(g, "#2c3a52"));
    }
  } else if (kind === "sneaker") {
    const up = tone || "#56616c";
    out.push(sole(0.095, 0.028, 0.27, "#e6e2da", 0.08));
    out.push(cbox(-0.042, 0.028, -0.125, 0.042, 0.09, 0.01, up));
    out.push(cbox(-0.044, 0.028, 0.01, 0.044, 0.068, 0.085, up, 0.95));
    out.push(cbox(-0.04, 0.028, 0.085, 0.04, 0.052, 0.12, up, 0.9));
    out.push(cbox(-0.03, 0.089, -0.115, 0.03, 0.092, -0.035, "#1f2328")); // collar opening
    out.push(cbox(-0.03, 0.068, 0.015, 0.03, 0.071, 0.07, "#d9d6cf")); // laces
  } else if (kind === "leather") {
    const c = "#3d2519";
    out.push(sole(0.09, 0.02, 0.27, "#1d1410", 0.06));
    out.push(cbox(-0.04, 0.02, -0.125, 0.04, 0.078, -0.02, c));
    out.push(cbox(-0.04, 0.02, -0.02, 0.04, 0.058, 0.08, c, 1.05));
    out.push(cbox(-0.034, 0.02, 0.08, 0.034, 0.045, 0.118, c, 1.05));
    out.push(cbox(-0.028, 0.077, -0.11, 0.028, 0.08, -0.04, "#140d09"));
  } else if (kind === "boot") { // suede ankle boot
    const c = tone || "#7a5a3e";
    out.push(sole(0.092, 0.024, 0.27, "#2a211b", 0.06));
    out.push(cbox(-0.04, 0.024, -0.125, 0.04, 0.15, -0.01, c));
    out.push(cbox(-0.042, 0.024, -0.01, 0.042, 0.075, 0.08, c, 1.04));
    out.push(cbox(-0.036, 0.024, 0.08, 0.036, 0.05, 0.118, c, 1.04));
    out.push(cbox(-0.03, 0.149, -0.115, 0.03, 0.152, -0.03, "#18120e"));
    out.push(cbox(-0.0425, 0.07, -0.03, -0.039, 0.14, 0.0, "#3a2c22")); // side gusset
    out.push(cbox(0.039, 0.07, -0.03, 0.0425, 0.14, 0.0, "#3a2c22"));
  } else if (kind === "slipper") {
    out.push(sole(0.095, 0.02, 0.26, "#c9b996", 0.08));
    const band = new THREE.CylinderGeometry(0.048, 0.048, 0.1, 14, 1, true, -Math.PI / 2, Math.PI);
    band.rotateX(-Math.PI / 2); // the half-shell arches over the toes
    band.scale(1, 0.62, 1);
    band.translate(0, 0.02, 0.055);
    out.push(tint(band, "#4b5866"));
  }
  return out;
}

/** Turns a geometry inside out (winding and normals), e.g. the inner wall of an open vessel. */
function invert(geo) {
  const ix = geo.index.array;
  for (let i = 0; i < ix.length; i += 3) { const a = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = a; }
  const n = geo.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return geo;
}

/**
 * A closed long umbrella standing on its ferrule tip at the origin, shaft along +y (total ~0.86 m): pleated
 * folded canopy with its closing strap, shaft and a timber crook (J) or straight handle. Coloured geometries.
 */
function umbrella({ canopy, handle, crook }, rng) {
  const out = [];
  const pleat = (g, rs, depth) => { // fold the canopy: every other radial vertex pulled in
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if ((i % (rs + 1)) % 2) p.setXYZ(i, p.getX(i) * depth, p.getY(i), p.getZ(i) * depth);
    g.computeVertexNormals();
    return g;
  };
  const tip = new THREE.CylinderGeometry(0.0045, 0.003, 0.045, 8);
  tip.translate(0, 0.0225, 0);
  out.push(tint(tip, "#161616"));
  const rs = 16;
  const lo = pleat(new THREE.CylinderGeometry(0.033, 0.007, 0.44, rs, 1, true), rs, 0.8);
  lo.translate(0, 0.04 + 0.22, 0);
  out.push(tint(lo, canopy));
  const hi = pleat(new THREE.CylinderGeometry(0.011, 0.033, 0.17, rs, 1, true), rs, 0.8);
  hi.translate(0, 0.48 + 0.085, 0);
  out.push(tint(hi, canopy, 0.92));
  const strap = new THREE.CylinderGeometry(0.031, 0.031, 0.026, 12);
  strap.translate(0, 0.43 + rng.float(-0.02, 0.02), 0);
  out.push(tint(strap, canopy, 0.7));
  const cap = new THREE.CylinderGeometry(0.008, 0.011, 0.02, 10);
  cap.translate(0, 0.66, 0);
  out.push(tint(cap, "#242424"));
  const shaft = new THREE.CylinderGeometry(0.0055, 0.0055, 0.08, 8);
  shaft.translate(0, 0.71, 0);
  out.push(tint(shaft, "#8a8a86"));
  const grip = new THREE.CylinderGeometry(0.0115, 0.0105, 0.1, 10);
  grip.translate(0, 0.79, 0);
  out.push(tint(grip, handle));
  if (crook) {
    const rc = 0.03;
    const j = new THREE.TorusGeometry(rc, 0.0105, 8, 14, Math.PI);
    j.translate(rc, 0.84, 0); // arc from the grip top over and down on the +x side
    out.push(tint(j, handle));
    const end = new THREE.SphereGeometry(0.0105, 8, 6);
    end.translate(2 * rc, 0.835, 0);
    out.push(tint(end, handle));
  } else {
    const knob = new THREE.SphereGeometry(0.0125, 10, 8);
    knob.scale(1, 1.3, 1);
    knob.translate(0, 0.845, 0);
    out.push(tint(knob, handle));
  }
  return out;
}

/** Place a pair (toes along local +z) at (x, y, z) facing yaw; small seeded jitter. */
function pair(list, kind, x, y, z, yaw, rng, gap = 0.058, tone, splay = 0.02) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const side of [-1, 1]) {
    const a = yaw + rng.float(-0.05, 0.05) + side * splay;
    const ox = side * gap + rng.float(-0.006, 0.006), oz = rng.float(-0.01, 0.01);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    q.setFromAxisAngle(up, a);
    m.compose(new THREE.Vector3(x + ox * c + oz * s, y, z - ox * s + oz * c), q, new THREE.Vector3(1, 1, 1));
    for (const g of shoe(kind, tone)) {
      g.applyMatrix4(m);
      list.push(g);
    }
  }
}

// ---- build ------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const { room, shell } = layout;
  const T = ctx.textures;
  const rng = ctx.rng;
  const H = room.height;
  const t = shell.walls.thickness;
  const { minX, maxX, minZ, maxZ } = room;

  const root = new THREE.Group();
  root.name = "shell";

  const gk = shell.genkan;
  const kw = gk.kamachi;
  const gx0 = gk.x[0], gx1 = gk.x[1], gz0 = gk.z[0], gz1 = gk.z[1], gy = gk.y;
  const door = shell.door;
  const doorX0 = door.pos[0] - door.width / 2, doorX1 = door.pos[0] + door.width / 2;
  const footY = -0.2; // walls run down past the outside ground (y −0.12): no gap under the house

  // ---- materials ----
  const fl = shell.floor;
  // one square tile must cover the longer room side, so the board pattern never repeats
  const rows = Math.max(fl.rows || 0, Math.ceil(Math.max(room.width, room.depth) / fl.plankWidth));
  const wood = T.wood({
    kind: "planks", size: 1024, rows, color: fl.color, plankWidth: fl.plankWidth, plankLength: fl.plankLength,
    variation: 0.045, grain: 0.55, knots: 0.008, seam: 0.32, rng: rng.fork("floor"),
  });
  const rep = [room.width / wood.worldSize[0], room.depth / wood.worldSize[1]];
  for (const tex of [wood.map, wood.roughnessMap, wood.bumpMap]) if (tex) tex.repeat.set(rep[0], rep[1]);
  const floorAO = T.toTexture(
    aoCanvas(T, 256, Math.round((256 * room.depth) / room.width), room.width, room.depth, { u0: [0.3, 0.22], u1: [0.3, 0.22], v0: [0.3, 0.22], v1: [0.3, 0.22] }, rng.fork("floorAO")),
    { srgb: false, mipmaps: true },
  );
  // Hand-polished: a hard clearcoat whose roughness follows the board/grain map, so the ceiling lamp and the
  // projection glow appear as a soft mirror streak broken up along the grain.
  const floorMat = new THREE.MeshPhysicalMaterial({
    map: wood.map, roughnessMap: wood.roughnessMap, roughness: fl.roughness,
    bumpMap: wood.bumpMap, bumpScale: 0.45,
    clearcoat: fl.clearcoat ?? 0.85, clearcoatRoughness: fl.clearcoatRoughness ?? 0.13, clearcoatRoughnessMap: wood.roughnessMap,
    aoMap: floorAO, aoMapIntensity: 1, envMapIntensity: 1.5,
  });

  const plasterTile = 1.6;
  const plaster = T.noise({ size: 256, color: shell.walls.color, amount: 0.035, scale: 4, octaves: 4, fine: 0.012, rng: rng.fork("plaster") });
  plaster.repeat.set(1 / plasterTile, 1 / plasterTile);
  const plasterBump = T.noise({ size: 256, color: "#808080", amount: 0.25, scale: 8, octaves: 3, fine: 0.05, srgb: false, rng: rng.fork("plasterBump") });
  plasterBump.repeat.set(1 / 0.9, 1 / 0.9);
  // wall UVs are world metres along the wall (projectUV): map [start, start + len] to 0..1
  const wallAO = (start, len, key) => {
    const tex = T.toTexture(
      aoCanvas(T, 256, 128, len, H, { u0: [0.22, 0.25], u1: [0.22, 0.25], v0: [0.28, 0.3], v1: [0.18, 0.22] }, rng.fork(key)),
      { srgb: false, wrap: false },
    );
    tex.repeat.set(1 / len, 1 / H);
    tex.offset.set(-start / len, 0);
    return tex;
  };
  const aoNS = wallAO(minX, room.width, "aoNS"), aoEW = wallAO(minZ, room.depth, "aoEW");
  const wallMat = (ao) =>
    new THREE.MeshStandardMaterial({ map: plaster, bumpMap: plasterBump, bumpScale: 0.25, roughness: shell.walls.roughness, aoMap: ao, aoMapIntensity: 1 });
  const wallMatNS = wallMat(aoNS), wallMatEW = wallMat(aoEW);

  const timberWood = T.wood({ kind: "grain", size: 512, rows: 4, plankWidth: 0.1, color: shell.timber.color, grain: 0.75, variation: 0.04, knots: 0, rng: rng.fork("timber") });
  const grainTile = timberWood.worldSize[0];
  const timberMat = new THREE.MeshStandardMaterial({ map: timberWood.map, roughnessMap: timberWood.roughnessMap, roughness: 0.62 });
  // the same timber, tinted per part through vertex colours (step beams darker, lamp frame as is …)
  const fixtureMat = timberMat.clone();
  fixtureMat.vertexColors = true;
  fixtureMat.roughness = 0.5;

  // ---- floor: the main timber level with the genkan (plus its step beams) cut out ----
  {
    const cx0 = gx0 - kw, cx1 = gx1 + kw, cz0 = gz0 - kw;
    const rects = [[minX, minZ, maxX, cz0], [minX, cz0, cx0, maxZ], [cx1, cz0, maxX, maxZ]];
    const pos = [], nor = [], uv = [], idx = [];
    for (const [x0, z0, x1, z1] of rects) {
      const b = pos.length / 3;
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
        pos.push(x, 0, z);
        nor.push(0, 1, 0);
        uv.push((x - minX) / room.width, (maxZ - z) / room.depth);
      }
      idx.push(b, b + 3, b + 1, b + 1, b + 3, b + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const floor = new THREE.Mesh(geo, floorMat);
    floor.name = "floor";
    floor.receiveShadow = true;
    root.add(floor);
  }

  // ---- walls (each a Group: plaster + its own timber, inside and out) ----
  const ps = shell.timber.postSize;
  const sk = shell.skirting;
  const cn = shell.cornice || { height: 0.06, depth: 0.03 };
  const fc = shell.facade;
  const lib = layout.library;
  const libZ0 = lib ? lib.pos[2] - lib.width / 2 : null, libZ1 = lib ? lib.pos[2] + lib.width / 2 : null;
  const bar = layout.training && layout.training.swedishBar;
  const barZ0 = bar ? bar.pos[2] - bar.width / 2 : null, barZ1 = bar ? bar.pos[2] + bar.width / 2 : null;
  const trng = rng.fork("timberUV");
  const ext = 0.022; // exterior timber stands this proud of the outer plaster face
  const topBand = [H - 0.1, H + shell.ceiling.thickness]; // exterior beam (keta) under the eaves

  const wallGroup = (name, boxes, mat, uAxis) => {
    const group = new THREE.Group();
    group.name = name;
    const geos = boxes.map((b) => projectUV(plainBox(...b), { uAxis, tile: 1 }));
    const mesh = merged(geos, mat, `${name}Plaster`);
    mesh.castShadow = true; // the sun must not shine through the house
    group.add(mesh);
    root.add(group);
    return group;
  };
  // runs [a0, a1] along a wall minus the gaps
  const runs = (a0, a1, gaps) => {
    const out = [];
    let a = a0;
    for (const [g0, g1] of gaps.filter(Boolean).sort((p, q) => p[0] - q[0])) {
      if (g0 > a) out.push([a, Math.min(g0, a1)]);
      a = Math.max(a, g1);
    }
    if (a < a1) out.push([a, a1]);
    return out.filter(([p, q]) => q - p > 0.005);
  };
  const addTimber = (group, geos, name, cast) => {
    if (!geos.length) return;
    const mesh = merged(geos, timberMat, name);
    mesh.castShadow = !!cast;
    group.add(mesh);
  };

  // N wall (z = minZ), interior face at z = minZ
  const N = wallGroup("wallN", [[minX - t, footY, minZ - t, maxX + t, H, minZ]], wallMatNS, 0);
  {
    const g = [];
    for (const [a, b] of runs(minX + ps, maxX - ps, [])) {
      g.push(timberBox(a, 0, minZ, b, sk.height, minZ + sk.depth, trng, grainTile));
      g.push(timberBox(a, H - cn.height, minZ, b, H, minZ + cn.depth, trng, grainTile));
    }
    g.push(timberBox(minX, 0, minZ, minX + ps, H, minZ + ps, trng, grainTile)); // NW post
    // outside: sill beam and eaves beam
    g.push(timberBox(minX - t - ext, -0.12, minZ - t - ext, maxX + t + ext, 0.04, minZ - t, trng, grainTile));
    g.push(timberBox(minX - t - ext, topBand[0], minZ - t - ext, maxX + t + ext, topBand[1], minZ - t, trng, grainTile));
    addTimber(N, g, "wallNTimber");
  }

  // S wall (z = maxZ): the doorway opening x [doorX0, doorX1], y [door.y0, door.height]; the house front outside
  const S = wallGroup("wallS", [
    [minX - t, footY, maxZ, doorX0, H, maxZ + t],
    [doorX1, footY, maxZ, maxX + t, H, maxZ + t],
    [doorX0, door.height, maxZ, doorX1, H, maxZ + t],
    [doorX0, footY, maxZ, doorX1, door.y0, maxZ + t],
  ], wallMatNS, 0);
  {
    const g = [];
    const zo = maxZ + t; // outer plaster face
    for (const [a, b] of runs(minX + ps, maxX - ps, [[gx0 - kw, gx1 + kw]])) g.push(timberBox(a, 0, maxZ - sk.depth, b, sk.height, maxZ, trng, grainTile));
    for (const [a, b] of runs(minX + ps, maxX - ps, [])) g.push(timberBox(a, H - cn.height, maxZ - cn.depth, b, H, maxZ, trng, grainTile));
    // doorway lining in the wall thickness
    const lw = 0.016;
    g.push(timberBox(doorX0, door.y0, maxZ, doorX0 + lw, door.height, zo, trng, grainTile));
    g.push(timberBox(doorX1 - lw, door.y0, maxZ, doorX1, door.height, zo, trng, grainTile));
    g.push(timberBox(doorX0, door.height - lw, maxZ, doorX1, door.height, zo, trng, grainTile));

    // ---- south facade: dark timber frame, plaster panels, a lower band of vertical koshi boards ----
    const pw = fc.postW;
    const xs0 = minX - t - ext, xs1 = maxX + t + ext;
    const postsX = [[xs0, xs0 + pw], [doorX0 - pw, doorX0], [doorX1, doorX1 + pw], [xs1 - pw, xs1]];
    for (const [a, b] of postsX) g.push(timberBox(a, -0.12, zo, b, topBand[1], zo + ext + 0.006, trng, grainTile));
    // intermediate posts splitting each bay either side of the door into spans of ~1.7 m
    const bays = [];
    for (const [a, b] of [[xs0 + pw, doorX0 - pw], [doorX1 + pw, xs1 - pw]]) {
      const n = Math.max(1, Math.round((b - a) / 1.7));
      let x = a;
      for (let i = 1; i < n; i++) {
        const mx = a + ((b - a) * i) / n;
        g.push(timberBox(mx - pw / 2, -0.12, zo, mx + pw / 2, topBand[1], zo + ext, trng, grainTile));
        bays.push([x, mx - pw / 2]);
        x = mx + pw / 2;
      }
      bays.push([x, b]);
    }
    g.push(timberBox(xs0, topBand[0], zo, xs1, topBand[1], zo + ext, trng, grainTile)); // keta
    g.push(timberBox(xs0, fc.band[0], zo, doorX0 - pw, fc.band[1], zo + ext * 0.8, trng, grainTile)); // nageshi
    g.push(timberBox(doorX1 + pw, fc.band[0], zo, xs1, fc.band[1], zo + ext * 0.8, trng, grainTile));
    g.push(timberBox(doorX0 - pw, door.height, zo, doorX1 + pw, door.height + 0.12, zo + ext + 0.01, trng, grainTile)); // lintel
    // sill beam and koshi boards in every bay
    for (const [a, b] of bays) {
      g.push(timberBox(a, -0.12, zo, b, 0.04, zo + ext, trng, grainTile)); // dodai
      g.push(timberBox(a, 0.04, zo, b, fc.koshiTop, zo + 0.008, trng, grainTile)); // backing boards
      g.push(timberBox(a, fc.koshiTop, zo, b, fc.koshiTop + 0.035, zo + ext + 0.004, trng, grainTile)); // cap rail
      const n = Math.max(1, Math.round((b - a) / 0.075));
      const step = (b - a) / n;
      for (let i = 0; i < n; i++) {
        const x = a + step * (i + 0.5);
        g.push(timberBox(x - 0.011, 0.04, zo + 0.008, x + 0.011, fc.koshiTop, zo + ext - 0.002, trng, grainTile));
      }
    }
    addTimber(S, g, "wallSTimber", true);
  }

  // E wall (x = maxX): skirting stops behind the library carcass
  const E = wallGroup("wallE", [[maxX, footY, minZ, maxX + t, H, maxZ]], wallMatEW, 2);
  {
    const g = [];
    for (const [a, b] of runs(minZ + ps, maxZ - ps, [lib ? [libZ0, libZ1] : null])) g.push(timberBox(maxX - sk.depth, 0, a, maxX, sk.height, b, trng, grainTile));
    for (const [a, b] of runs(minZ + ps, maxZ - ps, [])) g.push(timberBox(maxX - cn.depth, H - cn.height, a, maxX, H, b, trng, grainTile));
    g.push(timberBox(maxX - ps, 0, minZ, maxX, H, minZ + ps, trng, grainTile)); // NE post
    g.push(timberBox(maxX - ps, 0, maxZ - ps, maxX, H, maxZ, trng, grainTile)); // SE post
    g.push(timberBox(maxX + t, -0.12, minZ - t, maxX + t + ext, 0.04, maxZ + t, trng, grainTile)); // outside sill beam
    g.push(timberBox(maxX + t, topBand[0], minZ - t, maxX + t + ext, topBand[1], maxZ + t, trng, grainTile));
    addTimber(E, g, "wallETimber");
  }

  // W wall (x = minX): skirting stops behind the Swedish bar rails
  const W = wallGroup("wallW", [[minX - t, footY, minZ, minX, H, maxZ]], wallMatEW, 2);
  {
    const g = [];
    for (const [a, b] of runs(minZ + ps, maxZ - ps, [bar ? [barZ0, barZ1] : null])) g.push(timberBox(minX, 0, a, minX + sk.depth, sk.height, b, trng, grainTile));
    for (const [a, b] of runs(minZ + ps, maxZ - ps, [])) g.push(timberBox(minX, H - cn.height, a, minX + cn.depth, H, b, trng, grainTile));
    g.push(timberBox(minX, 0, maxZ - ps, minX + ps, H, maxZ, trng, grainTile)); // SW post
    g.push(timberBox(minX - t - ext, -0.12, minZ - t, minX - t, 0.04, maxZ + t, trng, grainTile));
    g.push(timberBox(minX - t - ext, topBand[0], minZ - t, minX - t, topBand[1], maxZ + t, trng, grainTile));
    addTimber(W, g, "wallWTimber");
  }

  // ceiling + the roof over the house (one group: both vanish in the overview cutaway)
  const ceiling = new THREE.Group();
  ceiling.name = "ceiling";
  {
    const ceilTex = T.noise({ size: 256, color: shell.ceiling.color, amount: 0.03, scale: 4, fine: 0.01, repeat: [room.width / 2, room.depth / 2], rng: rng.fork("ceiling") });
    const slab = new THREE.Mesh(
      plainBox(minX - t, H, minZ - t, maxX + t, H + shell.ceiling.thickness, maxZ + t),
      new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.95 }),
    );
    slab.name = "ceilingSlab";
    slab.receiveShadow = true;
    slab.castShadow = true;
    ceiling.add(slab);

    // A shallow mono-pitch roof falling to the south, deep eave over the door, exposed rafters under it.
    const rf = shell.roof;
    const so = rf.sideOverhang;
    const zN = minZ - t - so, zS = maxZ + t + rf.eave;
    const xW = minX - t - so, xE = maxX + t + so;
    const under = (z) => rf.y[0] + ((rf.y[1] - rf.y[0]) * (z - zN)) / (zS - zN);
    const top0 = H + shell.ceiling.thickness;
    const timberDark = "#3a2a1f", soffitC = "#8a6a4b";
    const parts = [];
    // wedge filling wall top → roof underside (the gables), sloped top
    const wedge = (x0, x1, z0, z1, color) => {
      const g = plainBox(x0, top0, z0, x1, top0 + 1, z1);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) if (p.getY(i) > top0 + 0.5) p.setY(i, under(p.getZ(i)));
      g.computeVertexNormals();
      return tint(g, color);
    };
    parts.push(wedge(minX - t, maxX + t, minZ - t, maxZ + t, timberDark));
    // roof slab
    {
      const g = plainBox(xW, 0, zN, xE, 1, zS);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, under(p.getZ(i)) + (p.getY(i) > 0.5 ? rf.thickness : 0));
      g.computeVertexNormals();
      parts.push(tint(g, rf.color));
    }
    // standing seams on the roof
    const slope = Math.atan2(rf.y[0] - rf.y[1], zS - zN);
    const len = Math.hypot(zS - zN, rf.y[0] - rf.y[1]);
    for (let x = xW + 0.22; x < xE - 0.1; x += 0.45) {
      const g = new THREE.BoxGeometry(0.018, 0.026, len);
      g.rotateX(slope);
      g.translate(x, (rf.y[0] + rf.y[1]) / 2 + rf.thickness + 0.013, (zN + zS) / 2);
      parts.push(tint(g, rf.color, 0.8));
    }
    // fascia boards
    const fa = 0.15;
    parts.push(cbox(xW - 0.02, under(zS) - 0.06, zS - 0.01, xE + 0.02, under(zS) + rf.thickness + 0.02, zS + 0.025, timberDark));
    parts.push(cbox(xW - 0.02, under(zN) - 0.02, zN - 0.025, xE + 0.02, under(zN) + rf.thickness + 0.02, zN + 0.01, timberDark));
    for (const [x0, x1] of [[xW - 0.02, xW + 0.01], [xE - 0.01, xE + 0.02]]) {
      const g = plainBox(x0, 0, zN, x1, 1, zS);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, under(p.getZ(i)) + (p.getY(i) > 0.5 ? rf.thickness + 0.02 : -fa * 0.4));
      g.computeVertexNormals();
      parts.push(tint(g, timberDark));
    }
    // warm cedar soffit and rafters (taruki) under the south eave
    const zo = maxZ + t;
    {
      const g = plainBox(xW, 0, zo, xE, 1, zS - 0.01);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) p.setY(i, under(p.getZ(i)) - (p.getY(i) > 0.5 ? 0 : 0.012));
      g.computeVertexNormals();
      parts.push(tint(g, soffitC));
    }
    for (let x = xW + 0.1; x < xE - 0.05; x += 0.36) {
      const z0 = zo, z1 = zS - 0.012;
      const g = new THREE.BoxGeometry(0.045, 0.055, z1 - z0);
      g.rotateX(slope);
      g.translate(x, under((z0 + z1) / 2) - 0.012 - 0.0275, (z0 + z1) / 2);
      parts.push(tint(g, "#5a4130"));
    }
    const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.15 });
    const roof = new THREE.Mesh(mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)), false), roofMat);
    roof.name = "roof";
    roof.castShadow = true;
    roof.receiveShadow = true;
    ceiling.add(roof);
  }
  root.add(ceiling);

  const walls = { N, S, E, W, ceiling };

  // ---- fixed joinery outside the wall groups: step beams, door track, getabako, lamp frame (one mesh) ----
  const fx = [];
  const frng = rng.fork("fixturesUV");
  const fix = (x0, y0, z0, x1, y1, z1, k = 1) => fx.push(tint(timberBox(x0, y0, z0, x1, y1, z1, frng, grainTile), "#ffffff", k));
  // agari-kamachi: a darker solid beam on the N, W and E edges; its inner face is the riser
  // The W beam stops short of the S wall: the open shoji slides over the genkan-level sill rail there.
  const kk = 0.62;
  const pz0 = door.panelZ[0], pz1 = door.panelZ[1];
  const railZ0 = pz0 - 0.012;
  fix(gx0 - kw, gy - 0.005, gz0 - kw, gx1 + kw, 0, gz0, kk);
  fix(gx0 - kw, gy - 0.005, gz0, gx0, 0, Math.min(maxZ, railZ0), kk);
  fix(gx1, gy - 0.005, gz0, gx1 + kw, 0, maxZ, kk);
  // door track: kamoi above; a shikii strip on the timber floor where the panel's west end rests open; a sill
  // rail at genkan level from the W step through the doorway (the panel rides on it); a door-stop post at the
  // east edge of the opening
  fix(door.track[0], door.height, pz0 - 0.016, door.track[1], door.height + 0.065, maxZ, 0.9);
  if (door.track[0] < gx0 - kw) fix(door.track[0], 0, railZ0, gx0 - kw, 0.006, pz1 + 0.012, 0.75);
  fix(Math.max(door.track[0], gx0 - kw), door.y0, railZ0, doorX0, door.y0 + 0.03, maxZ, 0.7);
  fix(doorX0, door.y0, railZ0, doorX1, door.y0 + 0.03, maxZ + t + 0.02, 0.7);
  fix(doorX1 + 0.02, door.y0, railZ0, door.track[1], door.height, maxZ, 0.95);
  // genkan-level skirting on the S wall either side of the doorway (the room skirting skips the genkan)
  fix(gx0, gy, maxZ - sk.depth, doorX0, gy + sk.height, maxZ, 0.8);
  if (gx1 > door.track[1]) fix(door.track[1], gy, maxZ - sk.depth, gx1, gy + sk.height, maxZ, 0.8);

  const placed = (p, rotY) => new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY || 0), new THREE.Vector3(1, 1, 1));

  // getabako: full-size open shelf, front (local +z) facing into the genkan, slatted shelves on two levels
  const gb = shell.getabako;
  {
    const list = [];
    const w = gb.width / 2, d = gb.depth / 2, h = gb.height, sd = 0.02;
    const add = (x0, y0, z0, x1, y1, z1, k = 1.25) => list.push(tint(timberBox(x0, y0, z0, x1, y1, z1, frng, grainTile), "#ffffff", k));
    add(-w, 0.02, -d, -w + sd, h - 0.022, d); // sides
    add(w - sd, 0.02, -d, w, h - 0.022, d);
    add(-0.009, 0.046, -d, 0.009, h - 0.022, -d + 0.03, 1.1); // centre back stile
    add(-w - 0.006, h - 0.024, -d, w + 0.006, h, d + 0.01); // top board, a hair proud
    add(-w + 0.02, 0, -d + 0.02, w - 0.02, 0.03, d - 0.03, 0.8); // recessed plinth
    add(-w + sd, h - 0.065, -d, w - sd, h - 0.024, -d + 0.012); // back rails
    add(-w + sd, 0.17, -d, w - sd, 0.205, -d + 0.012);
    const shelves = [0.03, 0.205];
    const slats = 5;
    for (const y of shelves) for (let i = 0; i < slats; i++) { // slatted shelves (sunoko) so shoes can air
      const pitch = (2 * d - 0.024) / slats;
      const z0 = -d + 0.012 + i * pitch;
      add(-w + sd, y, z0, w - sd, y + 0.016, z0 + pitch * 0.78);
    }
    const m = placed(gb.pos, gb.rotY);
    for (const g of list) fx.push(g.applyMatrix4(m));
  }

  // koshikake: a low timber bench to sit on while changing shoes (slab legs through-tenoned by a stretcher)
  const bn = shell.genkanBench;
  if (bn) {
    const list = [];
    const w = bn.width / 2, d = bn.depth / 2, h = bn.height, st = 0.038;
    const add = (x0, y0, z0, x1, y1, z1, k) => list.push(tint(timberBox(x0, y0, z0, x1, y1, z1, frng, grainTile), "#ffffff", k));
    add(-w, h - st, -d, w, h, d, 1.3); // seat
    for (const s of [-1, 1]) {
      const zc = s * (d - 0.075);
      add(-w + 0.025, 0, zc - 0.016, w - 0.025, h - st, zc + 0.016, 1.05); // slab leg
      const ta = zc + s * 0.046, tb = zc - s * 0.016; // tenon end 3 cm proud of the leg's outer face
      add(-0.016, 0.07, Math.min(ta, tb), 0.016, 0.115, Math.max(ta, tb), 0.95);
    }
    add(-0.014, 0.075, -(d - 0.075), 0.014, 0.11, d - 0.075, 0.95); // stretcher (nuki)
    const m = placed(bn.pos, bn.rotY);
    for (const g of list) fx.push(g.applyMatrix4(m));
  }

  // ---- washi ceiling lamp frame (fixture only; main.js owns the lights) ----
  const cl = shell.ceilingLight;
  const lamp = new THREE.Group();
  lamp.name = "ceilingLight";
  lamp.position.set(cl.pos[0], 0, cl.pos[2]);
  {
    const R = cl.diameter / 2;
    const yTop = H, yBot = cl.pos[1] - cl.height / 2;
    const rose = 0.008;
    const shadeTex = T.toTexture(lampCanvas(T, rng.fork("lamp")), { srgb: true });
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(R - 0.012, R - 0.012, yTop - rose - yBot - 0.004, 48),
      new THREE.MeshBasicMaterial({ map: shadeTex, color: new THREE.Color("#ffe6c4"), toneMapped: false }),
    );
    shade.position.y = (yTop - rose + yBot + 0.004) / 2;
    shade.name = "lampShade";
    lamp.add(shade);
    const parts = [];
    const roseG = new THREE.CylinderGeometry(R, R, rose, 48);
    roseG.translate(0, yTop - rose / 2, 0);
    parts.push(roseG);
    const ring = new THREE.CylinderGeometry(R - 0.004, R - 0.004, 0.014, 48, 1, true);
    ring.translate(0, yBot + 0.007, 0);
    parts.push(ring);
    const lrng = rng.fork("lampUV");
    parts.push(timberBox(-(R - 0.012), yBot - 0.001, -0.004, R - 0.012, yBot + 0.004, 0.004, lrng, grainTile));
    parts.push(timberBox(-0.004, yBot - 0.001, -(R - 0.012), 0.004, yBot + 0.004, R - 0.012, lrng, grainTile));
    for (const g of parts) fx.push(tint(g.translate(cl.pos[0], 0, cl.pos[2]), "#ffffff"));
  }
  root.add(lamp);
  {
    const fixtures = merged(fx.map((g) => (g.index ? g.toNonIndexed() : g)), fixtureMat, "fixtures");
    root.add(fixtures);
  }

  // ---- genkan stone floor + the stepping stone outside (one mesh, one atlas) ----
  const st = shell.stepStone;
  {
    const atlas = stoneAtlas(T, gx1 - gx0, maxZ + t - gz0, gk.stone, rng.fork("stone"), gk.course || 0.27);
    const S0 = atlas.S;
    const geos = [];
    {
      const x0 = gx0 - 0.002, x1 = gx1 + 0.002, z0 = gz0 - 0.002, z1 = maxZ + t;
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, gy, (z0 + z1) / 2);
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - gx0) / (gx1 - gx0), 1 - ((p.getZ(i) - gz0) * atlas.ppm) / S0);
      geos.push(g);
    }
    {
      // an irregular, slightly domed flat stone
      const srng = rng.fork("stepStone");
      const seg = 30;
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, seg, 1);
      const p = g.attributes.position, uv = g.attributes.uv;
      const lobes = [srng.float(0, 6.28), srng.float(0, 6.28), srng.float(0, 6.28)];
      const bottom = st.pos[1] - 0.05;
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const r = Math.hypot(x, z);
        const a = Math.atan2(z, x);
        const wob = 1 + 0.06 * Math.sin(2 * a + lobes[0]) + 0.04 * Math.sin(3 * a + lobes[1]) + 0.03 * Math.sin(5 * a + lobes[2]);
        const top = y > 0;
        const shrink = top ? 0.94 : 1; // eased top edge
        const wx = st.pos[0] + x * st.size[0] * wob * shrink, wz = st.pos[2] + z * st.size[1] * wob * shrink;
        const wy = top ? st.top + 0.008 * (1 - 4 * r * r) : bottom;
        p.setXYZ(i, wx, wy, wz);
        const u = 0.03 + 0.94 * ((wx - (st.pos[0] - st.size[0] * 0.6)) / (st.size[0] * 1.2));
        const v = (atlas.stepRow + 4 + (S0 - atlas.stepRow - 8) * ((wz - (st.pos[2] - st.size[1] * 0.6)) / (st.size[1] * 1.2))) / S0;
        uv.setXY(i, u, 1 - v);
      }
      g.computeVertexNormals();
      geos.push(g.toNonIndexed());
    }
    const stoneMat = new THREE.MeshStandardMaterial({ map: atlas.map, bumpMap: atlas.bump, bumpScale: 0.9, roughness: 0.84 });
    const stone = merged(geos.map((g) => (g.index ? g.toNonIndexed() : g)), stoneMat, "genkanStone");
    stone.castShadow = false;
    root.add(stone);
  }

  // ---- shoes on the getabako and slippers waiting on the step (one untextured mesh) ----
  {
    const srng = rng.fork("shoes");
    const list = [];
    const c = Math.cos(gb.rotY), s = Math.sin(gb.rotY);
    const toWorld = (lx, lz) => [gb.pos[0] + lx * c + lz * s, gb.pos[2] - lx * s + lz * c];
    const yawIn = gb.rotY + Math.PI; // toes into the shelf, heels to the genkan
    const levels = [gb.pos[1] + 0.046, gb.pos[1] + 0.221];
    // three slots per level (inner width ~0.86); five pairs, one top slot left free for the outdoor shoes
    const sw = (gb.width - 0.04) / 3;
    const slots = [[-sw, levels[0], "boot"], [0, levels[0], "sneaker"], [sw, levels[0], "geta"], [-sw, levels[1], "leather"], [0, levels[1], "zori"]];
    for (const [lx, y, kind] of slots) {
      const [x, z] = toWorld(lx, gb.depth / 2 - 0.14); // heels just proud of the shelf front
      pair(list, kind, x, y, z, yawIn, srng, kind === "geta" ? 0.054 : 0.057);
    }
    // on the top board: a long bamboo shoehorn and a small glazed dish for keys
    {
      const m = placed(gb.pos, gb.rotY);
      const horn = cbox(-0.21, gb.height, -0.018, 0.21, gb.height + 0.006, 0.018, "#b8925a");
      horn.rotateY(0.06);
      horn.translate(sw * 0.75, 0, 0.02);
      list.push(horn.applyMatrix4(m));
      const dish = tint(new THREE.CylinderGeometry(0.058, 0.045, 0.022, 20), "#4d5c5f");
      dish.translate(-sw, gb.height + 0.011, 0.01);
      list.push(dish.applyMatrix4(m));
      const well = tint(new THREE.CylinderGeometry(0.049, 0.049, 0.002, 20), "#2a3233");
      well.translate(-sw, gb.height + 0.0215, 0.01);
      list.push(well.applyMatrix4(m));
    }
    const sl = shell.slippers;
    pair(list, "slipper", sl.pos[0], sl.pos[1], sl.pos[2], Math.PI, srng, 0.062);
    // outdoor shoes just stepped out of on the stone, turned to face the door
    const os = shell.outdoorShoes;
    if (os) pair(list, "sneaker", os.pos[0], os.pos[1], os.pos[2], os.yaw || 0, srng, 0.068, "#5f6652", 0.07);

    // umbrella stand (glazed stoneware) with two closed umbrellas leaning toward the corner
    const us = shell.umbrellaStand;
    if (us) {
      const R = us.diameter / 2 - 0.003, h = us.height;
      const base = new THREE.Vector3(us.pos[0], us.pos[1], us.pos[2]);
      const glaze = "#3a3934", inside = "#151413";
      const body = tint(new THREE.CylinderGeometry(R, R - 0.008, h - 0.01, 24, 1, true), glaze);
      body.translate(0, (h - 0.01) / 2 + 0.01, 0);
      const foot = tint(new THREE.CylinderGeometry(R - 0.008, R - 0.014, 0.01, 24), glaze, 0.7);
      foot.translate(0, 0.005, 0);
      const inner = tint(invert(new THREE.CylinderGeometry(R - 0.007, R - 0.013, h - 0.03, 24, 1, true)), inside);
      inner.translate(0, (h - 0.03) / 2 + 0.03, 0);
      const floorIn = tint(new THREE.CircleGeometry(R - 0.012, 20).rotateX(-Math.PI / 2), inside);
      floorIn.translate(0, 0.03, 0);
      const rim = tint(new THREE.TorusGeometry(R - 0.0035, 0.0045, 6, 28).rotateX(Math.PI / 2), glaze, 1.2);
      rim.translate(0, h, 0);
      const band = tint(new THREE.CylinderGeometry(R + 0.002, R + 0.001, 0.018, 24, 1, true), glaze, 0.55);
      band.translate(0, h - 0.06, 0);
      for (const g of [body, foot, inner, floorIn, rim, band]) list.push(g.translate(base.x, base.y, base.z));
      const urng = rng.fork("umbrellas");
      list.push(...umbrella({ canopy: "#28324a", handle: "#7a5232", crook: true }, urng)
        .map((g) => g.rotateY(0.6).rotateZ(-0.07).rotateX(0.05).translate(base.x - 0.025, base.y + 0.035, base.z - 0.02)));
      list.push(...umbrella({ canopy: "#5e2723", handle: "#1f1c1a", crook: false }, urng)
        .map((g) => g.rotateY(2.1).rotateZ(0.02).rotateX(0.08).translate(base.x + 0.028, base.y + 0.035, base.z + 0.018)));
    }
    const shoesMesh = new THREE.Mesh(
      mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)), false),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
    );
    shoesMesh.name = "shoes";
    shoesMesh.receiveShadow = true;
    root.add(shoesMesh);
  }

  // ---- sliding shoji on the inside face of the S wall ----
  // Built in world orientation around the opening's centre x; the `panel` group slides along −x (west).
  const doorGroup = new THREE.Group();
  doorGroup.name = "door";
  doorGroup.position.set(door.pos[0], 0, 0);
  const panel = new THREE.Group();
  panel.name = "doorPanel";
  doorGroup.add(panel);
  let washiMat;
  {
    const hw = (door.width + 0.04) / 2; // overlaps the jamb and butts the stop post
    const y0 = door.y0 + 0.03, y1 = door.height + 0.035; // runs on the sill, top hidden in the kamoi groove
    const z0 = pz0, z1 = pz1, zm = (z0 + z1) / 2;
    const stile = 0.055, topRail = 0.07, botRail = 0.1, koshi = 0.5, midRail = 0.045;
    const drng = rng.fork("doorUV");
    const g = [];
    g.push(timberBox(-hw, y0, z0, -hw + stile, y1, z1, drng, grainTile));
    g.push(timberBox(hw - stile, y0, z0, hw, y1, z1, drng, grainTile));
    g.push(timberBox(-hw + stile, y1 - topRail, z0, hw - stile, y1, z1, drng, grainTile));
    g.push(timberBox(-hw + stile, y0, z0, hw - stile, y0 + botRail, z1, drng, grainTile));
    g.push(timberBox(-hw + stile, koshi, z0, hw - stile, koshi + midRail, z1, drng, grainTile));
    g.push(timberBox(-hw + stile, y0 + botRail, zm - 0.007, hw - stile, koshi, zm + 0.007, drng, grainTile)); // koshi-ita
    // kumiko lattice on the room side: 3 columns × 6 rows of near-square panes
    const px0 = -hw + stile, px1 = hw - stile, py0 = koshi + midRail, py1 = y1 - topRail;
    const kb = 0.012, kz0 = z0 + 0.004, kz1 = zm + 0.004;
    for (let i = 1; i < 3; i++) {
      const x = px0 + ((px1 - px0) * i) / 3;
      g.push(timberBox(x - kb / 2, py0, kz0, x + kb / 2, py1, kz1, drng, grainTile));
    }
    for (let j = 1; j < 6; j++) {
      const y = py0 + ((py1 - py0) * j) / 6;
      g.push(timberBox(px0, y - kb / 2, kz0, px1, y + kb / 2, kz1, drng, grainTile));
    }
    // hikite: oval recessed pulls on both faces of the east (leading) stile
    const hx = hw - stile / 2 - 0.004;
    for (const z of [z0 - 0.0012, z1 + 0.0012]) {
      const c = new THREE.CylinderGeometry(0.02, 0.02, 0.0024, 20);
      c.rotateX(Math.PI / 2);
      c.scale(0.62, 1.6, 1);
      c.translate(hx, 0.92, z);
      g.push(c);
    }
    const frame = merged(g.map((q) => (q.index ? q.toNonIndexed() : q)), timberMat, "doorFrame");
    panel.add(frame);

    // washi on the garden face of the kumiko; its glow follows where the light is (see update)
    const paper = T.washi({ size: 512, color: "#f1e7d3", fibres: 380, rng: rng.fork("shoji") });
    paper.map.repeat.set(1, 2);
    washiMat = new THREE.MeshStandardMaterial({
      map: paper.map, roughness: 0.9, emissive: new THREE.Color("#ffcf96"), emissiveMap: paper.map, emissiveIntensity: 0.3,
    });
    const pane = new THREE.Mesh(plainBox(px0, py0, zm + 0.008, px1, py1, zm + 0.0102), washiMat);
    pane.name = "doorWashi";
    pane.receiveShadow = true;
    panel.add(pane);
  }
  root.add(doorGroup);
  // invisible pick proxy over the doorway (never drawn: material.visible = false): the door stays targetable
  // whether the panel is closed, open, or you stand outside
  const doorProxy = new THREE.Mesh(
    plainBox(doorX0 - 0.03, door.y0, door.panelZ[0] - 0.01, doorX1 + 0.03, door.height, maxZ + t + 0.03),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  doorProxy.name = "doorProxy";
  root.add(doorProxy);

  // ---- ensō scroll (kakejiku), hung flat on its wall ----
  const en = shell.enso;
  const enso = new THREE.Group();
  enso.name = "enso";
  enso.position.set(en.pos[0], en.pos[1], en.pos[2]);
  enso.rotation.y = en.rotY || 0;
  {
    const hh = en.height / 2;
    const hookY = hh - 0.012; // the nail, just inside the slot
    const rodY = hh - 0.115; // top rod (hassō)
    const rollerR = 0.012, knobR = 0.016, knobL = 0.02;
    const rollerY = -hh + knobR + 0.002;
    const faceW = en.width - 2 * knobL - 0.02; // mount silk width
    const faceTop = rodY, faceBottom = rollerY;
    const faceH = faceTop - faceBottom;
    const zFace = 0.008;

    const tex = T.toTexture(scrollFace(T, faceW, faceH, rng.fork("scroll")), { srgb: true });
    const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    const face = new THREE.Mesh(plainBox(-faceW / 2, faceBottom, zFace - 0.0012, faceW / 2, faceTop, zFace + 0.0012), faceMat);
    face.name = "ensoFace";
    face.receiveShadow = true;
    enso.add(face);

    const hw = [];
    const cyl = (r, len, x, y, z, seg = 20) => {
      const c = new THREE.CylinderGeometry(r, r, len, seg);
      c.rotateZ(Math.PI / 2);
      c.translate(x, y, z);
      return c;
    };
    const zRoll = knobR + 0.002;
    hw.push(cyl(rollerR, faceW + 0.01, 0, rollerY, zRoll)); // jiku roller
    hw.push(cyl(knobR, knobL, -(faceW / 2 + 0.005 + knobL / 2), rollerY, zRoll)); // jikusaki knobs
    hw.push(cyl(knobR, knobL, faceW / 2 + 0.005 + knobL / 2, rollerY, zRoll));
    const rod = new THREE.CylinderGeometry(0.008, 0.008, faceW + 0.006, 16, 1, false, 0, Math.PI);
    rod.rotateZ(Math.PI / 2);
    rod.rotateX(Math.PI / 2); // round side toward the room
    rod.translate(0, rodY + 0.006, zFace + 0.0015);
    hw.push(rod);
    const cord = 0.0035;
    for (const sx of [-1, 1]) {
      const x0 = sx * faceW * 0.32, y0 = rodY + 0.01, x1 = 0, y1 = hookY - 0.004;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const c = new THREE.BoxGeometry(cord, len, cord);
      c.rotateZ(Math.atan2(x0 - x1, y1 - y0));
      c.translate((x0 + x1) / 2, (y0 + y1) / 2, 0.012);
      hw.push(c);
    }
    const nail = new THREE.CylinderGeometry(0.004, 0.004, 0.018, 10);
    nail.rotateX(Math.PI / 2);
    nail.translate(0, hookY, 0.009);
    hw.push(nail);
    const hardware = merged(hw, new THREE.MeshStandardMaterial({ color: "#241b15", roughness: 0.5, metalness: 0.1 }), "ensoRods");
    enso.add(hardware);
  }
  // the scroll hangs ON its wall: update() hides it with that wall in the overview cutaway (it stays out of the
  // wall group so main.js does not make it a shadow caster)
  const ensoWall = { N, S, E, W }[en.wall] || null;
  root.add(enso);

  {
    const os = shell.outdoorShoes;
    const extra = os ? [[{ x: os.pos[0], z: os.pos[2] + 0.01, w: 0.25, d: 0.27, rotY: os.yaw || 0, y0: os.pos[1] }, 0.03, 0.0, 0.42]] : [];
    root.add(contactShadows(T, gk, extra));
  }

  // ---- door state: eased slide, live `openness`, mutable hotspot label ----
  const slide = door.slide, seconds = door.seconds || 0.6;
  let phase = 0, target = 0;
  const doorSpot = { zone: null, label: "door · open", objects: [doorProxy, panel], onActivate: () => (doorApi.toggle(), true) };
  const apply = () => {
    doorApi.openness = smooth(0, 1, phase);
    panel.position.x = -slide * doorApi.openness;
  };
  const set = (v, instant) => {
    target = v;
    doorSpot.label = v ? "door · close" : "door · open";
    if (instant) { phase = v; apply(); }
  };
  const doorApi = {
    openness: 0,
    toggle() { set(target ? 0 : 1); },
    open(instant = false) { set(1, instant); },
    close(instant = false) { set(0, instant); },
    isOpen: () => target === 1,
  };

  // shoji glow: lit from whichever side is brighter than the viewer's (daylight seen from inside,
  // the warm room seen from the garden at night)
  const warm = new THREE.Color("#ffcf96"), cool = new THREE.Color("#f2f0ea");
  let lastGlow = -1;
  function update(dt) {
    if (ensoWall) enso.visible = ensoWall.visible;
    if (phase !== target) {
      phase = target > phase ? Math.min(target, phase + dt / seconds) : Math.max(target, phase - dt / seconds);
      apply();
    }
    const tm = ctx.time, pl = ctx.player;
    const night = tm && Number.isFinite(tm.night) ? tm.night : 0.7;
    const day = tm && Number.isFinite(tm.day) ? tm.day : 1 - night;
    const outside = !!(pl && pl.outside);
    const glow = outside ? 0.06 + 0.5 * night : 0.08 + 0.32 * day;
    if (Math.abs(glow - lastGlow) > 0.004) {
      lastGlow = glow;
      washiMat.emissiveIntensity = glow;
      washiMat.emissive.lerpColors(cool, warm, outside ? 1 : 0.25);
    }
  }

  scene.add(root);
  return {
    root,
    walls,
    door: doorApi,
    update,
    hotspots: [doorSpot],
  };
}
