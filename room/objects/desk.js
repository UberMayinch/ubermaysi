// objects/desk.js — standing desk (SPEC §5.5) set up as a streaming rig: telescoping T-leg frame, walnut
// top, height keypad; main monitor on a clamp arm showing a stream-software scene (latest rhizoMorphic
// post as the "now showing" slide), webcam, LED key light, boom-arm broadcast mic, stream-control pad,
// audio interface, headphones on the arm pole, ON AIR box, keyboard + mouse on a mat, the laptop as the
// second screen ("laptop" zone), the open journal with pen and ribbon ("journal" zone), tea cup.
// Contract: build(scene, layout, ctx) -> { root, update, colliders, hotspots }.
//
// Desk-local frame: origin on the floor under the middle of the top, +z is the side the user stands on,
// +x is the user's right. update() only redraws the monitor canvas (<= LAYOUT.desk.rig.monitor.hz) and
// pulses one pad key; it allocates nothing.
//
// Draw calls: top, frame, keypad face, cup, laptop ×3 (aluminium, dark parts, screen), journal ×3
// (pages, cover + ribbon + pen body, pen metal), rig ×6 (monitor body, monitor screen, gear, gear metal,
// glow faces, pad keys) = 16, plus 3 in the shadow pass (top, frame, monitor body).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEG = Math.PI / 180;
const SERIF = '"Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", "P052", Georgia, "Times New Roman", serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "DejaVu Sans", "Liberation Sans", sans-serif';
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- geometry helpers (build time only) ----------------------------------------------------------------

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** Vertex-colour a geometry (returns it, non-indexed). */
function paint(g, color) {
  g = flat(g);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

function roundedRect(w, h, r) {
  const x = w / 2, y = h / 2;
  r = Math.max(0.0002, Math.min(r, x - 1e-4, y - 1e-4));
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Rounded plate in the XY plane, centred on x/y, spanning z 0…t. `r` plan corner radius, `b` edge bevel. */
function plate(w, h, t, r = 0, b = 0, curve = 4) {
  b = Math.min(b, t * 0.45);
  const shape = roundedRect(w - 2 * b, h - 2 * b, Math.max(r - b, 0.0003));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: t - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: curve, steps: 1,
  });
  g.translate(0, 0, b);
  return flat(g);
}

/** Rounded prism standing on y = 0: plan w (x) × d (z), height h. */
function prism(w, d, h, r = 0, b = 0, curve = 4) {
  const g = plate(w, d, h, r, b, curve);
  g.rotateX(-Math.PI / 2);
  return g;
}

const at = (g, x, y, z) => g.translate(x, y, z);
const box = (w, h, d, x, y, z) => flat(new THREE.BoxGeometry(w, h, d)).translate(x, y, z);
/** Cylinder / cone lying along +x, from x0 to x1, radius r0 → r1. */
function rod(x0, x1, r0, r1, seg = 12) {
  const g = flat(new THREE.CylinderGeometry(r1, r0, x1 - x0, seg, 1, false));
  g.rotateZ(-Math.PI / 2);
  g.translate((x0 + x1) / 2, 0, 0);
  return g;
}

/** Non-indexed geometry from loose quads. Each quad is wound so its face normal agrees with `n`. */
function quadBuilder() {
  const pos = [], nor = [], uv = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = (p, q, r, np, nq, nr, tp, tq, tr) => {
    pos.push(...p, ...q, ...r);
    nor.push(...np, ...nq, ...nr);
    uv.push(...tp, ...tq, ...tr);
  };
  return {
    // p0..p3 around the quad; n0..n3 per-corner normals (or one normal); t0..t3 uvs.
    quad(p, n, t) {
      const ns = Array.isArray(n[0]) ? n : [n, n, n, n];
      a.fromArray(p[1]).sub(c.fromArray(p[0]));
      b.fromArray(p[2]).sub(c.fromArray(p[0]));
      a.cross(b);
      const ok = a.x * ns[0][0] + a.y * ns[0][1] + a.z * ns[0][2] >= 0;
      const o = ok ? [0, 1, 2, 3] : [0, 3, 2, 1];
      tri(p[o[0]], p[o[1]], p[o[2]], ns[o[0]], ns[o[1]], ns[o[2]], t[o[0]], t[o[1]], t[o[2]]);
      tri(p[o[0]], p[o[2]], p[o[3]], ns[o[0]], ns[o[2]], ns[o[3]], t[o[0]], t[o[2]], t[o[3]]);
    },
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      return g;
    },
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const v3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);

/** Cylinder from point a to point b (arrays or Vector3), radius ra at a, rb at b. */
function tube(a, b, ra, seg = 10, rb = ra) {
  const A = a.isVector3 ? a.clone() : v3(a), B = b.isVector3 ? b.clone() : v3(b);
  const dir = B.sub(A);
  const len = dir.length();
  const g = flat(new THREE.CylinderGeometry(rb, ra, len, seg, 1, false));
  g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  return g.translate(A.x, A.y, A.z);
}

const ball = (r, p, w = 12, h = 8) => flat(new THREE.SphereGeometry(r, w, h)).translate(p[0], p[1], p[2]);

/** Torus in the XY plane (axis +z), optionally only an arc starting at +x. */
const ring = (R, r, seg = 24, arc = Math.PI * 2, rs = 8) => flat(new THREE.TorusGeometry(R, r, rs, seg, arc));

/** Rotation + translation whose +z points from `pos` toward `aim`. */
function aimMatrix(pos, aim) {
  const m = new THREE.Matrix4().lookAt(v3(aim), v3(pos), UP);
  return m.setPosition(pos[0], pos[1], pos[2]);
}

/** Yaw (about +y, degrees) then translate. */
const placeY = (pos, deg = 0) => new THREE.Matrix4().makeRotationY(deg * DEG).setPosition(pos[0], pos[1], pos[2]);

/** Squeeze a geometry's 0…1 uvs into an atlas sub-rectangle. */
function uvRect(g, [u0, v0, u1, v1]) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}

function mesh(name, geometries, material, { cast = false } = {}) {
  const merged = mergeGeometries(geometries, false);
  if (!merged) throw new Error(`desk.js: mergeGeometries failed for "${name}" (mismatched attributes)`);
  const m = new THREE.Mesh(merged, material);
  m.name = name;
  m.castShadow = cast;
  m.receiveShadow = true;
  for (const g of geometries) g.dispose();
  return m;
}

// ---- canvases ------------------------------------------------------------------------------------------

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
  c.fill();
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 26);

/** Dark code editor. The first line is a comment carrying the latest technical post title. */
function drawEditor(c, W, H, title, rng) {
  const T = {
    bg: "#15161c", side: "#101116", bar: "#0c0d11", line: "#1d1f28", gutter: "#474c63", dim: "#2a2d3a",
    k: "#c594e8", f: "#7fa8f8", s: "#b9dc8a", n: "#f0926e", p: "#a9b0cf", c: "#69708f", o: "#7ecfd6", t: "#e2c27c",
  };
  const top = 32, status = 22, side = 150, gutter = 46, lh = 24, cw = 8.4;
  c.fillStyle = T.bg;
  c.fillRect(0, 0, W, H);

  // tab strip
  c.fillStyle = T.bar;
  c.fillRect(0, 0, W, top);
  c.fillStyle = T.bg;
  c.fillRect(side, 4, 236, top - 4);
  c.fillStyle = "#8f3a2b";
  c.fillRect(side, 4, 236, 2);
  c.font = `13px ${MONO}`;
  c.textBaseline = "middle";
  c.fillStyle = "#c9cde0";
  const file = `${slug(title) || "notes"}.py`;
  c.fillText(file, side + 14, top / 2 + 3);
  c.fillStyle = T.dim;
  roundRect(c, side + 252, 13, 92, 8, 4);
  roundRect(c, side + 372, 13, 64, 8, 4);
  for (let i = 0; i < 3; i++) {
    c.fillStyle = ["#5d2a22", "#5a4a26", "#2f4a34"][i];
    c.beginPath();
    c.arc(18 + i * 18, top / 2, 5, 0, Math.PI * 2);
    c.fill();
  }

  // file tree
  c.fillStyle = T.side;
  c.fillRect(0, top, side, H - top - status);
  const tree = [[0, 62], [1, 78], [1, 54], [2, 70], [2, 88], [2, 46], [1, 66], [0, 50], [1, 84], [1, 58], [1, 72], [0, 44], [0, 68]];
  tree.forEach(([ind, len], i) => {
    const y = top + 18 + i * 21;
    if (i === 4) {
      c.fillStyle = "#1c1e27";
      c.fillRect(0, y - 6, side, 20);
    }
    c.fillStyle = ind === 0 ? "#3d4258" : i === 4 ? "#8a90ad" : "#32364a";
    roundRect(c, 14 + ind * 12, y, len, 7, 3.5);
  });

  // code: [indent, [type, chars]...]; null = blank line
  const code = [
    "title",
    null,
    [0, ["k", 6], ["p", 5], ["k", 2], ["p", 2]],
    [0, ["k", 6], ["p", 8], ["k", 2], ["p", 2]],
    [0, ["k", 4], ["p", 11], ["k", 6], ["t", 9]],
    null,
    [0, ["k", 3], ["f", 10], ["p", 1], ["p", 5], ["o", 1], ["t", 5], ["p", 2], ["o", 2], ["t", 5]],
    [1, ["s", 44]],
    [1, ["p", 1], ["o", 1], ["p", 1], ["o", 1], ["f", 5], ["p", 7], ["o", 1], ["n", 1]],
    [1, ["p", 1], ["o", 1], ["p", 1], ["o", 1], ["f", 3], ["p", 6], ["o", 1], ["n", 1]],
    [1, ["p", 1], ["o", 1], ["p", 1], ["o", 1], ["p", 1], ["o", 1], ["f", 5], ["p", 4], ["o", 1], ["p", 1], ["o", 1], ["n", 1]],
    [1, ["k", 6], ["f", 6], ["p", 9]],
    null,
    [0, ["k", 3], ["f", 8], ["p", 1], ["p", 6], ["o", 1], ["n", 2], ["p", 5], ["o", 1], ["n", 4]],
    [1, ["p", 6], ["o", 1], ["f", 7], ["p", 5], ["n", 1]],
    [1, ["k", 3], ["p", 4], ["k", 2], ["f", 5], ["p", 5]],
    [2, ["p", 4], ["o", 1], ["f", 9], ["p", 11]],
    [2, ["k", 2], ["p", 4], ["o", 1], ["p", 3]],
    [3, ["p", 6], ["o", 1], ["p", 4], ["p", 5]],
    [3, ["c", 30]],
    [2, ["k", 4]],
    [3, ["k", 5]],
    [1, ["k", 6], ["p", 6], ["p", 5]],
    null,
    [0, ["k", 2], ["p", 8], ["o", 2], ["s", 10]],
    [1, ["f", 5], ["p", 1], ["f", 8], ["p", 1], ["f", 10], ["p", 3]],
  ];
  const x0 = side + gutter + 14, y0 = top + 12, cursorLine = 16;
  c.fillStyle = T.line;
  c.fillRect(side, y0 + cursorLine * lh, W - side, lh);
  c.font = `13px ${MONO}`;
  c.textAlign = "right";
  for (let i = 0; i < code.length; i++) {
    const ym = y0 + i * lh + lh / 2;
    c.fillStyle = i === cursorLine ? "#9aa0bd" : T.gutter;
    c.fillText(String(i + 1), side + gutter, ym + 1);
  }
  c.textAlign = "left";
  const mini = [];
  code.forEach((row, i) => {
    const ym = y0 + i * lh + lh / 2;
    if (row === "title") {
      c.font = `italic 15px ${MONO}`;
      c.fillStyle = "#8b93b8";
      const text = `# ${title || "rhizoMorphic"}`;
      c.fillText(fit(c, text, W - x0 - 110), x0, ym + 1);
      mini.push([[0, Math.min(text.length, 60), "c"]]);
      return;
    }
    if (!row) return void mini.push(null);
    let x = x0 + row[0] * 4 * cw;
    const m = [];
    for (let j = 1; j < row.length; j++) {
      const [type, chars] = row[j];
      const len = Math.max(1, chars + (chars > 3 ? rng.int(-1, 1) : 0));
      c.fillStyle = T[type];
      c.globalAlpha = type === "c" || type === "s" ? 0.8 : 0.92;
      roundRect(c, x, ym - 4.5, len * cw - 3, 9, 4.5);
      m.push([(x - x0) / cw, len, type]);
      x += len * cw + cw * 0.9;
    }
    c.globalAlpha = 1;
    if (i === cursorLine) {
      c.fillStyle = "#e8e4d8";
      c.fillRect(x - cw * 0.5, ym - 8, 2, 16);
    }
    mini.push(m);
  });
  // indent guides
  c.fillStyle = "rgba(120,128,165,0.12)";
  code.forEach((row, i) => {
    if (!row || row === "title") return;
    for (let k = 1; k <= row[0] - 1 + 1 && k < 4; k++) if (k <= row[0]) c.fillRect(x0 + (k - 1) * 4 * cw + 1, y0 + i * lh, 1, lh);
  });

  // minimap
  const mx = W - 84;
  c.fillStyle = "#12131a";
  c.fillRect(mx - 8, top, 92, H - top - status);
  c.fillStyle = "rgba(140,150,190,0.08)";
  c.fillRect(mx - 8, top, 92, 118);
  mini.forEach((row, i) => {
    if (!row) return;
    for (const [col, len, type] of row) {
      c.fillStyle = T[type];
      c.globalAlpha = 0.55;
      c.fillRect(mx + col * 1.1, top + 8 + i * 4, Math.max(2, len * 1.1 - 1), 2);
    }
  });
  c.globalAlpha = 1;

  // status bar
  c.fillStyle = "#6e2a1f";
  c.fillRect(0, H - status, W, status);
  c.fillStyle = "rgba(255,236,220,0.6)";
  roundRect(c, 14, H - status + 8, 70, 6, 3);
  roundRect(c, 100, H - status + 8, 38, 6, 3);
  roundRect(c, W - 210, H - status + 8, 54, 6, 3);
  roundRect(c, W - 140, H - status + 8, 30, 6, 3);
  roundRect(c, W - 94, H - status + 8, 70, 6, 3);
}

