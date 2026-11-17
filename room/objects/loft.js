// objects/loft.js — ground-level sleeping nook behind the projection curtain (NW of the room).
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots }.
//
// A calm Scandinavian-Japanese corner: a low oak platform bed along the N wall (head to the W wall) with a
// futon, a linen duvet folded back and two pillows; a small side table at the head with a paper lamp, books
// and a cup; a soft undyed wool rug where you step out of bed; a floor cushion; a peg rail on the N wall
// with two hanging garments; one tall plant; a high paper window panel (flat fitting on the wall face).
// The open floor east of the bed and the strip between bed and curtain stay clear for walking.
// The bed is a hotspot: it calls ctx.vantage() with a sitting-up-in-bed viewpoint (layout.loft.vantage).
//
// Draw calls (main pass): bed 1, timber 1, bedding 1, props 1, rug 1, lamp paper 1, window paper 1 = 7.
// Shadow casters: bed, bedding. One non-shadow PointLight (paper lamp), intensity follows ctx.time.night;
// never toggled or removed (that would recompile every material).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const PI = Math.PI;
const NO_TIME = { night: 0, day: 1 }; // until/unless ENGINE provides ctx.time

// ---- build-time geometry helpers -------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Position / euler rotation / scale applied to a geometry in place. */
function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1], order = "XYZ") {
  _e.set(r[0], r[1], r[2], order);
  _q.setFromEuler(_e);
  _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
  return g.applyMatrix4(_m);
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** Flat vertex colour (linear working space). */
function tint(g, hex) {
  g = flat(g);
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  if (g.attributes.uv) g.deleteAttribute("uv");
  return g;
}

/**
 * Axis-aligned box from min/max corners with UVs in metres / tile. U follows the box's longest axis when it
 * lies in the face (wood grain runs along the member), V the other face axis. ou / ov offset the texture.
 */
function woodBox(x0, y0, z0, x1, y1, z1, tile, ou = 0, ov = 0) {
  const dims = [x1 - x0, y1 - y0, z1 - z0];
  const long = dims.indexOf(Math.max(...dims));
  const g = new THREE.BoxGeometry(dims[0], dims[1], dims[2]);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  const p = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const n = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))];
    const na = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2;
    const axes = [0, 1, 2].filter((a) => a !== na);
    const ua = axes.includes(long) ? long : dims[axes[0]] >= dims[axes[1]] ? axes[0] : axes[1];
    const va = axes[0] === ua ? axes[1] : axes[0];
    p[0] = pos.getX(i); p[1] = pos.getY(i); p[2] = pos.getZ(i);
    uv.setXY(i, p[ua] / tile + ou, p[va] / tile + ov);
  }
  return flat(g);
}

/** Cylinder between two points (build-time). */
function rod(a, b, r, seg = 8) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const d = new THREE.Vector3().subVectors(B, A);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

/** Pillow: a sphere pushed toward a rounded square in plan, so the edges taper and the middle stays puffy. */
function pillowGeo(w, h, d) {
  const g = new THREE.SphereGeometry(1, 28, 14);
  const pos = g.attributes.position;
  const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.42);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i, (sq(x) * w) / 2, (y * h) / 2, (sq(z) * d) / 2);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Hanging garment (local: hangs from y 0 down, width along x, thin along z, front +z): a thin slab with
 * rounded sloping shoulders, a neck dip, a slight flare and soft vertical folds, plus two sleeves hanging
 * close to the body, tapering to the cuff.
 */
function garmentGeo(w, len, flare, sleeve, depth, seed) {
  const g = new THREE.BoxGeometry(1, 1, 1, 12, 18, 2);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i), v = pos.getY(i) + 0.5, f = pos.getZ(i); // v: 1 top, 0 hem
    const width = w * (1 + flare * (1 - v) * (1 - v * 0.3));
    const x = u * width;
    const au = Math.abs(u) * 2; // 0 centre … 1 edge
    const top = -0.11 * Math.pow(au, 1.6) * (w / 0.42) - 0.025 * Math.exp(-au * au * 30); // shoulders + neck dip
    const y = -(1 - v) * len + top * Math.min(1, v * 5);
    const round = Math.sqrt(Math.max(0, 1 - au * au * 0.85)); // thicker in the middle (a body's worth of drape)
    const fold = 0.01 * Math.sin(u * 13 + seed) * (1 - v) + 0.006 * Math.sin(u * 29 + seed * 2) * (1 - v);
    pos.setXYZ(i, x, y, f * depth * (0.35 + 0.65 * round) + fold + 0.012 * round * v);
  }
  g.computeVertexNormals();
  const parts = [g];
  for (const sx of [-1, 1]) {
    const sl = new THREE.CylinderGeometry(sleeve[0] * 0.38, sleeve[0] * 0.5, sleeve[1], 10, 4);
    sl.scale(1, 1, 0.55);
    sl.translate(0, -sleeve[1] / 2, 0);
    xf(sl, [sx * (w / 2 - sleeve[0] * 0.2), -0.1 * (w / 0.42) + 0.01, depth * 0.25], [0.04, 0, sx * 0.1]);
    parts.push(sl);
  }
  return mergeGeometries(parts.map(flat), false);
}