function fit(c, text, max) {
  let s = String(text ?? "");
  if (c.measureText(s).width <= max) return s;
  while (s.length > 1 && c.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s.replace(/[\s,.;:–—-]+$/, "") + "…";
}

/** Red seven-segment height readout plus the up / down / memory buttons. */
function drawKeypad(c, W, H, readout) {
  c.fillStyle = "#0a0a0b";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#050505";
  roundRect(c, 10, 8, 124, H - 16, 6);
  const SEG = { 0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
  const dw = 22, dh = H - 34, t = 4.5;
  const seg = (x, y, on) => {
    const bars = {
      a: [x + t, y, dw - 2 * t, t], g: [x + t, y + dh / 2 - t / 2, dw - 2 * t, t], d: [x + t, y + dh - t, dw - 2 * t, t],
      f: [x, y + t * 0.6, t, dh / 2 - t * 0.9], b: [x + dw - t, y + t * 0.6, t, dh / 2 - t * 0.9],
      e: [x, y + dh / 2 + t * 0.3, t, dh / 2 - t * 0.9], c: [x + dw - t, y + dh / 2 + t * 0.3, t, dh / 2 - t * 0.9],
    };
    for (const k of on) roundRect(c, ...bars[k], 2);
  };
  c.save();
  c.transform(1, 0, -0.09, 1, 6, 0);
  const digits = String(readout ?? "").replace(/[^0-9]/g, "").slice(0, 3).padStart(3, " ");
  for (let i = 0; i < 3; i++) {
    const x = 26 + i * 33;
    c.fillStyle = "rgba(255,60,40,0.09)";
    seg(x, 17, SEG[8]);
    if (digits[i] === " ") continue;
    c.shadowColor = "#ff3a26";
    c.shadowBlur = 7;
    c.fillStyle = "#ff5238";
    seg(x, 17, SEG[digits[i]]);
    c.shadowBlur = 0;
  }
  c.restore();
  c.fillStyle = "#6d7074";
  const tri = (x, up) => {
    c.beginPath();
    c.moveTo(x - 9, H / 2 + (up ? 6 : -6));
    c.lineTo(x + 9, H / 2 + (up ? 6 : -6));
    c.lineTo(x, H / 2 + (up ? -7 : 7));
    c.closePath();
    c.fill();
  };
  tri(166, true);
  tri(202, false);
  c.fillStyle = "#3f4245";
  for (let i = 0; i < 3; i++) {
    c.beginPath();
    c.arc(244 + i * 26, H / 2, 6, 0, Math.PI * 2);
    c.fill();
  }
}

/** A run-on feed excerpt back into verse: break after sentence ends and before capitalised words. */
function verse(summary, max) {
  const words = String(summary || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const cap = /^["“‘'(]?[A-Z]/.test(w) && !/^I(['’].*)?[,.;:!?]?$/.test(w);
    if (cur.length && (/[.!?]["”’']?$/.test(prev) || (cap && cur.length >= 2))) {
      lines.push(cur.join(" "));
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur.join(" "));
  return lines.slice(0, max);
}

function shortDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Both journal pages on one 1024 × 768 canvas: left page | right page (726 px tall), with a 42 px strip of
 * page-edge striation underneath for the sides of the page blocks.
 */
function drawJournal(textures, items, sourceLabel, rng) {
  const W = 1024, H = 768, PW = 512, PH = 726;
  const { canvas, ctx: c } = textures.makeCanvas(W, H);
  const ink = "#1b2a5c";
  const base = (seed, margin) => textures.ruledPaper({ width: PW, height: PH, margin, text: null, scribble: 0, rng: rng.fork(seed) });
  const left = base("left", false), right = base("right", true);
  c.save();
  c.translate(PW, 0);
  c.scale(-1, 1); // mirrored so the built-in gutter shade lands on the spine side
  c.drawImage(left.canvas, 0, 0);
  c.restore();
  c.drawImage(right.canvas, PW, 0);
  left.texture.dispose();
  right.texture.dispose();
  const lh = right.lineHeight;
  c.strokeStyle = "rgba(170,60,50,0.28)"; // the left page's margin rule
  c.lineWidth = 1;
  c.beginPath();
  c.moveTo(PW * 0.075 + 0.5, 0);
  c.lineTo(PW * 0.075 + 0.5, PH);
  c.stroke();

  const baseline = (i) => lh * (i + 2) - lh * 0.2;
  const hand = (px) => `italic ${Math.round(px)}px ${SERIF}`;
  const write = (text, x, line, { size = lh * 0.9, align = "left", alpha = 1, r = rng } = {}) => {
    c.save();
    c.font = hand(size);
    c.textAlign = align;
    c.textBaseline = "alphabetic";
    c.fillStyle = ink;
    c.translate(x + r.float(-1.5, 2.5), baseline(line) + r.float(-0.8, 0.8));
    c.rotate(r.float(-0.006, 0.006));
    c.globalAlpha = alpha * r.float(0.8, 0.96);
    c.fillText(text, 0, 0);
    c.restore();
  };
  const stroke = (x0, x1, y, r) => {
    c.save();
    c.strokeStyle = ink;
    c.globalAlpha = 0.7;
    c.lineWidth = 1.2;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x0, y + r.float(-1, 1));
    c.quadraticCurveTo((x0 + x1) / 2, y + r.float(-2.5, 2.5), x1, y + r.float(-1.5, 1.5));
    c.stroke();
    c.restore();
  };
  const scribble = (ox, firstLine, stanzas, r) => {
    const xl = ox + PW * 0.1, xr = ox + PW * 0.92;
    let line = firstLine;
    c.save();
    c.strokeStyle = ink;
    c.lineCap = c.lineJoin = "round";
    for (const count of stanzas) {
      for (let i = 0; i < count && line < 32; i++, line++) {
        const y = baseline(line);
        const end = xl + (xr - xl) * r.float(0.4, 0.95);
        let x = xl + r.float(0, 6);
        while (x < end) {
          const word = r.float(14, 52);
          c.globalAlpha = r.float(0.55, 0.88);
          c.lineWidth = r.float(1, 1.5);
          c.beginPath();
          c.moveTo(x, y - r.float(0, lh * 0.3));
          for (let px = x; px < Math.min(x + word, end); px += lh * 0.2) {
            c.lineTo(px + r.float(-1, 1), y - r.float(0, lh * (r.chance(0.16) ? 0.72 : 0.4)));
          }
          c.stroke();
          x += word + r.float(7, 14);
        }
      }
      line++;
    }
    c.restore();
  };
  /** Write `text` wrapped to the page; returns the next free line. */
  const paragraph = (text, ox, line, r, lastLine = 31) => {
    const xl = ox + PW * 0.1, max = PW * 0.84;
    c.font = hand(lh * 0.9);
    let cur = "", first = true;
    const flush = () => {
      if (!cur || line > lastLine) return;
      write(cur, xl + (first ? 0 : lh * 1.2), line++, { r });
      first = false;
      cur = "";
    };
    for (const w of text.split(" ")) {
      const next = cur ? `${cur} ${w}` : w;
      c.font = hand(lh * 0.9);
      if (cur && c.measureText(next).width > max - (first ? 0 : lh * 1.2)) flush();
      cur = cur ? `${cur} ${w}` : w;
    }
    flush();
    return line;
  };

  // right page: the latest poem
  const poem = items[0];
  const rr = rng.fork("right-ink");
  if (poem && poem.title) {
    const xl = PW + PW * 0.1;
    const date = shortDate(poem.date);
    if (date) write(date, PW + PW * 0.93, 1, { size: lh * 0.72, align: "right", alpha: 0.8, r: rr });
    c.font = hand(lh * 1.45);
    const title = fit(c, poem.title, PW * 0.8);
    const tw = c.measureText(title).width;
    write(title, xl, 3, { size: lh * 1.45, r: rr });
    stroke(xl - 2, xl + tw + 10, baseline(3) + lh * 0.3, rr);
    let line = 5;
    const lines = verse(poem.summary, 9);
    for (const text of lines) {
      if (line > 30) break;
      line = paragraph(text, PW, line, rr);
    }
    if (!lines.length) scribble(PW, 5, [4, 5, 3], rr);
  } else {
    scribble(PW, 2, [5, 4, 6, 3], rr);
  }

  // left page: the poems before it, as a running list in the same hand
  const rl = rng.fork("left-ink");
  const earlier = items.slice(1, 12).filter((it) => it && it.title);
  if (earlier.length) {
    const xl = PW * 0.12, xr = PW * 0.9;
    if (sourceLabel) {
      c.font = hand(lh * 1.15);
      const head = fit(c, sourceLabel, PW * 0.7);
      write(head, xl, 2, { size: lh * 1.15, r: rl });
      stroke(xl - 2, xl + c.measureText(head).width + 8, baseline(2) + lh * 0.3, rl);
    }
    earlier.forEach((it, i) => {
      const line = 4 + i * 2;
      if (line > 30) return;
      const date = shortDate(it.date).replace(/ \d{4}$/, "");
      c.font = hand(lh * 0.9);
      write(fit(c, it.title, xr - xl - 86), xl, line, { r: rl });
      if (date) write(date, xr, line, { size: lh * 0.76, align: "right", alpha: 0.75, r: rl });
    });
  } else {
    scribble(0, 2, [4, 6, 5, 4, 3], rl);
  }

  // shading: the gutter valley and a faint warm falloff toward the outer edges
  const g = c.createLinearGradient(PW - 70, 0, PW + 70, 0);
  g.addColorStop(0, "rgba(52,36,18,0)");
  g.addColorStop(0.42, "rgba(52,36,18,0.16)");
  g.addColorStop(0.5, "rgba(40,26,12,0.5)");
  g.addColorStop(0.58, "rgba(52,36,18,0.16)");
  g.addColorStop(1, "rgba(52,36,18,0)");
  c.fillStyle = g;
  c.fillRect(PW - 70, 0, 140, PH);
  for (const [xa, xb] of [[0, 26], [W, W - 26]]) {
    const e = c.createLinearGradient(xa, 0, xb, 0);
    e.addColorStop(0, "rgba(90,66,36,0.14)");
    e.addColorStop(1, "rgba(90,66,36,0)");
    c.fillStyle = e;
    c.fillRect(Math.min(xa, xb), 0, 26, PH);
  }

  // page-edge strip
  c.fillStyle = "#e6dfcb";
  c.fillRect(0, PH, W, H - PH);
  for (let y = PH; y < H; y += 2) {
    c.fillStyle = `rgba(96,78,50,${rng.float(0.05, 0.2).toFixed(3)})`;
    c.fillRect(0, y, W, 1);
  }
  return { canvas, texture: textures.toTexture(canvas, { srgb: true }), W, H, PW, PH };
}

// ---- parts ---------------------------------------------------------------------------------------------

function buildFrame(d) {
  const lx = d.frame.legX, under = d.topY - d.topThickness;
  const parts = [];
  for (const s of [-1, 1]) {
    const x = s * lx;
    parts.push(at(prism(0.06, 0.7, 0.05, 0.014, 0.004), x, 0, 0)); // foot
    parts.push(at(prism(0.06, 0.08, 0.6, 0.007, 0), x, 0.05, 0)); // lower column, y 0.05–0.65
    parts.push(at(prism(0.066, 0.086, 0.012, 0.009, 0.002), x, 0.642, 0)); // glide collar at the telescoping joint
    parts.push(at(prism(0.05, 0.07, under - 0.4, 0.006, 0), x, 0.4, 0)); // upper column, y 0.40–1.025
    parts.push(at(prism(0.09, 0.52, 0.006, 0.006, 0), x, under - 0.006, 0)); // mounting plate under the top
    parts.push(at(prism(0.03, 0.062, 0.052, 0.004, 0), s * (lx - 0.04), 0.924, 0)); // crossbar bracket
  }
  parts.push(at(prism(1.1, 0.05, 0.04, 0.004, 0.002), 0, 0.93, 0)); // crossbar, centre y 0.95
  const k = d.keypad.size;
  parts.push(at(prism(k[0], k[2], k[1], 0.005, 0.002), KEYPAD_X, under - k[1], d.depth / 2 - k[2] / 2 + KEYPAD_PROUD));
  return parts;
}

const KEYPAD_X = 0.5, KEYPAD_PROUD = 0.006;

function buildLaptop(d, ctx, mats) {
  const L = d.laptop;
  const [bw, bh, bd] = L.base, [lw, lh, lt] = L.lid;
  const group = new THREE.Group();
  group.name = "laptop";
  group.position.fromArray(L.local);
  group.rotation.y = (L.rotDeg || 0) * DEG;

  const alu = L.color, aluDark = "#a4a7ab";
  const metal = [paint(prism(bw, bd, bh, 0.012, 0.0016, 5), alu)];
  const dark = [];

  // keyboard well + keys
  const wellW = 0.28, wellD = 0.108, wellZ = -0.027;
  dark.push(paint(at(prism(wellW, wellD, 0.0012, 0.004, 0), 0, bh - 0.0008, wellZ), "#0f1012"));
  const rows = [
    Array(14).fill(14.5 / 14),
    [...Array(13).fill(1), 1.5],
    [1.5, ...Array(12).fill(1), 1],
    [1.75, ...Array(11).fill(1), 1.75],
    [2.25, ...Array(10).fill(1), 2.25],
    [1, 1, 1, 1.25, 5, 1.25, 1, 1, 1, 1],
  ];
  const gap = 0.0022, padX = 0.004, padZ = 0.004, unit = (wellW - 2 * padX) / 14.5;
  const fnD = 0.011, rowD = (wellD - 2 * padZ - fnD) / 5;
  let z = wellZ - wellD / 2 + padZ;
  rows.forEach((row, ri) => {
    const depth = ri === 0 ? fnD : rowD;
    let x = -wellW / 2 + padX;
    for (const u of row) {
      const w = u * unit;
      dark.push(paint(box(w - gap, 0.0016, depth - gap, x + w / 2, bh + 0.0003, z + depth / 2), "#1d1e21"));
      x += w;
    }
    z += depth;
  });
  // trackpad
  metal.push(paint(at(prism(0.108, 0.066, 0.0012, 0.004, 0), 0, bh - 0.0007, 0.07), aluDark));

  // lid: built upright with the display on +z and the hinge line along x at y = 0, then leaned back
  const lean = new THREE.Matrix4().makeRotationX(-(L.openDeg - 90) * DEG);
  lean.setPosition(0, bh + 0.0016, -bd / 2 + 0.0072);
  const lidShell = paint(at(plate(lw, lh, lt, 0.012, 0.0014, 5), 0, lh / 2, -lt), alu).applyMatrix4(lean);
  metal.push(lidShell);
  const glass = paint(flat(new THREE.PlaneGeometry(lw - 0.005, lh - 0.005)).translate(0, lh / 2, 0.0003), "#08080a").applyMatrix4(lean);
  dark.push(glass);
  dark.push(paint(rod(-0.125, 0.125, 0.0034, 0.0034, 10).translate(0, bh + 0.0006, -bd / 2 + 0.0062), "#141517"));

  const sw = lw - 0.02, sh = (sw * L.canvas[1]) / L.canvas[0];
  const scr = ctx.textures.screen(L.canvas[0], L.canvas[1]);
  const latest = ctx.content?.zones?.laptop?.items?.[0];
  drawEditor(scr.ctx, L.canvas[0], L.canvas[1], latest?.title || "", ctx.rng.fork("editor"));
  scr.texture.needsUpdate = true;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(sw, sh).translate(0, lh / 2, 0.0008).applyMatrix4(lean),
    new THREE.MeshBasicMaterial({ map: scr.texture, toneMapped: false }),
  );
  screen.name = "laptopScreen";

  group.add(mesh("laptopShell", metal, mats.metal), mesh("laptopDark", dark, mats.dark), screen);
  return group;
}

function buildJournal(d, ctx, mats) {
  const J = d.journal, P = d.pen;
  const [pw, pt, pd] = J.page;
  const group = new THREE.Group();
  group.name = "journal";
  group.position.fromArray(J.local);
  group.rotation.y = J.rotDeg * DEG;

  const coverT = 0.002, over = 0.004;
  // Covers lie flat on the desk; the page blocks dip into the gutter (the spec's ~3° V) and flatten out
  // toward the fore-edge, so nothing lifts off the desk.
  const yOuter = coverT + pt + 0.0015, yGutter = yOuter - pw * Math.tan(J.vDeg * DEG);
  const pageY = (s) => yGutter + (yOuter - yGutter) * (1 - (1 - Math.min(Math.abs(s), pw) / pw) ** 3);
  const slope = (s) => ((yOuter - yGutter) * 3 * (1 - s / pw) ** 2) / pw;

  const zone = ctx.content?.zones?.journal;
  const items = Array.isArray(zone?.items) ? zone.items : [];
  const atlas = drawJournal(ctx.textures, items, items[0]?.sourceLabel || zone?.links?.[0]?.label || "", ctx.rng.fork("journal"));
  const pagesMat = new THREE.MeshStandardMaterial({ map: atlas.texture, roughness: 0.93, metalness: 0 });

  const qb = quadBuilder();
  const N = 12, z0 = -pd / 2, z1 = pd / 2;
  const u = (x) => (atlas.PW + (x / pw) * atlas.PW) / atlas.W;
  const v = (z) => 1 - (((z - z0) / pd) * atlas.PH) / atlas.H;
  const ve = (y) => 1 - (atlas.PH + 4 + ((yOuter - y) / (yOuter - coverT)) * (atlas.H - atlas.PH - 8)) / atlas.H; // edge strip
  for (const s of [-1, 1]) {
    for (let i = 0; i < N; i++) {
      const sa = (i / N) * pw, sb = ((i + 1) / N) * pw;
      const xa = s * sa, xb = s * sb, ya = pageY(sa), yb = pageY(sb);
      const na = new THREE.Vector3(-s * slope(sa), 1, 0).normalize().toArray();
      const nb = new THREE.Vector3(-s * slope(sb), 1, 0).normalize().toArray();
      qb.quad([[xa, ya, z0], [xb, yb, z0], [xb, yb, z1], [xa, ya, z1]], [na, nb, nb, na], [[u(xa), v(z0)], [u(xb), v(z0)], [u(xb), v(z1)], [u(xa), v(z1)]]);
      for (const [z, nz] of [[z0, -1], [z1, 1]]) {
        const ua = 0.1 + (sa / pw) * 0.8, ub = 0.1 + (sb / pw) * 0.8;
        qb.quad([[xa, coverT, z], [xb, coverT, z], [xb, yb, z], [xa, ya, z]], [0, 0, nz], [[ua, ve(coverT)], [ub, ve(coverT)], [ub, ve(yb)], [ua, ve(ya)]]);
      }
    }
    const x = s * pw;
    qb.quad([[x, coverT, z0], [x, coverT, z1], [x, yOuter, z1], [x, yOuter, z0]], [s, 0, 0], [[0.05, ve(coverT)], [0.95, ve(coverT)], [0.95, ve(yOuter)], [0.05, ve(yOuter)]]);
  }
  const pages = new THREE.Mesh(qb.geometry(), pagesMat);
  pages.name = "journalPages";
  pages.receiveShadow = true;

  // cover (one cloth board, spine in the middle)
  const matte = [paint(prism(2 * (pw + over), pd + 2 * over, coverT, 0.005, 0.0005), J.cover)];

  // ribbon: down the gutter, over the bottom edge, onto the desk
  const rb = quadBuilder();
  const hw = 0.003;
  const path = [];
  for (let i = 0; i <= 8; i++) {
    const z = -pd / 2 + 0.004 + (i / 8) * (pd - 0.0045);
    const x = 0.0035 + (i / 8) ** 2 * 0.006;
    path.push([x, null, z]);
  }
  path.push([0.0098, pageY(0.0098) * 0.72, z1 + 0.0012], [0.0104, coverT + 0.0011, z1 + 0.0032], [0.011, coverT + 0.0005, z1 + over - 0.0006]);
  path.push([0.0116, 0.0012, z1 + over + 0.0012], [0.0124, 0.0005, z1 + over + 0.004]);
  for (let i = 1; i <= 5; i++) path.push([0.0124 + (i / 5) ** 1.6 * 0.016, 0.0005, z1 + over + 0.004 + i * 0.0085]);
  const edge = (p, side) => {
    const x = p[0] + side * hw;
    return [x, p[1] == null ? pageY(x) + 0.0005 : p[1], p[2]];
  };
  for (let i = 0; i < path.length - 1; i++) {
    const a0 = edge(path[i], -1), a1 = edge(path[i], 1), b0 = edge(path[i + 1], -1), b1 = edge(path[i + 1], 1);
    const n = new THREE.Vector3(b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]).cross(new THREE.Vector3(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2])).normalize();
    if (n.y < 0) n.negate();
    rb.quad([a0, a1, b1, b0], n.toArray(), [[0, 0], [1, 0], [1, 1], [0, 1]]);
  }
  matte.push(paint(rb.geometry(), "#9c2a22"));

  // pen across the right page, resting on the paper
  const A = new THREE.Vector3(0.05, 0, 0.062), B = new THREE.Vector3(0.135, 0, -0.049);
  B.sub(A).setLength(P.length).add(A);
  const r = P.radius;
  A.y = pageY(A.x) + r;
  B.y = pageY(B.x) + r;
  let sag = 0;
  for (let i = 1; i < 12; i++) {
    const t = i / 12, x = A.x + (B.x - A.x) * t;
    sag = Math.max(sag, pageY(x) + r - (A.y + (B.y - A.y) * t));
  }
  A.y += sag + 0.0002;
  B.y += sag + 0.0002;
  const ax = B.clone().sub(A).normalize();
  const az = new THREE.Vector3().crossVectors(ax, new THREE.Vector3(0, 1, 0)).normalize();
  const ay = new THREE.Vector3().crossVectors(az, ax);
  const roll = new THREE.Matrix4().makeRotationX(-38 * DEG); // clip rolled a little to one side
  const place = new THREE.Matrix4().makeBasis(ax, ay, az).setPosition(A).multiply(roll);
  const len = P.length, black = "#141416", steel = "#c9ccd0";
  matte.push(
    paint(rod(0.014, 0.032, r * 0.74, r, 14), black).applyMatrix4(place),
    paint(rod(0.032, len - 0.004, r, r, 14), black).applyMatrix4(place),
    paint(rod(len - 0.004, len, r, r * 0.7, 14), black).applyMatrix4(place),
  );
  const steelParts = [
    paint(rod(0, 0.014, r * 0.16, r * 0.74, 12), steel).applyMatrix4(place),
    paint(rod(0.094, 0.097, r * 1.06, r * 1.06, 14), steel).applyMatrix4(place),
    paint(box(0.038, 0.0011, 0.0024, len - 0.027, r + 0.0012, 0), steel).applyMatrix4(place),
    paint(box(0.0045, 0.0022, 0.0024, len - 0.0095, r + 0.0006, 0), steel).applyMatrix4(place),
  ];

  group.add(pages, mesh("journalCover", matte, mats.matte), mesh("penMetal", steelParts, mats.metal));
  return group;
}

/** A handle-less stoneware tea cup (yunomi) with green tea, standing in for the mug. */
function buildCup(d, mats) {
  const prof = [
    [0, 0.003], [0.019, 0.003], [0.021, 0], [0.0245, 0], [0.026, 0.004], [0.0305, 0.013], [0.0348, 0.03], [0.0368, 0.052],
    [0.0374, 0.07], [0.0372, 0.0745], [0.0362, 0.0756], [0.0352, 0.0745], [0.0349, 0.07], [0.0344, 0.052], [0.0322, 0.03],
    [0.027, 0.015], [0.016, 0.0105], [0, 0.0098],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const SEG = 28;
  const lathe = new THREE.LatheGeometry(prof, SEG);
  const glaze = new THREE.Color("#d8d0bd"), clay = new THREE.Color("#7d5b45"), rim = new THREE.Color("#b9ab8e");
  const col = new Float32Array(lathe.attributes.position.count * 3);
  for (let i = 0; i <= SEG; i++) {
    for (let j = 0; j < prof.length; j++) {
      const c = j <= 4 ? clay : j >= 9 && j <= 11 ? rim : glaze;
      c.toArray(col, (i * prof.length + j) * 3);
    }
  }
  lathe.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const tea = paint(flat(new THREE.CircleGeometry(0.0346, SEG)).rotateX(-Math.PI / 2).translate(0, 0.056, 0), "#6f7a2e");
  const cup = mesh("mug", [flat(lathe), tea], mats.ceramic);
  cup.position.fromArray(d.mug.local);
  return cup;
}

// ---- stream-software screen (main monitor) -------------------------------------------------------------

const CHAT = [
  ["nodewalker", "good evening chat"],
  ["eigen_ish", "is Q normalised by 2m here?"],
  ["late.tea", "first time catching this live"],
  ["k_core", "the resolution-limit part was great"],
  ["lambda2", "louvain or leiden next?"],
  ["sparse_mat", "can you share the notebook after"],
  ["frogtopology", "that derivation finally clicked"],
  ["night_shift", "o/ from the night shift"],
  ["eigen_ish", "what was the null model again"],
  ["walnut", "the slide typography is lovely"],
  ["k_core", "how big was the test graph"],
  ["lambda2", "spectral clustering crossover when"],
  ["late.tea", "rewatching the laplacian one now"],
  ["nodewalker", "Q around 0.42 is pretty solid"],
  ["frogtopology", "chat is very calm tonight"],
  ["sparse_mat", "thanks for doing these"],
];
const CHAT_NAME_COLORS = ["#c98f6b", "#8fb3a5", "#c9a96a", "#9aa6cf", "#b893b0", "#a9b98a"];

/** Wrap `text` to at most `maxLines` lines of `maxW` px in the ctx's current font (last line ellipsised). */
function wrapLines(c, text, maxW, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (cur && c.measureText(next).width > maxW) {
      if (lines.length === maxLines - 1) {
        lines.push(fit(c, [cur, ...words.slice(i)].join(" "), maxW));
        return lines;
      }
      lines.push(cur);
      cur = words[i];
    } else cur = next;
  }
  if (cur) lines.push(fit(c, cur, maxW));
  return lines;
}

/**
 * Streaming-software scene on a W × H canvas. Static chrome is drawn once into an offscreen base; tick(t)
 * copies the base and draws the live bits (viewer count, uptime, REC dot, chat scroll, audio meters).
 * tick() allocates nothing: every string, font and gradient is prepared here.
 */
function createStreamScreen(spec, ctx, latest) {
  const [W, H] = spec.canvas;
  const scr = ctx.textures.screen(W, H, { mipmaps: true });
  const c = scr.ctx;
  const { canvas: baseCanvas, ctx: b } = ctx.textures.makeCanvas(W, H);
  const rng = ctx.rng.fork("stream");
  const C = {
    bg: "#0d0e12", bar: "#08090b", panel: "#14151b", raised: "#1c1d24", edge: "#24262f",
    text: "#c8cbd6", dim: "#6c7184", faint: "#353845", live: "#b4372b", accent: "#8f3a2b", warm: "#ece6dc",
  };
  const TOP = 40;
  const P = { x: 12, y: 52, w: 672, h: 378 }; // preview, 16:9
  const CH = { x: 696, y: 52, w: 316, h: 378 }; // chat column
  const BY = 442, BH = 122; // bottom dock
  const F = {
    pill: `700 13px ${SANS}`, ui: `500 14px ${SANS}`, small: `500 12px ${SANS}`, head: `600 12px ${SANS}`,
    mono: `500 15px ${MONO}`, chatName: `700 14px ${SANS}`, chatText: `400 14px ${SANS}`,
  };
  const label = (cx, s, x, y, font, color, align = "left") => {
    cx.font = font;
    cx.fillStyle = color;
    cx.textAlign = align;
    cx.textBaseline = "middle";
    cx.fillText(s, x, y);
  };

  // ---- static base ----
  b.fillStyle = C.bg;
  b.fillRect(0, 0, W, H);
  b.fillStyle = C.bar;
  b.fillRect(0, 0, W, TOP);
  b.fillStyle = C.edge;
  b.fillRect(0, TOP, W, 1);

  // top bar: LIVE pill, viewers (dynamic), uptime (dynamic), title, REC (dynamic dot), stream stats
  b.fillStyle = C.live;
  roundRect(b, 12, 9, 58, 22, 5);
  label(b, "LIVE", 41, 20.5, F.pill, "#fbeee8", "center");
  b.strokeStyle = C.dim;
  b.lineWidth = 1.6;
  b.beginPath();
  b.ellipse(92, 20.5, 9, 5.5, 0, 0, Math.PI * 2);
  b.stroke();
  b.fillStyle = C.dim;
  b.beginPath();
  b.arc(92, 20.5, 2.4, 0, Math.PI * 2);
  b.fill();
  b.beginPath();
  b.arc(222, 20.5, 7.5, 0, Math.PI * 2);
  b.moveTo(222, 15.5);
  b.lineTo(222, 20.5);
  b.lineTo(226, 22.5);
  b.stroke();
  const postTitle = latest?.title ? String(latest.title) : "";
  b.font = F.ui;
  label(b, fit(b, postTitle ? `late-night notes · ${postTitle}` : "late-night notes · rhizoMorphic", 360), 512, 20.5, F.ui, C.dim, "center");
  label(b, "REC", W - 196, 20.5, F.pill, C.text);
  label(b, "1080p · 60 fps · 6.0 Mb/s", W - 14, 20.5, F.small, C.dim, "right");

  // preview: the "now showing" slide
  b.save();
  b.beginPath();
  b.rect(P.x, P.y, P.w, P.h);
  b.clip();
  const sg = b.createLinearGradient(0, P.y, 0, P.y + P.h);
  sg.addColorStop(0, "#1c1d23");
  sg.addColorStop(1, "#111216");
  b.fillStyle = sg;
  b.fillRect(P.x, P.y, P.w, P.h);
  // a small community graph on the right half (ties to the post topic without depending on it)
  const comm = ["#6fa3a0", "#c9a15e", "#c4705a"];
  const gx0 = P.x + P.w * 0.56, gx1 = P.x + P.w * 0.96, gy0 = P.y + P.h * 0.1, gy1 = P.y + P.h * 0.62;
  const centres = [[0.25, 0.3], [0.75, 0.25], [0.5, 0.78]].map(([u, v]) => [gx0 + u * (gx1 - gx0), gy0 + v * (gy1 - gy0)]);
  const nodes = [];
  centres.forEach(([cx, cy], k) => {
    for (let i = 0; i < 8; i++) {
      const a = rng.float(0, Math.PI * 2), r = rng.float(8, 46);
      nodes.push({ x: cx + Math.cos(a) * r * 1.2, y: cy + Math.sin(a) * r * 0.8, k, s: rng.float(3.5, 6.5) });
    }
  });
  b.lineWidth = 1.2;
  nodes.forEach((n, i) => {
    const near = nodes
      .map((m, j) => [j, (m.x - n.x) ** 2 + (m.y - n.y) ** 2])
      .filter(([j]) => j !== i && nodes[j].k === n.k)
      .sort((p, q) => p[1] - q[1])
      .slice(0, 2);
    for (const [j] of near) {
      b.strokeStyle = "rgba(205,200,190,0.22)";
      b.beginPath();
      b.moveTo(n.x, n.y);
      b.lineTo(nodes[j].x, nodes[j].y);
      b.stroke();
    }
  });
  b.setLineDash([4, 4]);
  b.strokeStyle = "rgba(205,200,190,0.18)";
  for (const [i, j] of [[2, 9], [12, 19], [5, 22]]) {
    b.beginPath();
    b.moveTo(nodes[i].x, nodes[i].y);
    b.lineTo(nodes[j].x, nodes[j].y);
    b.stroke();
  }
  b.setLineDash([]);
  for (const n of nodes) {
    b.fillStyle = comm[n.k];
    b.beginPath();
    b.arc(n.x, n.y, n.s, 0, Math.PI * 2);
    b.fill();
  }
  // text block
  const tx = P.x + 36, tw = P.w * 0.5 - 30;
  label(b, "NOW SHOWING", tx, P.y + 52, `700 13px ${SANS}`, "#c46a52");
  b.fillStyle = "#c46a52";
  b.fillRect(tx, P.y + 66, 28, 2);
  b.font = `700 40px ${SANS}`;
  const lines = wrapLines(b, postTitle || "rhizoMorphic", tw, 3);
  lines.forEach((s, i) => label(b, s, tx, P.y + 112 + i * 46, `700 40px ${SANS}`, C.warm));
  const date = latest?.date ? shortDate(latest.date) : "";
  const by = P.y + 112 + lines.length * 46 + 4;
  label(b, postTitle ? (date ? `rhizoMorphic · ${date}` : "rhizoMorphic") : "notes from the workbench", tx, by, `500 17px ${SANS}`, "#8b90a3");
  label(b, "01 / 14", tx, P.y + P.h - 24, F.small, C.faint);
  // facecam, bottom right
  const fw = 160, fh = 100, fx = P.x + P.w - fw - 14, fy = P.y + P.h - fh - 14;
  b.save();
  b.beginPath();
  b.roundRect ? b.roundRect(fx, fy, fw, fh, 6) : b.rect(fx, fy, fw, fh);
  b.clip();
  const fg = b.createLinearGradient(fx, fy, fx + fw, fy + fh);
  fg.addColorStop(0, "#4b392c");
  fg.addColorStop(1, "#1f1815");
  b.fillStyle = fg;
  b.fillRect(fx, fy, fw, fh);
  const kl = b.createRadialGradient(fx + 22, fy + 16, 2, fx + 22, fy + 16, 60);
  kl.addColorStop(0, "rgba(240,215,180,0.35)");
  kl.addColorStop(1, "rgba(240,215,180,0)");
  b.fillStyle = kl;
  b.fillRect(fx, fy, fw, fh);
  b.fillStyle = "#130f0d";
  b.beginPath();
  b.ellipse(fx + fw * 0.52, fy + fh + 6, 52, 34, 0, 0, Math.PI * 2);
  b.fill();
  b.beginPath();
  b.ellipse(fx + fw * 0.52, fy + fh * 0.5, 17, 21, 0, 0, Math.PI * 2);
  b.fill();
  b.strokeStyle = "rgba(225,180,140,0.35)";
  b.lineWidth = 2;
  b.beginPath();
  b.ellipse(fx + fw * 0.52, fy + fh * 0.5, 17, 21, 0, Math.PI * 0.75, Math.PI * 1.35);
  b.stroke();
  b.restore();
  b.strokeStyle = "rgba(255,255,255,0.14)";
  b.lineWidth = 1;
  b.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
  b.restore();
  b.strokeStyle = C.edge;
  b.strokeRect(P.x - 0.5, P.y - 0.5, P.w + 1, P.h + 1);

  // chat column chrome
  b.fillStyle = C.panel;
  roundRect(b, CH.x, CH.y, CH.w, CH.h, 6);
  label(b, "Live chat", CH.x + 14, CH.y + 18, `600 14px ${SANS}`, C.text);
  label(b, "128 messages", CH.x + CH.w - 14, CH.y + 18, F.small, C.faint, "right");
  b.fillStyle = C.edge;
  b.fillRect(CH.x, CH.y + 34, CH.w, 1);
  b.fillStyle = C.raised;
  roundRect(b, CH.x + 10, CH.y + CH.h - 34, CH.w - 20, 24, 5);
  label(b, "Send a message", CH.x + 22, CH.y + CH.h - 22, F.small, C.dim);

  // bottom dock: scenes, audio mixer, controls
  const dock = (x, w, title) => {
    b.fillStyle = C.panel;
    roundRect(b, x, BY, w, BH, 6);
    label(b, title, x + 12, BY + 16, F.head, C.dim);
  };
  dock(12, 220, "Scenes");
  ["Slides", "Code", "Just chatting", "Be right back"].forEach((s, i) => {
    const y = BY + 30 + i * 22;
    if (i === 0) {
      b.fillStyle = "#252733";
      b.fillRect(18, y, 208, 20);
      b.fillStyle = C.accent;
      b.fillRect(18, y, 3, 20);
    }
    label(b, s, 30, y + 10.5, F.ui, i === 0 ? C.text : C.dim);
  });
  dock(244, 520, "Audio mixer");
  const MX = 340, MW = 404, MH = 9, rowsY = [BY + 42, BY + 68, BY + 94];
  ["Mic", "Desktop", "Music"].forEach((s, i) => {
    label(b, s, 258, rowsY[i] + 4.5, F.ui, C.text);
    b.fillStyle = "#22242c";
    b.fillRect(MX, rowsY[i], MW, MH);
    b.fillStyle = C.faint;
    for (let k = 0; k <= 10; k++) b.fillRect(MX + (k / 10) * MW - 0.5, rowsY[i] + MH + 2, 1, k % 5 ? 3 : 5);
  });
  dock(776, 236, "Controls");
  [["End stream", "#e07a68", C.live], ["Stop recording", C.text, null], ["Studio mode", C.dim, null]].forEach(([s, fgc, border], i) => {
    const y = BY + 28 + i * 30;
    b.fillStyle = C.raised;
    roundRect(b, 788, y, 212, 24, 5);
    if (border) {
      b.strokeStyle = border;
      b.lineWidth = 1.2;
      b.strokeRect(788.5, y + 0.5, 211, 23);
    }
    label(b, s, 894, y + 12.5, F.ui, fgc, "center");
  });

  // ---- prepared dynamic state ----
  const viewers = [];
  let v = rng.int(180, 260);
  for (let i = 0; i < 16; i++) {
    v = Math.max(120, v + rng.int(-9, 14));
    viewers.push(`${v} watching`);
  }
  const DIG = "0123456789".split("");
  c.font = F.mono;
  const cw = c.measureText("0").width;
  const LH = 26, chatTop = CH.y + 40, chatBottom = CH.y + CH.h - 44;
  const chat = CHAT.map(([name, text], i) => {
    c.font = F.chatName;
    const nameW = c.measureText(`${name}  `).width;
    c.font = F.chatText;
    return { name, nameW, color: CHAT_NAME_COLORS[(i * 7 + name.length) % CHAT_NAME_COLORS.length], text: fit(c, text, CH.w - 28 - nameW) };
  });
  const N = chat.length, visible = Math.ceil((chatBottom - chatTop) / LH) + 1;
  const meterGrad = c.createLinearGradient(MX, 0, MX + MW, 0);
  meterGrad.addColorStop(0, "#5f9a6c");
  meterGrad.addColorStop(0.68, "#7fa86a");
  meterGrad.addColorStop(0.82, "#cf9d4a");
  meterGrad.addColorStop(1, "#c2523f");
  const peaks = new Float32Array(3);
  const START = 4362; // 1:12:42 into the stream

  function tick(t) {
    c.drawImage(baseCanvas, 0, 0);
    c.textAlign = "left";
    c.textBaseline = "middle";
    // viewers
    c.font = F.ui;
    c.fillStyle = C.text;
    c.fillText(viewers[Math.floor(t / 7) % viewers.length], 108, 20.5);
    // uptime h:mm:ss, one cached glyph at a time
    const s = START + Math.floor(t);
    const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
    c.font = F.mono;
    c.fillStyle = C.text;
    let x = 236;
    c.fillText(DIG[hh % 10], x, 21);
    c.fillText(":", (x += cw), 21);
    c.fillText(DIG[Math.floor(mm / 10)], (x += cw), 21);
    c.fillText(DIG[mm % 10], (x += cw), 21);
    c.fillText(":", (x += cw), 21);
    c.fillText(DIG[Math.floor(ss / 10)], (x += cw), 21);
    c.fillText(DIG[ss % 10], (x += cw), 21);
    // REC dot, 1 Hz blink
    c.fillStyle = t % 1 < 0.6 ? "#d0473a" : "#3a1d1a";
    c.beginPath();
    c.arc(W - 208, 20.5, 5, 0, Math.PI * 2);
    c.fill();
    // chat: newest at the bottom, a new line every 2.6 s sliding up over 0.35 s
    const step = 2.6, k = Math.floor(t / step), ph = Math.min(1, (t - k * step) / 0.35);
    const slide = (1 - ph * ph * (3 - 2 * ph)) * LH;
    c.save();
    c.beginPath();
    c.rect(CH.x, chatTop, CH.w, chatBottom - chatTop);
    c.clip();
    for (let j = 0; j < visible; j++) {
      const m = chat[(((k - j) % N) + N) % N];
      const y = chatBottom - 12 - j * LH + slide;
      c.font = F.chatName;
      c.fillStyle = m.color;
      c.fillText(m.name, CH.x + 14, y);
      c.font = F.chatText;
      c.fillStyle = C.text;
      c.fillText(m.text, CH.x + 14 + m.nameW, y);
    }
    c.restore();
    // meters
    c.fillStyle = meterGrad;
    for (let i = 0; i < 3; i++) {
      let lvl;
      if (i === 0) lvl = 0.3 + 0.42 * Math.abs(Math.sin(t * 2.3)) * (0.65 + 0.35 * Math.sin(t * 7.9));
      else if (i === 1) lvl = 0.46 + 0.06 * Math.sin(t * 3.1 + 1) + 0.04 * Math.sin(t * 8.3);
      else lvl = 0.32 + 0.05 * Math.sin(t * 1.7 + 2) + 0.04 * Math.sin(t * 9.1);
      lvl = Math.min(0.97, Math.max(0.02, lvl));
      peaks[i] = Math.max(lvl, peaks[i] - 0.03);
      c.fillStyle = meterGrad;
      c.fillRect(MX, rowsY[i], MW * lvl, MH);
      c.fillStyle = "#d8d2c4";
      c.fillRect(MX + MW * peaks[i] - 1, rowsY[i], 2, MH);
    }
    scr.texture.needsUpdate = true;
  }
  tick(0);
  return { texture: scr.texture, tick };
}

/** 256 × 128 atlas for every glowing face: key-light diffuser, ON AIR sign, pad key tile, plain white. */
function drawGlowAtlas(textures, colors) {
  const W = 256, H = 128;
  const { canvas, ctx: c } = textures.makeCanvas(W, H);
  // key-light diffuser 0..128 × 0..128: warm, soft falloff to the edges
  const g = c.createRadialGradient(64, 64, 6, 64, 64, 92);
  g.addColorStop(0, colors.light);
  g.addColorStop(0.55, colors.light);
  g.addColorStop(1, "#8f8470");
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  c.fillStyle = "rgba(255,248,236,0.08)";
  for (let y = 4; y < 128; y += 8) for (let x = 4; x < 128; x += 8) c.fillRect(x, y, 2, 2);
  // ON AIR 128..256 × 0..64
  c.fillStyle = "#2a0f0c";
  c.fillRect(128, 0, 128, 64);
  c.font = `800 30px ${SANS}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.shadowColor = colors.onAir;
  c.shadowBlur = 8;
  c.fillStyle = colors.onAir;
  c.fillText("ON AIR", 192, 34);
  c.shadowBlur = 0;
  // pad key tile 128..192 × 64..128
  const k = c.createRadialGradient(160, 96, 4, 160, 96, 34);
  k.addColorStop(0, "#ffffff");
  k.addColorStop(0.7, "#d9d9d9");
  k.addColorStop(1, "#7a7a7a");
  c.fillStyle = k;
  c.fillRect(128, 64, 64, 64);
  c.strokeStyle = "rgba(0,0,0,0.35)";
  c.lineWidth = 4;
  c.strokeRect(132, 68, 56, 56);
  // white 192..256 × 64..128
  c.fillStyle = "#ffffff";
  c.fillRect(192, 64, 64, 64);
  const r = (x0, y0, x1, y1) => [(x0 + 3) / W, 1 - (y1 - 3) / H, (x1 - 3) / W, 1 - (y0 + 3) / H];
  return {
    texture: textures.toTexture(canvas, { srgb: true, mipmaps: true }),
    rects: { panel: r(0, 0, 128, 128), onAir: r(128, 0, 256, 64), key: r(128, 64, 192, 128), white: r(192, 64, 256, 128) },
  };
}

// ---- streaming rig -------------------------------------------------------------------------------------

function buildRig(d, ctx, mats, glowMat, rects) {
  const R = d.rig, TOP = d.topY, EDGE = -d.depth / 2, K = R.colors;
  const group = new THREE.Group();
  group.name = "streamRig";
  const gear = [], metal = [], glow = [], monitorParts = [];
  const lit = (g, color, rect = rects.white) => glow.push(uvRect(paint(g, color), rect));

  /** Clamp gripping the back edge at x: pad on the top, a plate wrapping the edge (7 mm), jaw + screw under. */
  const clamp = (x, w = 0.052) => {
    gear.push(paint(at(prism(w, 0.075, 0.008, 0.006, 0.0015), x, TOP, EDGE + 0.0375), K.gear));
    const yLo = TOP - d.topThickness - 0.038, yHi = TOP + 0.008;
    gear.push(paint(box(w, yHi - yLo, 0.007, x, (yHi + yLo) / 2, EDGE - 0.0035), K.gear));
    gear.push(paint(box(w, 0.008, 0.062, x, TOP - d.topThickness - 0.034, EDGE + 0.028), K.gear));
    gear.push(paint(tube([x, TOP - d.topThickness - 0.006, EDGE + 0.036], [x, TOP - d.topThickness, EDGE + 0.036], 0.013, 14), K.gear));
    metal.push(paint(tube([x, TOP - d.topThickness - 0.1, EDGE + 0.036], [x, TOP - d.topThickness - 0.006, EDGE + 0.036], 0.0045, 8), "#8d9095"));
    metal.push(paint(tube([x - 0.024, TOP - d.topThickness - 0.094, EDGE + 0.036], [x + 0.024, TOP - d.topThickness - 0.094, EDGE + 0.036], 0.0038, 8), "#8d9095"));
  };
  const poleZ = EDGE + 0.035;

  // ---- main monitor ----
  const MO = R.monitor;
  const [mw, mh] = MO.size;
  const M = new THREE.Matrix4().makeRotationX(-MO.tiltDeg * DEG).setPosition(MO.center[0], MO.center[1], MO.center[2]);
  const mon = (g, color) => monitorParts.push(paint(g, color).applyMatrix4(M));
  mon(at(plate(mw, mh, 0.009, 0.006, 0.0015), 0, 0, -0.009), "#0e0f12"); // panel, front face at z 0
  mon(at(plate(mw * 0.8, mh * 0.74, 0.024, 0.04, 0.007), 0, -0.012, -0.033), K.body); // rear housing
  mon(at(plate(0.11, 0.11, 0.006, 0.006, 0.001), 0, -0.01, -0.039), K.gear); // VESA plate
  const camY = mh / 2 + 0.0155;
  mon(at(plate(0.092, 0.029, 0.03, 0.0135, 0.003), 0, camY, -0.024), K.gear); // webcam body on the top edge
  mon(box(0.05, 0.004, 0.024, 0, mh / 2 + 0.002, -0.017), K.gear); // clip over the top
  mon(box(0.05, 0.036, 0.004, 0, mh / 2 - 0.014, -0.0115), K.gear); // clip down the back
  mon(ring(0.0088, 0.0016, 20).translate(0, camY, 0.0062), "#55585e"); // lens ring
  mon(flat(new THREE.CircleGeometry(0.0078, 20)).translate(0, camY, 0.0063), "#06070a"); // lens glass
  lit(box(0.0035, 0.0035, 0.001, 0.028, camY, 0.0062).applyMatrix4(M), "#93c79b"); // webcam activity LED
  lit(box(0.005, 0.0016, 0.001, mw / 2 - 0.03, -mh / 2 + 0.006, 0.0005).applyMatrix4(M), "#8a8273"); // power LED
  const chin = 0.0165, side = 0.006;
  const aw = mw - 2 * side, ah = mh - side - chin;
  const stream = createStreamScreen(MO, ctx, ctx.content?.zones?.laptop?.items?.[0]);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(aw, ah).translate(0, (chin - side) / 2, 0.0008).applyMatrix4(M),
    new THREE.MeshBasicMaterial({ map: stream.texture, toneMapped: false }),
  );
  screen.name = "monitorScreen";

  // ---- monitor arm on a back-edge pole, headphones on its hook ----
  const MA = R.monitorArm;
  const [px] = MA.pole;
  clamp(px);
  gear.push(paint(tube([px, TOP + 0.008, poleZ], [px, MA.top, poleZ], 0.016, 16), K.gear));
  gear.push(paint(tube([px, MA.top, poleZ], [px, MA.top + 0.008, poleZ], 0.017, 16, 0.012), K.gear));
  const S = new THREE.Vector3(px, MA.joint, poleZ);
  const E = new THREE.Vector3(MA.elbow[0], MA.joint, MA.elbow[1]);
  const V = new THREE.Vector3(0, -0.01, -0.039).applyMatrix4(M);
  const Hd = new THREE.Vector3(V.x, MA.joint, V.z - 0.035);
  gear.push(paint(tube([px, MA.joint - 0.026, poleZ], [px, MA.joint + 0.026, poleZ], 0.023, 16), K.gear));
  gear.push(paint(tube(S, E, 0.0135, 12), K.body));
  gear.push(paint(tube([E.x, MA.joint - 0.024, E.z], [E.x, MA.joint + 0.024, E.z], 0.02, 16), K.gear));
  gear.push(paint(tube(E, Hd, 0.0125, 12), K.body));
  gear.push(paint(tube([Hd.x, MA.joint - 0.022, Hd.z], [Hd.x, MA.joint + 0.022, Hd.z], 0.017, 16), K.gear));
  gear.push(paint(tube(Hd, V, 0.011, 12), K.gear));
  // hook
  const hy = R.headphones.hookY;
  gear.push(paint(tube([px, hy - 0.012, poleZ], [px, hy + 0.012, poleZ], 0.02, 16), K.gear));
  gear.push(paint(tube([px, hy, poleZ + 0.012], [px, hy + 0.006, poleZ + 0.052], 0.004, 8), K.gear));
  gear.push(paint(ball(0.006, [px, hy + 0.008, poleZ + 0.054]), K.gear));
  {
    // band in the XY plane, arc centre at o; the band's inner top rests on the hook
    const Rb = 0.088, o = [px, hy + 0.008 - (Rb - 0.006), poleZ + 0.034];
    const hp = [];
    hp.push([ring(Rb, 0.006, 36, Math.PI), K.gear]);
    hp.push([ring(Rb - 0.0065, 0.0085, 18, 0.42 * Math.PI).rotateZ(0.29 * Math.PI), K.soft]);
    const steel = [ring(Rb + 0.006, 0.0022, 36, Math.PI)];
    for (const s of [-1, 1]) {
      steel.push(tube([s * Rb, 0, 0], [s * Rb, -0.048, 0], 0.0032, 8));
      hp.push([tube([s * Rb, -0.046, 0], [s * Rb, -0.056, 0], 0.0065, 10), K.gear]);
      hp.push([tube([s * 0.064, -0.098, 0], [s * 0.098, -0.098, 0], 0.045, 28), K.body]);
      hp.push([ring(0.034, 0.0105, 24).rotateY(Math.PI / 2).translate(s * 0.058, -0.098, 0), K.soft]);
      hp.push([flat(new THREE.CircleGeometry(0.03, 20)).rotateY((s * Math.PI) / 2 + Math.PI).translate(s * 0.061, -0.098, 0), "#18181a"]);
      steel.push(ring(0.041, 0.0018, 28).rotateY(Math.PI / 2).translate(s * 0.0985, -0.098, 0));
    }
    for (const [g, col] of hp) gear.push(paint(g, col).translate(o[0], o[1], o[2]));
    for (const g of steel) metal.push(paint(g, "#6d7076").translate(o[0], o[1], o[2]));
  }

  // ---- broadcast mic on a boom arm ----
  const MI = R.mic;
  const [mx] = MI.pole;
  clamp(mx);
  gear.push(paint(tube([mx, TOP + 0.008, poleZ], [mx, MI.riserTop, poleZ], 0.013, 14), K.gear));
  gear.push(paint(tube([mx, MI.riserTop - 0.03, poleZ], [mx, MI.riserTop, poleZ], 0.018, 16), K.gear));
  const Mm = aimMatrix(MI.center, MI.aim);
  const micParts = [
    [tube([0, 0, -0.085], [0, 0, 0.032], 0.025, 24, 0.027), K.body],
    [ring(0.0285, 0.003, 28).translate(0, 0, -0.07), K.gear],
    [ring(0.0285, 0.003, 28).translate(0, 0, -0.002), K.gear],
    [ring(0.05, 0.0034, 32).translate(0, 0, -0.036), K.gear],
    [tube([0, 0.0535, -0.036], [0, 0.076, -0.036], 0.0045, 8), K.gear],
  ];
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a);
    micParts.push([tube([0.0285 * ca, 0.0285 * sa, -0.07], [0.05 * ca, 0.05 * sa, -0.036], 0.0015, 5), "#3b3c40"]);
    micParts.push([tube([0.0285 * ca, 0.0285 * sa, -0.002], [0.05 * ca, 0.05 * sa, -0.036], 0.0015, 5), "#3b3c40"]);
  }
  const foamProfile = [[0.0285, 0.03], [0.0322, 0.042], [0.0334, 0.07], [0.0326, 0.095], [0.0292, 0.112], [0.021, 0.124], [0.01, 0.1295], [0, 0.1305]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  micParts.push([flat(new THREE.LatheGeometry(foamProfile, 24)).rotateX(Math.PI / 2), K.soft]);
  for (const [g, col] of micParts) gear.push(paint(g, col).applyMatrix4(Mm));
  metal.push(paint(tube([0, 0, -0.098], [0, 0, -0.085], 0.019, 20, 0.025), "#4e5156").applyMatrix4(Mm));
  metal.push(paint(ring(0.0272, 0.0018, 28).translate(0, 0, 0.031), "#8c8f94").applyMatrix4(Mm));
  // boom: riser -> elbow -> mic yoke, both sections in one vertical plane
  const A = new THREE.Vector3(mx, MI.riserTop, poleZ);
  const P = new THREE.Vector3(0, 0.076, -0.036).applyMatrix4(Mm);
  const El = A.clone().lerp(P, 0.1).setY(MI.elbowY);
  const hinge = new THREE.Vector3().subVectors(El, A).cross(new THREE.Vector3().subVectors(P, El)).normalize();
  const boom = (a, b) => {
    const dir = new THREE.Vector3().subVectors(b, a);
    const n = new THREE.Vector3().crossVectors(hinge, dir).normalize();
    for (const s of [-1, 1]) {
      const o = hinge.clone().multiplyScalar(s * 0.011);
      gear.push(paint(tube(a.clone().add(o), b.clone().add(o), 0.0055, 8), K.gear));
    }
    const sp = n.clone().multiplyScalar(0.024);
    metal.push(paint(tube(a.clone().addScaledVector(dir, 0.16).add(sp), a.clone().addScaledVector(dir, 0.62).add(sp), 0.0046, 8), "#9a9da2"));
    for (const t of [0.16, 0.62]) {
      const q = a.clone().addScaledVector(dir, t);
      gear.push(paint(tube(q, q.clone().add(sp), 0.002, 5), K.gear));
    }
  };
  const knuckle = (p, r = 0.013) => gear.push(paint(tube(p.clone().addScaledVector(hinge, -0.019), p.clone().addScaledVector(hinge, 0.019), r, 14), K.gear));
  boom(A, El);
  boom(El, P);
  knuckle(A);
  knuckle(El, 0.015);
  knuckle(P, 0.011);

  // ---- key light: LED panel on a clamp pole, aimed at the user's face ----
  const KL = R.keyLight;
  const [kx] = KL.pole;
  clamp(kx);
  const Mk = aimMatrix(KL.center, KL.aim);
  const [pw, ph] = KL.size;
  gear.push(paint(at(plate(pw, ph, 0.022, 0.012, 0.003), 0, 0, -0.022), K.body).applyMatrix4(Mk));
  gear.push(paint(tube([0, 0, -0.022], [0, 0, -0.04], 0.012, 14), K.gear).applyMatrix4(Mk));
  for (const s of [-1, 1]) gear.push(paint(tube([s * 0.06, -0.045, -0.022], [s * 0.06, -0.045, -0.031], 0.0085, 14), K.soft).applyMatrix4(Mk));
  lit(flat(new THREE.PlaneGeometry(pw - 0.014, ph - 0.014)).translate(0, 0, 0.0008).applyMatrix4(Mk), "#ffffff", rects.panel);
  const Bk = new THREE.Vector3(0, 0, -0.04).applyMatrix4(Mk);
  const poleTop = Bk.y - 0.06;
  gear.push(paint(tube([kx, TOP + 0.008, poleZ], [kx, 1.42, poleZ], 0.014, 14), K.gear));
  gear.push(paint(tube([kx, 1.4, poleZ], [kx, 1.43, poleZ], 0.017, 14), K.gear));
  gear.push(paint(tube([kx, 1.42, poleZ], [kx, poleTop, poleZ], 0.0105, 12), K.gear));
  metal.push(paint(ball(0.015, [kx, poleTop + 0.01, poleZ]), "#44464b"));
  gear.push(paint(tube([kx, poleTop + 0.01, poleZ], Bk, 0.007, 10), K.gear));

  // ---- stream-control pad: tilted deck on a stand, 3 × 5 glowing keys (instanced) ----
  const SP = R.streamPad;
  const [rows, cols] = SP.grid;
  const tilt = -(90 - SP.tiltDeg) * DEG;
  const lift = 0.047 * Math.sin(SP.tiltDeg * DEG) + 0.0012;
  const Mp = placeY(SP.local, SP.rotDeg);
  const Md = Mp.clone().multiply(new THREE.Matrix4().makeTranslation(0, lift, 0)).multiply(new THREE.Matrix4().makeRotationX(tilt));
  gear.push(paint(at(plate(0.136, 0.094, 0.016, 0.009, 0.003), 0, 0, 0), K.body).applyMatrix4(Md));
  gear.push(paint(at(prism(0.11, 0.02, 0.031, 0.004, 0.001), 0, 0, -0.026), K.gear).applyMatrix4(Mp));
  const keyGeo = uvRect(paint(box(0.0175, 0.0175, 0.004, 0, 0, 0), "#ffffff"), rects.key);
  const keys = new THREE.InstancedMesh(keyGeo, glowMat, rows * cols);
  keys.name = "streamPadKeys";
  const pal = K.keys.map((h) => new THREE.Color(h));
  const prng = ctx.rng.fork("pad");
  const tmpM = new THREE.Matrix4(), tmpC = new THREE.Color();
  let ki = 0;
  for (let r = 0; r < rows; r++) {
    for (let cI = 0; cI < cols; cI++, ki++) {
      tmpM.copy(Md).multiply(new THREE.Matrix4().makeTranslation((cI - (cols - 1) / 2) * 0.0235, ((rows - 1) / 2 - r) * 0.0235, 0.0175));
      keys.setMatrixAt(ki, tmpM);
      if (ki === 0) tmpC.set(K.recKey);
      else if (prng.chance(0.2)) tmpC.set("#3a3b40");
      else tmpC.copy(prng.pick(pal));
      keys.setColorAt(ki, tmpC);
    }
  }
  keys.instanceMatrix.needsUpdate = true;
  keys.instanceColor.needsUpdate = true;
  const rec = new THREE.Color(K.recKey);
  keys.computeBoundingSphere();

  // ---- audio interface ----
  const MX = R.mixer;
  const Mx = placeY(MX.local, MX.rotDeg);
  const mixParts = [];
  mixParts.push([prism(0.165, 0.09, 0.042, 0.008, 0.003), K.body]);
  mixParts.push([at(prism(0.152, 0.078, 0.0012, 0.006, 0), 0, 0.0415, 0), "#1a1b1e"]);
  const knobs = [[-0.056, -0.008, 0.011], [-0.022, -0.008, 0.011], [0.036, -0.004, 0.018]];
  for (const [x, z, r] of knobs) {
    metal.push(paint(tube([x, 0.042, z], [x, 0.056, z], r, 24, r * 0.9), "#3d3f44").applyMatrix4(Mx));
    mixParts.push([box(0.0016, 0.0008, r * 0.75, x, 0.0565, z + r * 0.45), "#cfc8b8"]);
  }
  for (const x of [-0.056, -0.022]) {
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * (0.85 + (i / 5) * 1.3);
      lit(box(0.0026, 0.001, 0.0026, x + Math.cos(a) * 0.017, 0.0428, -0.008 - Math.sin(a) * 0.017).applyMatrix4(Mx), i < 4 ? "#7fb48a" : i === 4 ? "#d6a24e" : "#3a3b3e");
    }
  }
  for (const x of [-0.05, -0.016]) {
    metal.push(paint(ring(0.0095, 0.0024, 20).translate(x, 0.02, 0.0452), "#5c5f64").applyMatrix4(Mx));
    mixParts.push([flat(new THREE.CircleGeometry(0.008, 20)).translate(x, 0.02, 0.0451), "#0c0c0e"]);
  }
  metal.push(paint(ring(0.0045, 0.0016, 16).translate(0.05, 0.02, 0.0452), "#5c5f64").applyMatrix4(Mx));
  lit(box(0.003, 0.003, 0.001, 0.022, 0.02, 0.0452).applyMatrix4(Mx), "#7fb48a");
  for (const [g, col] of mixParts) gear.push(paint(g, col).applyMatrix4(Mx));

  // ---- desk mat, keyboard, mouse ----
  const MAT_T = 0.003;
  const [matW, matD] = R.mat.size;
  gear.push(paint(at(prism(matW, matD, MAT_T, 0.016, 0.001), R.mat.local[0], TOP, R.mat.local[2]), K.mat));
  const KB = R.keyboard;
  const Mkb = placeY([KB.local[0], TOP + MAT_T, KB.local[2]], KB.rotDeg || 0);
  const kbParts = [[prism(0.302, 0.118, 0.0095, 0.007, 0.0025), K.gear]];
  const u = 0.0192, kgap = 0.0024;
  const kbRows = [
    [Array(15).fill(1), 0.72],
    [[...Array(13).fill(1), 2], 1],
    [[1.5, ...Array(12).fill(1), 1.5], 1],
    [[1.75, ...Array(11).fill(1), 2.25], 1],
    [[2.25, ...Array(10).fill(1), 1.75, 1], 1],
    [[1.25, 1.25, 1.25, 6.25, 1, 1, 1, 1, 1], 1],
  ];
  let kz = -0.118 / 2 + 0.006;
  kbRows.forEach(([row, depth], ri) => {
    let kxp = -(15 * u) / 2;
    row.forEach((w, ci) => {
      const col = ri === 0 && ci === 0 ? "#6e4f35" : "#303237";
      kbParts.push([box(w * u - kgap, 0.0035, depth * u - kgap, kxp + (w * u) / 2, 0.0095 + 0.00175, kz + (depth * u) / 2), col]);
      kxp += w * u;
    });
    kz += depth * u;
  });
  for (const [g, col] of kbParts) gear.push(paint(g, col).applyMatrix4(Mkb));
  const MS = R.mouse;
  const Mms = placeY([MS.local[0], TOP + MAT_T, MS.local[2]], MS.rotDeg || 0);
  gear.push(paint(flat(new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2)).scale(0.031, 0.019, 0.056), K.body).applyMatrix4(Mms));
  gear.push(paint(tube([-0.003, 0.0165, -0.026], [0.003, 0.0165, -0.026], 0.0055, 12), "#101012").applyMatrix4(Mms));

  // ---- ON AIR box on the back edge ----
  const OA = R.onAir;
  const Moa = placeY(OA.local, OA.rotDeg);
  gear.push(paint(at(prism(0.112, 0.034, 0.044, 0.006, 0.002), 0, 0.004, 0), K.gear).applyMatrix4(Moa));
  for (const s of [-1, 1]) gear.push(paint(at(prism(0.016, 0.028, 0.004, 0.003, 0), s * 0.04, 0, 0), K.soft).applyMatrix4(Moa));
  lit(flat(new THREE.PlaneGeometry(0.1, 0.034)).translate(0, 0.026, 0.0172).applyMatrix4(Moa), "#ffffff", rects.onAir);

  // ---- meshes ----
  const monitorBody = mesh("monitorBody", monitorParts, mats.dark, { cast: true });
  const gearMesh = mesh("rigGear", gear, mats.dark);
  const metalMesh = mesh("rigMetal", metal, mats.metal);
  const glowMesh = mesh("rigGlow", glow, glowMat);
  glowMesh.receiveShadow = false;
  group.add(monitorBody, screen, gearMesh, metalMesh, glowMesh, keys);

  // ---- update: monitor redraw <= hz, REC key breathing ----
  const period = 1 / Math.max(1, Math.min(10, MO.hz || 8));
  let next = 0;
  const update = (dt, t) => {
    if (t < next) return;
    next = t + period;
    stream.tick(t);
    const k = 0.7 + 0.3 * Math.sin(t * 2.4);
    keys.instanceColor.setXYZ(0, rec.r * k, rec.g * k, rec.b * k);
    keys.instanceColor.needsUpdate = true;
  };
  return { group, update };
}

// ---- build ---------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const d = layout.desk;
  const root = new THREE.Group();
  root.name = "desk";
  root.position.fromArray(d.pos);
  root.rotation.y = d.rotY;

  const mats = {
    frame: new THREE.MeshStandardMaterial({ color: d.frame.color, roughness: 0.58, metalness: 0.25 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.72 }),
    dark: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05 }),
    matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 }),
    ceramic: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0 }),
  };

  // top: walnut, grain along the length, softened edges
  const walnut = ctx.textures.wood({ kind: "grain", color: d.topColor, rows: 6, plankWidth: 0.12, size: 1024, grain: 0.8, knots: 0.015, rng: ctx.rng.fork("top") });
  const topGeo = prism(d.width, d.depth, d.topThickness, 0.016, 0.003, 5);
  {
    const p = topGeo.attributes.position, uv = topGeo.attributes.uv;
    const [wu, wv] = walnut.worldSize;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / wu + 0.37, p.getZ(i) / wv + 0.21 + p.getY(i) * 0.6);
  }
  const top = new THREE.Mesh(
    topGeo,
    new THREE.MeshStandardMaterial({ map: walnut.map, roughnessMap: walnut.roughnessMap, bumpMap: walnut.bumpMap, bumpScale: 0.25, roughness: 0.56, metalness: 0 }),
  );
  top.name = "deskTop";
  top.position.y = d.topY - d.topThickness;
  top.castShadow = true;
  top.receiveShadow = true;

  const frame = mesh("deskFrame", buildFrame(d), mats.frame, { cast: true });

  // keypad face: the emissive height readout
  const k = d.keypad.size;
  const pad = ctx.textures.screen(320, 64, { mipmaps: true });
  drawKeypad(pad.ctx, 320, 64, d.keypad.readout);
  pad.texture.needsUpdate = true;
  const keypad = new THREE.Mesh(new THREE.PlaneGeometry(k[0] - 0.008, k[1] - 0.006), new THREE.MeshBasicMaterial({ map: pad.texture, toneMapped: false }));
  keypad.name = "deskKeypad";
  keypad.position.set(KEYPAD_X, d.topY - d.topThickness - k[1] / 2, d.depth / 2 + KEYPAD_PROUD + 0.0003);

  const laptop = buildLaptop(d, ctx, mats);
  const journal = buildJournal(d, ctx, mats);
  const cup = buildCup(d, mats);

  const atlas = drawGlowAtlas(ctx.textures, d.rig.colors);
  const glowMat = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, toneMapped: false });
  const rig = buildRig(d, ctx, mats, glowMat, atlas.rects);
  rig.group.add(laptop);

  root.add(top, frame, keypad, rig.group, journal, cup);
  scene.add(root);

  return {
    root,
    update: ctx.reducedMotion ? undefined : rig.update,
    colliders: [top, frame, cup],
    hotspots: [
      { zone: "laptop", label: "stream desk · rhizoMorphic", objects: [rig.group] },
      { zone: "journal", label: "Midnight Hysteria", objects: [journal] },
    ],
  };
}