/** Undyed wool rug, whole rug in one tile: soft mottling, low ribs, a slightly darker border band. */
function woolTexture(T, color, rng) {
  const S = 512;
  const { canvas, ctx: c } = T.makeCanvas(S);
  c.fillStyle = color;
  c.fillRect(0, 0, S, S);
  for (let i = 0; i < 90; i++) {
    const x = rng.float(0, S), y = rng.float(0, S), r = rng.float(20, 80);
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const light = rng.chance(0.5);
    g.addColorStop(0, light ? "rgba(255,252,245,0.07)" : "rgba(90,75,55,0.06)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  for (let y = 0; y < S; y += 5) { c.fillStyle = `rgba(70,58,42,${rng.float(0.04, 0.08).toFixed(3)})`; c.fillRect(0, y, S, 1.5); }
  c.strokeStyle = "rgba(95,80,60,0.22)";
  c.lineWidth = S * 0.018;
  c.strokeRect(S * 0.05, S * 0.05, S * 0.9, S * 0.9);
  T.grainOverlay(c, S, S, { rng, amount: 0.06, scale: 3, fine: 0.04 });
  return T.toTexture(canvas, { srgb: true });
}

function mergeMesh(list, material, name, cast) {
  const geo = mergeGeometries(list.map(flat), false);
  for (const g of list) g.dispose();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = !!cast;
  mesh.receiveShadow = true;
  return mesh;
}

// ---- build -----------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const L = layout.loft;
  const T = ctx.textures;
  const rng = ctx.rng;
  const root = new THREE.Group();
  root.name = "loft";

  // ---- materials ----
  const oak = T.wood({ kind: "grain", size: 512, color: L.bed.color, grain: 0.5, knots: 0.0, rng: rng.fork("oak") });
  const oakMat = new THREE.MeshStandardMaterial({ map: oak.map, roughnessMap: oak.roughnessMap, bumpMap: oak.bumpMap, bumpScale: 0.3, roughness: 0.62 });
  oakMat.name = "nookOak";
  const tile = oak.worldSize[0];
  const off = () => [rng.float(0, 1), rng.float(0, 1)];
  const wb = (x0, y0, z0, x1, y1, z1) => woodBox(x0, y0, z0, x1, y1, z1, tile, ...off());

  // ---- bed platform (casts): recessed plinth + a slab top that seems to float ----
  const B = L.bed;
  const [BX0, BX1] = B.x, [BZ0, BZ1] = B.z;
  const slab = 0.06, PL = B.plinthInset;
  const bedParts = [
    wb(BX0 + PL, 0, BZ0 + PL, BX1 - PL, B.height - slab, BZ1 - PL),
    wb(BX0, B.height - slab, BZ0, BX1, B.height, BZ1),
  ];
  const bed = mergeMesh(bedParts, oakMat, "nookBed", true);
  root.add(bed);

  // ---- other timber: side table, peg rail (no shadows) ----
  const tb = L.table;
  const [tw, th, td] = tb.size;
  const [tx, , tz] = tb.pos;
  const tm = [];
  tm.push(wb(tx - tw / 2, th - 0.03, tz - td / 2, tx + tw / 2, th, tz + td / 2)); // top
  tm.push(wb(tx - tw / 2 + 0.03, 0.1, tz - td / 2 + 0.03, tx + tw / 2 - 0.03, 0.12, tz + td / 2 - 0.03)); // shelf
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = tx + sx * (tw / 2 - 0.035), lz = tz + sz * (td / 2 - 0.035);
    tm.push(wb(lx - 0.015, 0, lz - 0.015, lx + 0.015, th - 0.03, lz + 0.015));
  }
  const RL = L.rail;
  const rz = RL.z + 0.004;
  tm.push(wb(RL.x[0], RL.y - 0.045, rz, RL.x[1], RL.y + 0.045, rz + 0.02));
  const pegX = [RL.x[0] + 0.16, (RL.x[0] + RL.x[1]) / 2, RL.x[1] - 0.16];
  for (const px of pegX) {
    const peg = new THREE.CylinderGeometry(0.011, 0.014, 0.085, 12);
    peg.rotateX(PI / 2 - 0.12);
    peg.translate(px, RL.y + 0.004, rz + 0.02 + 0.042);
    tm.push(peg);
  }
  const timber = mergeMesh(tm, oakMat, "nookTimber", false);
  root.add(timber);

  // ---- bedding (casts): futon, duvet draped over the foot and the S side and folded back, pillows ----
  const M = L.mattress;
  const mx0 = BX0 + M.inset, mx1 = BX1 - M.inset, mz0 = BZ0 + M.inset, mz1 = BZ1 - M.inset;
  const MTOP = B.height + M.height;
  const bd = [];
  bd.push(tint(xf(new RoundedBoxGeometry(mx1 - mx0, M.height, mz1 - mz0, 3, 0.04), [(mx0 + mx1) / 2, B.height + M.height / 2, (mz0 + mz1) / 2]), M.color));
  {
    // duvet: a grid laid over the futon from `from` to the foot; past the futon's S / E edges it folds down
    // the side (the N side meets the wall). A soft wrinkle field on top.
    const D = L.duvet;
    const ov = 0.16, th2 = 0.035;
    const x0 = D.from, x1 = mx1 + ov, z0 = mz0 + 0.01, z1 = mz1 + ov;
    const nx = 40, nz = 28;
    const g = new THREE.PlaneGeometry(1, 1, nx, nz);
    const pos = g.attributes.position;
    const drng = rng.fork("duvet");
    const ph = [drng.float(0, 6), drng.float(0, 6), drng.float(0, 6)];
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) + 0.5, v = 0.5 - pos.getY(i);
      let x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * v, y = MTOP + th2;
      const wr = 0.01 * Math.sin(x * 9 + z * 4 + ph[0]) * Math.sin(z * 13 + ph[1]) + 0.006 * Math.sin(x * 23 + ph[2]);
      y += wr;
      const pz = z - mz1, px = x - mx1; // overhang past the S / E (foot) edges
      if (pz > 0) { y -= pz + 0.01; z = mz1 + 0.012 + 0.025 * Math.sin(pz * 12) * pz * 4; }
      if (px > 0) { y -= px + 0.01; x = mx1 + 0.012 + 0.02 * pz; }
      pos.setXYZ(i, x, Math.max(y, B.height + 0.01), z);
    }
    g.computeVertexNormals();
    bd.push(tint(g, D.color));
    // folded-back band at the head end: a soft roll + the turned-over layer lying on top
    const roll = new THREE.CylinderGeometry(0.035, 0.035, mz1 - mz0 + 0.1, 16, 1);
    roll.rotateX(PI / 2);
    bd.push(tint(xf(roll, [x0 + 0.01, MTOP + 0.035, (mz0 + mz1) / 2 + 0.04], [0, 0, 0], [1, 0.75, 1]), D.fold));
    bd.push(tint(xf(new RoundedBoxGeometry(0.3, 0.025, mz1 - mz0 + 0.06, 2, 0.011), [x0 + 0.16, MTOP + th2 + 0.02, (mz0 + mz1) / 2 + 0.03], [0, 0, -0.04]), D.fold));
  }
  {
    // two pillows at the head (W), side by side across the bed
    const [pc0, pc1] = L.pillows.color;
    const pcx = mx0 + 0.24, w = (mz1 - mz0) / 2 - 0.05;
    bd.push(tint(xf(pillowGeo(w, 0.14, 0.4), [pcx, MTOP + 0.06, mz0 + w / 2 + 0.035], [0, PI / 2 + 0.03, -0.12], [1, 1, 1], "YXZ"), pc0));
    bd.push(tint(xf(pillowGeo(w, 0.13, 0.39), [pcx + 0.02, MTOP + 0.06, mz1 - w / 2 - 0.035], [0, PI / 2 - 0.05, -0.1], [1, 1, 1], "YXZ"), pc1));
  }
  const beddingMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, side: THREE.DoubleSide });
  beddingMat.name = "nookBedding";
  const bedding = mergeMesh(bd, beddingMat, "nookBedding", true);
  root.add(bedding);

  // ---- props (vertex-coloured, no shadows): books, cup, lamp stand, cushion, garments, plant, window frame ----
  const pr = [];
  // books: two on the shelf, one on the table top under the cup's side
  {
    const [bx, bz] = L.books.pos;
    const cols = L.books.colors;
    const book = (w, h, d, c, y, yaw, col) => {
      pr.push(tint(xf(new THREE.BoxGeometry(w, h, d), [c[0], y + h / 2, c[1]], [0, yaw, 0]), col));
      const pages = new THREE.BoxGeometry(w - 0.01, h * 0.76, d - 0.008);
      pages.translate(0.006, 0, 0);
      pr.push(tint(xf(pages, [c[0], y + h / 2, c[1]], [0, yaw, 0]), "#ebe3d1"));
    };
    book(0.2, 0.028, 0.14, [tx - 0.01, tz], 0.12, 0.08, cols[0]);
    book(0.19, 0.022, 0.135, [tx, tz + 0.005], 0.148, -0.06, cols[1]);
    book(0.17, 0.02, 0.12, [bx, bz], th, 0.35, cols[2]);
  }
  // cup (yunomi) on the book
  {
    const [cx, cz] = L.cup.pos;
    const y = th + 0.02;
    pr.push(tint(xf(new THREE.CylinderGeometry(0.033, 0.028, 0.075, 18, 1), [cx, y + 0.0375, cz]), L.cup.color));
    pr.push(tint(xf(new THREE.CylinderGeometry(0.029, 0.029, 0.002, 18), [cx, y + 0.068, cz]), "#7a5b3a"));
  }
  // lamp stand: small dark disc foot and a wire spine (the paper is its own mesh)
  const LP = L.lamp;
  pr.push(tint(xf(new THREE.CylinderGeometry(0.06, 0.065, 0.012, 20), [LP.pos[0], LP.pos[1] + 0.006, LP.pos[2]]), "#2b2926"));
  pr.push(tint(rod([LP.pos[0], LP.pos[1] + 0.01, LP.pos[2]], [LP.pos[0], LP.pos[1] + 0.05, LP.pos[2]], 0.004, 6), "#2b2926"));
  // floor cushion: a flat zabuton with a round zafu on it
  {
    const C = L.cushion;
    const [cx, , cz] = C.pos;
    pr.push(tint(xf(new RoundedBoxGeometry(C.mat, 0.05, C.mat, 3, 0.022), [cx, 0.025, cz], [0, 0.12, 0]), C.matColor));
    const zafu = new THREE.SphereGeometry(C.diameter / 2, 24, 12);
    xf(zafu, [cx + 0.02, 0.05 + C.height / 2, cz - 0.02], [0, 0, 0], [1, C.height / C.diameter, 1]);
    pr.push(tint(zafu, C.color));
  }
  // garments: a linen shirt on a wooden hanger (W peg) and a long dark robe from its loop (E peg)
  {
    const [shirtCol, robeCol] = RL.garments;
    const pegFront = rz + 0.02 + 0.07;
    const hz = rz + 0.02 + 0.045; // hang point in front of the board
    // hanger: hook rod over the peg + a slim bar
    const hx = pegX[0];
    pr.push(tint(rod([hx, RL.y + 0.012, hz], [hx, RL.y - 0.07, hz], 0.0025, 6), "#8d8a84"));
    pr.push(tint(xf(new THREE.BoxGeometry(0.42, 0.018, 0.012), [hx, RL.y - 0.075, hz + 0.006]), "#b08a60"));
    const shirt = garmentGeo(0.42, 0.68, 0.05, [0.11, 0.5], 0.028, 1.3);
    pr.push(tint(xf(shirt, [hx, RL.y - 0.08, hz + 0.02], [0.03, 0.04, 0]), shirtCol));
    const rx = pegX[2];
    pr.push(tint(xf(new THREE.TorusGeometry(0.018, 0.003, 6, 12), [rx, RL.y - 0.005, hz], [0, 0, 0]), robeCol));
    const robe = garmentGeo(0.4, 1.02, 0.28, [0.16, 0.46], 0.04, 4.1);
    pr.push(tint(xf(robe, [rx, RL.y - 0.02, Math.max(hz + 0.03, pegFront - 0.03)], [0.04, -0.05, 0]), robeCol));
  }
  // plant: tall ceramic pot, three stems with large fiddle-leaf leaves
  {
    const P = L.plant;
    const [qx, , qz] = P.pos;
    const potH = 0.36;
    pr.push(tint(xf(new THREE.CylinderGeometry(0.165, 0.135, potH, 28, 1), [qx, potH / 2, qz]), P.pot));
    pr.push(tint(xf(new THREE.CylinderGeometry(0.152, 0.152, 0.01, 24), [qx, potH - 0.025, qz]), "#3a2e25"));
    const prng = rng.fork("plant");
    const stems = [[0.02, -0.01, P.height - 0.06, 0.06], [-0.04, 0.03, P.height - 0.38, -0.08], [0.05, 0.04, P.height - 0.6, 0.1]];
    for (const [ox, oz, top, lean] of stems) {
      const base = [qx + ox, potH - 0.02, qz + oz];
      const tip = [qx + ox + lean, top, qz + oz + lean * 0.5];
      pr.push(tint(rod(base, tip, 0.009, 6), "#6a5a44"));
      const n = Math.round((top - 0.55) / 0.075);
      for (let i = 0; i < n; i++) {
        const f = 0.3 + (0.7 * (i + 0.5)) / n;
        const at = [base[0] + (tip[0] - base[0]) * f, base[1] + (tip[1] - base[1]) * f, base[2] + (tip[2] - base[2]) * f];
        const len = prng.float(0.22, 0.3) * (0.8 + 0.3 * f);
        const leaf = new THREE.SphereGeometry(1, 12, 6);
        leaf.scale(len * 0.4, 0.01, len / 2);
        leaf.translate(0, 0, len / 2);
        // pitch: leaves droop lower down the stem, cup upward near the top
        xf(leaf, at, [-prng.float(0.15, 0.6) * f - 0.05, i * 2.4 + prng.float(-0.5, 0.5), prng.float(-0.25, 0.25)], [1, 1, 1], "YXZ");
        pr.push(tint(leaf, T.shade(P.leaf, prng.float(-0.1, 0.12))));
      }
    }
  }
  // window frame: dark timber surround and a light kumiko grid over the paper
  const W = L.window;
  const [wx0, wx1] = W.x, [wy0, wy1] = W.y;
  const wz = W.z;
  {
    const fw = 0.035, fd = W.depth;
    const fr = W.frame;
    pr.push(tint(xf(new THREE.BoxGeometry(wx1 - wx0, fw, fd), [(wx0 + wx1) / 2, wy1 - fw / 2, wz + fd / 2]), fr));
    pr.push(tint(xf(new THREE.BoxGeometry(wx1 - wx0 + 0.03, fw + 0.008, fd + 0.012), [(wx0 + wx1) / 2, wy0 + fw / 2 - 0.004, wz + (fd + 0.012) / 2]), fr)); // sill
    for (const x of [wx0 + fw / 2, wx1 - fw / 2]) pr.push(tint(xf(new THREE.BoxGeometry(fw, wy1 - wy0, fd), [x, (wy0 + wy1) / 2, wz + fd / 2]), fr));
    const kd = 0.012, kw = 0.011, kz = wz + 0.012 + kd / 2;
    for (let i = 1; i < 4; i++) pr.push(tint(xf(new THREE.BoxGeometry(kw, wy1 - wy0 - 2 * fw, kd), [wx0 + ((wx1 - wx0) * i) / 4, (wy0 + wy1) / 2, kz]), "#c9b08c"));
    for (let i = 1; i < 3; i++) pr.push(tint(xf(new THREE.BoxGeometry(wx1 - wx0 - 2 * fw, kw, kd), [(wx0 + wx1) / 2, wy0 + ((wy1 - wy0) * i) / 3, kz]), "#c9b08c"));
  }
  const propsMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.02 });
  propsMat.name = "nookProps";
  const props = mergeMesh(pr, propsMat, "nookProps", false);
  root.add(props);

  // ---- rug: undyed wool, soft rounded slab ----
  {
    const RG = L.rug;
    const w = RG.x[1] - RG.x[0], d = RG.z[1] - RG.z[0];
    const wool = woolTexture(T, RG.color, rng.fork("rug"));
    const rugMat = new THREE.MeshStandardMaterial({ map: wool, roughness: 1 });
    rugMat.name = "nookRug";
    const rug = new THREE.Mesh(new RoundedBoxGeometry(w, RG.height, d, 2, RG.height / 2), rugMat);
    rug.position.set((RG.x[0] + RG.x[1]) / 2, RG.height / 2, (RG.z[0] + RG.z[1]) / 2);
    rug.rotation.y = 0.015;
    rug.name = "nookRug";
    rug.receiveShadow = true;
    root.add(rug);
  }

  // ---- paper lamp (akari): lathe of an oval with rib lines, emissive by night ----
  const paper = T.washi({ size: 256, color: "#f3ead8", fibres: 220, rng: rng.fork("washi") });
  const ribbed = T.washi({ size: 256, color: "#f3ead8", fibres: 220, rng: rng.fork("washiRib") });
  {
    const c = ribbed.ctx;
    c.strokeStyle = "rgba(90,70,50,0.45)";
    c.lineWidth = 2;
    for (let i = 1; i < 9; i++) { c.beginPath(); c.moveTo(0, (i * 256) / 9); c.lineTo(256, (i * 256) / 9); c.stroke(); }
    ribbed.map.needsUpdate = true;
  }
  const glowCol = new THREE.Color(LP.glow);
  const lampMat = new THREE.MeshStandardMaterial({ map: ribbed.map, emissive: glowCol, emissiveMap: ribbed.map, emissiveIntensity: 0, roughness: 0.9 });
  lampMat.name = "nookLampPaper";
  const prof = [];
  const lh = LP.height - 0.05, lr = LP.diameter / 2;
  for (let i = 0; i <= 16; i++) {
    const a = (i / 16) * PI;
    prof.push(new THREE.Vector2(Math.max(0.012, Math.sin(a) * lr * (1 - 0.12 * Math.cos(a))), -Math.cos(a) * lh / 2));
  }
  const lampPaper = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), lampMat);
  lampPaper.position.set(LP.pos[0], LP.pos[1] + 0.05 + lh / 2, LP.pos[2]);
  lampPaper.name = "nookLamp";
  root.add(lampPaper);

  const lc = LP.light;
  const lamp = new THREE.PointLight(LP.glow, 0, lc.distance, lc.decay);
  lamp.name = "nookLampLight";
  lamp.castShadow = false;
  lamp.position.copy(lampPaper.position);
  if (Array.isArray(lc.offset)) lamp.position.add(new THREE.Vector3(...lc.offset));
  root.add(lamp);

  // ---- window paper: flat panel on the wall face, glowing with daylight ----
  const winMat = new THREE.MeshStandardMaterial({ map: paper.map, emissive: new THREE.Color(W.glow), emissiveMap: paper.map, emissiveIntensity: 0, roughness: 0.95 });
  winMat.name = "nookWindowPaper";
  const winPaper = new THREE.Mesh(new THREE.PlaneGeometry(wx1 - wx0 - 0.05, wy1 - wy0 - 0.05), winMat);
  winPaper.position.set((wx0 + wx1) / 2, (wy0 + wy1) / 2, wz + 0.01);
  winPaper.name = "nookWindow";
  root.add(winPaper);

  let lastNight = -1, lastDay = -1;
  function applyTime(tm) {
    const n = typeof tm.night === "number" ? tm.night : 0;
    const d = typeof tm.day === "number" ? tm.day : 1 - n;
    if (Math.abs(n - lastNight) > 0.002) {
      lastNight = n;
      lamp.intensity = lc.intensity * n;
      lampMat.emissiveIntensity = 0.04 + 1.3 * n;
    }
    if (Math.abs(d - lastDay) > 0.002) {
      lastDay = d;
      winMat.emissiveIntensity = 0.03 + 0.75 * d;
    }
  }
  applyTime(ctx.time ?? NO_TIME);

  scene.add(root);

  const V = L.vantage;
  return {
    root,
    update() {
      applyTime(ctx.time ?? NO_TIME);
    },
    hotspots: [{
      zone: null,
      label: "bed · lie down",
      objects: [bed, bedding],
      onActivate() {
        if (typeof ctx.vantage !== "function") return false;
        ctx.vantage({ pos: V.pos, target: V.target, label: V.label });
        return true;
      },
    }],
  };
}
