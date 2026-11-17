// objects/booth.js — the soundproof glass music corner around the drum kit (layout `booth`): double-glazed
// full-height glass on the W and S sides in slim dark aluminium posts with timber channels, a sliding glass door
// (starts open; Z toggles it), acoustic treatment on the N and E room walls (fabric absorbers, a wood-slat
// diffuser, ceiling clouds, a corner bass trap), and the instruments: tabla (dayan + bayan on ring cushions,
// woven rug, floor cushion), acoustic + electric guitar on stands with a small combo amp, a 61-key keyboard on an
// X-stand with stool and sustain pedal. Recording: overhead pair, kick mic, vocal mic, floor cable runs, a rolling
// cart with laptop (multitrack view), audio interface, monitors and headphones, a REC light above the door.
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots, dynamicColliders, door }.
//
// Every instrument plays through ctx.audio and answers with a small visual (head dip + glow, string shimmer, key
// light); hotspots have zone null and onActivate returns true. The kit itself (objects/drums.js) keeps the
// "music" zone. Picking uses invisible proxies (material.visible = false: no draw call); glass is noPick.
//
// Draw calls (main pass): glass, door glass, metal, door metal, wood, dark, soft, acoustic, tabla rug, two tabla
// heads, keys, key light (only while lit), strings, laptop screen, REC light, LEDs = 17. Shadow pass: metal, wood,
// dark, soft = 4. One small non-shadow PointLight (warm, dim; a little brighter at night), never toggled.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const NO_TIME = { night: 0, day: 1 }; // until/unless ENGINE provides ctx.time
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

// ---- build-time helpers ---------------------------------------------------------------------------------

const v3 = (a) => (a.isVector3 ? a.clone() : new THREE.Vector3(a[0], a[1], a[2]));
const qAxis = (x, y, z, angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle);
const qY = (a) => qAxis(0, 1, 0, a);
const mat = (pos, q, s) => new THREE.Matrix4().compose(v3(pos), q || new THREE.Quaternion(), s ? v3(s) : new THREE.Vector3(1, 1, 1));
const mul = (...ms) => ms.reduce((a, b) => new THREE.Matrix4().multiplyMatrices(a, b));
/** Placement matrix for a layout item: translate to pos, rotate rotY. */
const place = (pos, rotY) => mat(pos, qY(rotY || 0));

/** Non-indexed copy with position, normal, uv (+ optional flat colour or per-group colours). */
function prep(g, color, groupColors) {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new THREE.BufferGeometry();
  const n = src.attributes.position.count;
  out.setAttribute("position", src.attributes.position.clone());
  if (!src.attributes.normal) src.computeVertexNormals();
  out.setAttribute("normal", src.attributes.normal.clone());
  out.setAttribute("uv", src.attributes.uv ? src.attributes.uv.clone() : new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (color || groupColors) {
    const a = new Float32Array(n * 3);
    const fill = (c, from, to) => {
      for (let i = from; i < to; i++) {
        a[i * 3] = c.r;
        a[i * 3 + 1] = c.g;
        a[i * 3 + 2] = c.b;
      }
    };
    fill(new THREE.Color(color || "#ffffff"), 0, n);
    if (groupColors && g.groups && g.groups.length && !g.index) {
      for (const gr of g.groups) {
        const c = groupColors[gr.materialIndex];
        if (c) fill(new THREE.Color(c), gr.start, Math.min(n, gr.start + gr.count));
      }
    }
    out.setAttribute("color", new THREE.BufferAttribute(a, 3));
  }
  if (src !== g) src.dispose();
  g.dispose();
  return out;
}

class Bucket {
  constructor(colored) {
    this.list = [];
    this.colored = colored;
  }
  add(geometry, matrix, color, groupColors) {
    const g = prep(geometry, this.colored ? color || "#ffffff" : null, this.colored ? groupColors : null);
    if (matrix) g.applyMatrix4(matrix);
    this.list.push(g);
    return this;
  }
  box(size, pos, q, color, r = 0) {
    const g = r > 0 ? new RoundedBoxGeometry(size[0], size[1], size[2], 2, r) : new THREE.BoxGeometry(size[0], size[1], size[2]);
    return this.add(g, mat(pos, q), color);
  }
  /** Cylinder (rod) between two points; seg 4 = square tube. */
  rod(a, b, r, color, seg = 8, caps = true) {
    const A = v3(a), B = v3(b);
    const d = new THREE.Vector3().subVectors(B, A);
    const len = d.length();
    if (len < 1e-5) return this;
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d.multiplyScalar(1 / len));
    if (seg === 4) q.multiply(qY(Math.PI / 4));
    return this.add(new THREE.CylinderGeometry(r, r, len, seg, 1, !caps), mat(A.add(B).multiplyScalar(0.5), q), color);
  }
  mesh(material, name) {
    const m = new THREE.Mesh(mergeGeometries(this.list, false), material);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    m.name = name;
    return m;
  }
}

const lathe = (pts, seg = 32) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);
const tp = (m, p) => v3(p).applyMatrix4(m); // transform a local point

/** Guitar outline from two bouts (circles) per side; right side may differ (cutaway). */
function guitarShape(L, lower, upperL, upperR, waist) {
  const hw = (y, up) => {
    const a = lower[1] ** 2 - (y - lower[0]) ** 2, b = up[1] ** 2 - (y - up[0]) ** 2;
    let w = Math.max(a > 0 ? Math.sqrt(a) : 0, b > 0 ? Math.sqrt(b) : 0);
    w -= waist[1] * Math.exp(-(((y - waist[0]) / 0.045) ** 2));
    return Math.max(0, w);
  };
  const N = 40, ys = [];
  for (let i = 0; i <= N; i++) ys.push((L * (1 - Math.cos((Math.PI * i) / N))) / 2);
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  for (const y of ys.slice(1)) s.lineTo(hw(y, upperR) || 0.0001, y);
  for (const y of ys.slice(0, -1).reverse()) s.lineTo(-(hw(y, upperL) || 0.0001), y);
  return s;
}

/** Offset double-cutaway solid body (two horns either side of the neck pocket), closed spline. */
function electricShape() {
  const P = [[0, 0], [0.11, 0.015], [0.162, 0.1], [0.152, 0.19], [0.126, 0.25], [0.132, 0.31], [0.118, 0.39], [0.098, 0.418], [0.074, 0.4],
    [0.052, 0.36], [0.026, 0.365], [-0.026, 0.365], [-0.05, 0.385], [-0.082, 0.448], [-0.11, 0.45], [-0.13, 0.4], [-0.138, 0.32], [-0.126, 0.25],
    [-0.158, 0.18], [-0.168, 0.1], [-0.115, 0.018]];
  const curve = new THREE.SplineCurve(P.concat([P[0]]).map(([x, y]) => new THREE.Vector2(x, y)));
  const pts = curve.getSpacedPoints(64);
  pts.pop();
  return new THREE.Shape(pts);
}

// ---- textures --------------------------------------------------------------------------------------------

/** Glass alpha: a calm base with a few soft diagonal sheen bands. */
function glassAlpha(T, rng) {
  const s = 256;
  const { canvas, ctx: c } = T.makeCanvas(s);
  c.fillStyle = "rgb(150,150,150)";
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 4; i++) {
    const x = rng() * s * 1.6 - s * 0.3, w = 8 + rng() * 36;
    const g = c.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.5, `rgba(255,255,255,${0.25 + rng() * 0.3})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.save();
    c.translate(s / 2, s / 2);
    c.transform(1, 0, -0.55, 1, 0, 0);
    c.translate(-s / 2, -s / 2);
    c.fillStyle = g;
    c.fillRect(x, -s, w, s * 3);
    c.restore();
  }
  return T.toTexture(canvas, { srgb: false });
}

/** Tabla heads atlas: left half dayan (centred syahi), right half bayan (syahi offset toward the player). */
function headsAtlas(T, rng) {
  const { canvas, ctx: c } = T.makeCanvas(512, 256);
  const head = (cx, syahiR, sx, sy) => {
    const R = 124;
    c.fillStyle = "#3a2618";
    c.fillRect(cx - 128, 0, 256, 256);
    c.fillStyle = "#e4d6b8"; // maidan (goatskin)
    c.beginPath();
    c.arc(cx, 128, R, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(150,120,80,0.55)"; // kinar: the outer skin ring
    c.lineWidth = 16;
    c.beginPath();
    c.arc(cx, 128, R - 9, 0, Math.PI * 2);
    c.stroke();
    c.strokeStyle = "rgba(90,70,50,0.35)";
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, 128, R - 18, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2, d = rng() * R * 0.95;
      c.fillStyle = `rgba(120,95,70,${0.04 + rng() * 0.05})`;
      c.fillRect(cx + Math.cos(a) * d, 128 + Math.sin(a) * d, 2 + rng() * 3, 1 + rng() * 2);
    }
    const g = c.createRadialGradient(sx - syahiR * 0.3, sy - syahiR * 0.3, 2, sx, sy, syahiR);
    g.addColorStop(0, "#3a3633");
    g.addColorStop(0.7, "#171513");
    g.addColorStop(1, "#0e0d0c");
    c.fillStyle = g;
    c.beginPath();
    c.arc(sx, sy, syahiR, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(60,50,40,0.6)";
    c.lineWidth = 2;
    c.stroke();
  };
  head(128, 46, 128, 128);
  head(384, 40, 384, 152);
  if (T.grainOverlay) T.grainOverlay(c, 512, 256, { rng: rng.fork("grain"), amount: 0.04, scale: 5 });
  return T.toTexture(canvas, { srgb: true });
}

/** Woven cotton dhurrie: indigo ground, oat and madder stripes across the short side. */
function dhurrie(T, rng) {
  const { canvas, ctx: c } = T.makeCanvas(128, 256);
  c.fillStyle = "#3f4865";
  c.fillRect(0, 0, 128, 256);
  const bands = [[0, 14, "#c4b79c"], [14, 4, "#7a3b2e"], [22, 3, "#c4b79c"], [229, 3, "#c4b79c"], [234, 4, "#7a3b2e"], [242, 14, "#c4b79c"]];
  for (const [y, h, col] of bands) {
    c.fillStyle = col;
    c.fillRect(0, y, 128, h);
  }
  for (let y = 40; y < 216; y += 22) {
    c.fillStyle = "rgba(196,183,156,0.55)";
    c.fillRect(8, y, 112, 2);
  }
  for (let y = 0; y < 256; y += 2) {
    c.fillStyle = `rgba(0,0,0,${0.05 + rng() * 0.05})`;
    c.fillRect(0, y, 128, 1);
  }
  if (T.grainOverlay) T.grainOverlay(c, 128, 256, { rng: rng.fork("grain"), amount: 0.06, scale: 3 });
  return T.toTexture(canvas, { srgb: true });
}

// 61 keys, C2..C7: 36 white keys. Black keys follow C, D, F, G, A (white index within the octave 0, 1, 3, 4, 5).
const WHITE_SEMI = [0, 2, 4, 5, 7, 9, 11];
const HAS_BLACK = [true, true, false, true, true, true, false];
const N_WHITE = 36, BLACK_W = 0.58, BLACK_D = 0.62; // fractions of a white key's width / of the key length

/** Key bed texture: u across the 36 white keys, v from the front edge (0) to the back (1). */
function keysTexture(T) {
  const W = 1024, H = 192;
  const { canvas, ctx: c } = T.makeCanvas(W, H);
  const kw = W / N_WHITE;
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#d9d6cf");
  g.addColorStop(0.75, "#f2efe8");
  g.addColorStop(1, "#ece9e2");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#57534d";
  for (let i = 0; i <= N_WHITE; i++) c.fillRect(Math.round(i * kw) - 1, 0, 2, H);
  for (let i = 0; i < N_WHITE - 1; i++) {
    if (!HAS_BLACK[i % 7]) continue;
    const x = (i + 1) * kw - (kw * BLACK_W) / 2;
    const bh = H * BLACK_D;
    const bg = c.createLinearGradient(x, 0, x + kw * BLACK_W, 0);
    bg.addColorStop(0, "#0c0c0d");
    bg.addColorStop(0.5, "#2a2a2c");
    bg.addColorStop(1, "#0c0c0d");
    c.fillStyle = bg;
    c.fillRect(x, 0, kw * BLACK_W, bh);
    c.fillStyle = "rgba(255,255,255,0.12)";
    c.fillRect(x + 2, bh - 10, kw * BLACK_W - 4, 6);
  }
  c.fillStyle = "rgba(0,0,0,0.25)";
  c.fillRect(0, 0, W, 3);
  return T.toTexture(canvas, { srgb: true });
}

// ---- build ------------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const B = layout.booth;
  const T = ctx.textures;
  const rng = ctx.rng;
  const audio = ctx.audio || { hit() {} };
  const root = new THREE.Group();
  root.name = "booth";
  if (!B) {
    scene.add(root);
    return { root };
  }
  const [X0, X1] = B.x, [Z0, Z1] = B.z, H = B.height;
  const C = B.colors;
  const G = B.glass;

  const metal = new Bucket(true); // anodised frames, chrome, copper, laptop shell
  const wood = new Bucket(true); // timber channels, slats, guitars, tabla shells, cart shelves, stool
  const dark = new Bucket(true); // stands, plastics, tolex, mic bodies, cables, leather straps
  const soft = new Bucket(true); // cushions, amp cloth, stool seat
  const acoustic = new Bucket(true); // wall absorbers, clouds, bass trap, diffuser backer (no shadow)
  const leds = new Bucket(true); // tiny glows (MeshBasic)
  const proxyMat = new THREE.MeshBasicMaterial({ visible: false });
  const proxies = [];
  const proxy = (size, matrix, name) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), proxyMat);
    m.applyMatrix4(matrix);
    m.name = name;
    root.add(m);
    proxies.push(m);
    return m;
  };

  // ---- glass walls ------------------------------------------------------------------------------------
  const glassGeo = [];
  const fw = G.frame, fd = G.depth, ch = G.channel;
  const timber = "#4b3526", alu = G.frameColor;
  /**
   * One straight glass run along `axis` ("x" or "z") at fixed `at`, from a0 to a1. segs: [[from, to, y0, y1]]
   * pane rectangles (double glazed). Posts at `posts` (full height).
   */
  function paneAt(axis, at, a0, a1, y0, y1, out) {
    const len = a1 - a0, h = y1 - y0, mid = (a0 + a1) / 2;
    for (const off of [-G.gap / 2, G.gap / 2]) {
      const g = new THREE.PlaneGeometry(len, h);
      if (axis === "z") g.rotateY(Math.PI / 2);
      g.translate(axis === "x" ? mid : at + off, (y0 + y1) / 2, axis === "x" ? at + off : mid);
      out.push(prep(g));
    }
  }
  const frameBox = (axis, at, a0, a1, y0, y1, depth, bucket, color) => {
    const len = a1 - a0;
    const size = axis === "x" ? [len, y1 - y0, depth] : [depth, y1 - y0, len];
    const pos = axis === "x" ? [(a0 + a1) / 2, (y0 + y1) / 2, at] : [at, (y0 + y1) / 2, (a0 + a1) / 2];
    bucket.box(size, pos, null, color);
  };
  const post = (x, z) => metal.box([fw, H, fw], [x, H / 2, z], null, alu);
  {
    // W run: x = X0, z Z0..Z1, mullions
    const cuts = [Z0, ...G.mullionsW, Z1];
    frameBox("z", X0, Z0, Z1, 0, ch, fd, wood, timber);
    frameBox("z", X0, Z0, Z1, H - ch, H, fd, wood, timber);
    for (let i = 0; i < cuts.length - 1; i++) paneAt("z", X0, cuts[i] + fw / 2, cuts[i + 1] - fw / 2, ch, H - ch, glassGeo);
    for (const z of cuts) post(X0, Math.min(Z1, Math.max(Z0 + fw / 2, z)));
    // S run: z = Z1, x X0..X1 with the door opening
    const [dx0, dx1] = B.door.x;
    const hdr = B.door.height;
    frameBox("x", Z1, X0, dx0, 0, ch, fd, wood, timber);
    frameBox("x", Z1, dx1, X1, 0, ch, fd, wood, timber);
    frameBox("x", Z1, X0, X1, H - ch, H, fd, wood, timber);
    const sCuts = [X0, dx0, dx1, ...G.mullionsS, X1];
    paneAt("x", Z1, X0 + fw / 2, dx0 - fw / 2, ch, H - ch, glassGeo);
    for (let i = 2; i < sCuts.length - 1; i++) paneAt("x", Z1, sCuts[i] + fw / 2, sCuts[i + 1] - fw / 2, ch, H - ch, glassGeo);
    for (const x of sCuts) post(Math.max(X0 + fw / 2, Math.min(X1 - fw / 2, x)), Z1);
    // door head (two rails) and the transom glass above it; REC box sits between the rails
    frameBox("x", Z1, dx0, dx1, hdr, hdr + 0.2, fd, metal, alu);
    paneAt("x", Z1, dx0 + fw / 2, dx1 - fw / 2, hdr + 0.2, H - ch, glassGeo);
    // sliding-door track on the outside face: rail from the opening to the parked position
    const tz = B.door.z;
    metal.box([B.door.slide + (dx1 - dx0) + 0.12, 0.045, 0.05], [(dx0 + dx1 + B.door.slide) / 2, hdr + 0.04, tz], null, alu);
    metal.box([B.door.slide + (dx1 - dx0) + 0.12, 0.012, 0.02], [(dx0 + dx1 + B.door.slide) / 2, 0.006, tz - 0.012], null, alu); // floor guide
    // wall caps where the glass meets the room walls
    metal.box([0.03, H, fd + 0.02], [X1 - 0.015, H / 2, Z1], null, alu);
    metal.box([fd + 0.02, H, 0.03], [X0, H / 2, Z0 + 0.015], null, alu);
  }
  const glassMat = new THREE.MeshStandardMaterial({
    // dark tint: the diffuse part only darkens a little (real glass has no milky body); reflections carry the look
    color: G.tint, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.1, alphaMap: glassAlpha(T, rng.fork("glass")),
    depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.5,
  });
  glassMat.forceSinglePass = true; // one draw per glass mesh (no back/front split)
  if (scene.environment) glassMat.envMap = scene.environment;
  // Reflections are not dimmed by the low opacity: diffuse is blended by alpha, specular is added on top.
  glassMat.premultipliedAlpha = true;
  glassMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <opaque_fragment>", "vec3 boothSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;\ngl_FragColor = vec4( ( outgoingLight - boothSpec ) * diffuseColor.a + boothSpec, diffuseColor.a );")
      .replace("#include <premultiplied_alpha_fragment>", "");
  };
  glassMat.customProgramCacheKey = () => "booth-glass";
  const glass = new THREE.Mesh(mergeGeometries(glassGeo, false), glassMat);
  for (const g of glassGeo) g.dispose();
  glass.name = "booth.glass";
  glass.userData.noPick = true;
  glass.renderOrder = 2;
  root.add(glass);

  // ---- sliding door leaf ----------------------------------------------------------------------------------
  const D = B.door;
  const leafW = D.x[1] - D.x[0] + 2 * D.overlap, leafH = D.height - 0.015;
  const closedX = (D.x[0] + D.x[1]) / 2;
  const leaf = new THREE.Group();
  leaf.name = "booth.door";
  leaf.position.set(closedX, 0, D.z);
  root.add(leaf);
  const leafFrame = new Bucket(true);
  {
    const sw = 0.04, t = D.thickness;
    for (const sx of [-1, 1]) leafFrame.box([sw, leafH, t], [sx * (leafW / 2 - sw / 2), 0.008 + leafH / 2, 0], null, alu);
    leafFrame.box([leafW, 0.06, t], [0, 0.008 + leafH - 0.03, 0], null, alu);
    leafFrame.box([leafW, 0.08, t], [0, 0.048, 0], null, alu);
    // pull bars both faces, near the leading (west) edge
    for (const sz of [-1, 1]) {
      const px = -leafW / 2 + 0.11, pz = sz * (t / 2 + 0.035);
      leafFrame.rod([px, 0.75, pz], [px, 1.35, pz], 0.012, "#b9bcc0", 12);
      for (const y of [0.8, 1.3]) leafFrame.rod([px, y, sz * t / 2], [px, y, pz], 0.007, "#b9bcc0", 8);
    }
    // two roller carriages under the track
    for (const sx of [-0.3, 0.3]) leafFrame.box([0.08, 0.05, 0.03], [sx, D.height + 0.01, 0], null, "#1a1b1d");
  }
  const leafFrameMesh = leafFrame.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.6 }), "booth.door.frame");
  leafFrameMesh.castShadow = true;
  leafFrameMesh.receiveShadow = true;
  leaf.add(leafFrameMesh);
  {
    const geos = [];
    for (const off of [-0.008, 0.008]) {
      const g = new THREE.PlaneGeometry(leafW - 0.08, leafH - 0.14);
      g.translate(0, 0.088 + (leafH - 0.14) / 2, off);
      geos.push(prep(g));
    }
    const lg = new THREE.Mesh(mergeGeometries(geos, false), glassMat);
    for (const g of geos) g.dispose();
    lg.name = "booth.door.glass";
    lg.userData.noPick = true;
    lg.renderOrder = 2;
    leaf.add(lg);
  }
  // pick proxies ride on the leaf: the whole leaf while it is (mostly) closed, only a strip at the pull bar while
  // open, so the open doorway and the glass the leaf parks over never swallow look-rays aimed into the booth.
  // (object.visible toggles picking; the material is invisible either way.)
  const leafProxy = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, 0.06), proxyMat);
  leafProxy.position.set(0, 0.008 + leafH / 2, 0);
  leafProxy.name = "booth.door.proxy";
  const edgeProxy = new THREE.Mesh(new THREE.BoxGeometry(0.15, leafH * 0.7, 0.09), proxyMat);
  edgeProxy.position.set(-leafW / 2 + 0.075, 0.008 + leafH * 0.45, 0);
  edgeProxy.name = "booth.door.handleProxy";
  leaf.add(leafProxy, edgeProxy);
  // never ray-picked (hidden), but it widens the hotspot's proximity box over the opening: standing in the
  // doorway facing it targets the door even while the leaf is parked to the side
  const doorwayProxy = proxy([D.x[1] - D.x[0], D.height, 0.1], mat([closedX, D.height / 2, Z1]), "booth.doorway.proxy");
  doorwayProxy.visible = false;

  // REC light: a small box between the door head rails, lit faces both sides
  const R = B.recLight;
  {
    const [rw, rh, rd] = R.size;
    dark.box([rw, rh, rd], [R.pos[0], D.height + 0.115, Z1], null, "#151617", 0.01);
  }
  const recTex = (() => {
    const { canvas, ctx: c } = T.makeCanvas(128, 48);
    c.fillStyle = "#2a0606";
    c.fillRect(0, 0, 128, 48);
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.arc(30, 24, 9, 0, Math.PI * 2);
    c.fill();
    c.font = `700 26px ${MONO}`;
    c.textBaseline = "middle";
    c.fillText("REC", 48, 25);
    return T.toTexture(canvas, { srgb: true });
  })();
  const recMat = new THREE.MeshStandardMaterial({ color: "#3a0c0c", roughness: 0.4, emissive: "#ff2a1e", emissiveMap: recTex, emissiveIntensity: 0.04 });
  {
    const [rw, rh, rd] = R.size;
    const geos = [];
    for (const sz of [-1, 1]) {
      const g = new THREE.PlaneGeometry(rw - 0.03, rh - 0.025);
      if (sz < 0) g.rotateY(Math.PI);
      g.translate(R.pos[0], D.height + 0.115, Z1 + sz * (rd / 2 + 0.001));
      geos.push(prep(g));
    }
    const recMesh = new THREE.Mesh(mergeGeometries(geos, false), recMat);
    for (const g of geos) g.dispose();
    recMesh.name = "booth.rec";
    root.add(recMesh);
  }

  // ---- acoustic treatment -------------------------------------------------------------------------------
  const pd = B.depth;
  const wallN = Z0, wallE = X1;
  const panel = (wall, a, y, w, h, col) => {
    const g = new RoundedBoxGeometry(wall === "N" ? w : pd, h, wall === "N" ? pd : w, 2, 0.014);
    acoustic.add(g, mat(wall === "N" ? [a, y, wallN + pd / 2 + 0.002] : [wallE - pd / 2 - 0.002, y, a]), C[col] || col);
  };
  for (const [a, y, w, h, col] of B.panels.N) panel("N", a, y, w, h, col);
  for (const [a, y, w, h, col] of B.panels.E) panel("E", a, y, w, h, col);
  {
    // wood-slat diffuser: dark felt backer, slats of stepped depth (quadratic-residue sequence)
    const df = B.diffuser;
    const [x0, x1] = df.x, [y0, y1] = df.y;
    acoustic.box([x1 - x0, y1 - y0, 0.012], [(x0 + x1) / 2, (y0 + y1) / 2, wallN + 0.008], null, C.felt);
    const pitch = df.slat + df.gap;
    const n = Math.floor((x1 - x0 + df.gap) / pitch);
    const start = (x0 + x1) / 2 - ((n - 1) * pitch) / 2;
    for (let i = 0; i < n; i++) {
      const dep = 0.014 + ((i * i) % 7) * 0.0045;
      wood.box([df.slat, y1 - y0 - 0.02, dep], [start + i * pitch, (y0 + y1) / 2, wallN + 0.014 + dep / 2], null, T.shade ? T.shade(C.slat, ((i * 7) % 5) * 0.02 - 0.04) : C.slat);
    }
  }
  for (const [x, z, w, d] of B.clouds) {
    acoustic.add(new RoundedBoxGeometry(w, pd, d, 2, 0.014), mat([x, B.cloudY, z]), C.oat);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      metal.rod([x + sx * (w / 2 - 0.08), B.cloudY + pd / 2, z + sz * (d / 2 - 0.08)], [x + sx * (w / 2 - 0.08), H, z + sz * (d / 2 - 0.08)], 0.0018, "#9a9da2", 4, false);
    }
  }
  {
    const bt = B.bassTrap, leg = bt.leg;
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.lineTo(-leg, 0);
    s.lineTo(0, leg);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: bt.y[1] - bt.y[0], bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
    // shape xy -> world (x, z): x = X1 + sx, z = Z0 + sy ; extrude along +z -> world +y
    g.rotateX(Math.PI / 2); // (x, y, z) -> (x, -z, y): extrude now -y, shape y -> world z
    g.translate(X1 - 0.012, bt.y[1], Z0 + 0.012);
    acoustic.add(g, null, C.charcoal);
  }

  // ---- keyboard on an X-stand, stool, pedal ----------------------------------------------------------------
  const K = B.keyboard;
  const KM = place(K.pos, K.rotY);
  const keysW = 0.84, keysD = 0.14;
  const keyTop = K.topY - 0.012;
  {
    const armY = K.topY - K.height - 0.012;
    const sx = 0.3, sd = K.standDepth / 2;
    for (const z of [-0.06, 0.06]) {
      dark.rod(tp(KM, [-sx, 0.03, z]), tp(KM, [sx, armY - 0.01, z]), 0.014, "#1d1e20", 4);
      dark.rod(tp(KM, [sx, 0.03, z]), tp(KM, [-sx, armY - 0.01, z]), 0.014, "#1d1e20", 4);
    }
    dark.rod(tp(KM, [0, (armY + 0.03) / 2, -0.09]), tp(KM, [0, (armY + 0.03) / 2, 0.09]), 0.012, "#2c2d30", 10); // pivot bolt
    for (const x of [-sx, sx]) {
      dark.rod(tp(KM, [x, 0.03, -sd]), tp(KM, [x, 0.03, sd]), 0.015, "#1d1e20", 4); // feet
      dark.rod(tp(KM, [x, armY, -sd]), tp(KM, [x, armY, sd]), 0.014, "#1d1e20", 4); // arms
      for (const z of [-sd, sd]) {
        soft.add(new THREE.CylinderGeometry(0.018, 0.018, 0.04, 8).rotateX(Math.PI / 2), mul(KM, mat([x, 0.03, z])), "#111111");
        soft.add(new THREE.CylinderGeometry(0.017, 0.017, 0.07, 8).rotateX(Math.PI / 2), mul(KM, mat([x, armY + 0.003, z * 0.6])), "#121212"); // rubber sleeves
      }
    }
    // body: dark case; the key bed is lower at the front, between the end cheeks; control panel at the back
    const bot = K.topY - K.height, backD = K.depth - keysD - 0.004;
    dark.add(new RoundedBoxGeometry(K.width, K.height, backD, 2, 0.01), mul(KM, mat([0, K.topY - K.height / 2, -K.depth / 2 + backD / 2])), "#202124");
    dark.add(new RoundedBoxGeometry(K.width, keyTop - 0.018 - bot, keysD + 0.012, 2, 0.006), mul(KM, mat([0, (bot + keyTop - 0.018) / 2, K.depth / 2 - (keysD + 0.012) / 2])), "#202124");
    for (const sx of [-1, 1]) dark.add(new RoundedBoxGeometry((K.width - keysW) / 2 - 0.002, K.height - 0.01, keysD + 0.01, 2, 0.006), mul(KM, mat([sx * (K.width / 2 - (K.width - keysW) / 4), K.topY - 0.01 - (K.height - 0.01) / 2 + 0.005, K.depth / 2 - (keysD + 0.01) / 2])), "#202124");
    dark.add(new THREE.BoxGeometry(keysW + 0.004, 0.016, keysD), mul(KM, mat([0, keyTop - 0.009, K.depth / 2 - keysD / 2 - 0.004])), "#0b0b0c");
    // wheels (left cheek), knobs, small display
    for (const x of [-0.448, -0.428]) dark.add(new THREE.CylinderGeometry(0.022, 0.022, 0.012, 16).rotateZ(Math.PI / 2), mul(KM, mat([x, K.topY - 0.006, 0.06])), "#2d2e31");
    for (let i = 0; i < 6; i++) metal.add(new THREE.CylinderGeometry(0.008, 0.009, 0.012, 12), mul(KM, mat([-0.3 + i * 0.045, K.topY + 0.005, -0.08])), "#8f9296");
    leds.add(new THREE.PlaneGeometry(0.09, 0.028).rotateX(-Math.PI / 2), mul(KM, mat([0.12, K.topY + 0.0012, -0.08])), "#3fb8a8");
    for (let i = 0; i < 4; i++) dark.add(new THREE.BoxGeometry(0.016, 0.005, 0.012), mul(KM, mat([0.24 + i * 0.03, K.topY + 0.002, -0.08])), "#4a4b4e");
  }
  const keysTex = keysTexture(T);
  const keysMesh = (() => {
    const top = new THREE.PlaneGeometry(keysW, keysD).rotateX(-Math.PI / 2); // uv v: 1 at the back (−z)
    top.translate(0, keyTop, K.depth / 2 - keysD / 2 - 0.004);
    const front = new THREE.PlaneGeometry(keysW, 0.016);
    const uv = front.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 0.02);
    front.translate(0, keyTop - 0.008, K.depth / 2 - 0.004);
    const g = mergeGeometries([prep(top), prep(front)], false);
    g.applyMatrix4(KM);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: keysTex, roughness: 0.35 }));
    m.name = "booth.keys";
    m.receiveShadow = true;
    return m;
  })();
  root.add(keysMesh);
  const keyLight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#9fe6d8", transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  keyLight.name = "booth.keyLight";
  keyLight.visible = false;
  root.add(keyLight);
  const keysProxy = proxy([keysW, 0.05, keysD + 0.02], mul(KM, mat([0, keyTop + 0.015, K.depth / 2 - keysD / 2])), "booth.keys.proxy");
  {
    const S = B.stool;
    const [x, , z] = S.pos, r = S.diameter / 2, h = S.height;
    soft.add(lathe([[0, h - 0.06], [r - 0.01, h - 0.06], [r, h - 0.045], [r, h - 0.015], [r - 0.02, h], [0, h + 0.002]], 32), mat([x, 0, z]), C.charcoal);
    wood.add(new THREE.CylinderGeometry(r - 0.02, r - 0.03, 0.03, 24), mat([x, h - 0.075, z]), "#6e4f34");
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      wood.rod([x + Math.cos(a) * (r - 0.06), h - 0.09, z + Math.sin(a) * (r - 0.06)], [x + Math.cos(a) * (r + 0.01), 0, z + Math.sin(a) * (r + 0.01)], 0.014, "#6e4f34", 8);
    }
    wood.add(new THREE.TorusGeometry(r - 0.025, 0.007, 6, 28).rotateX(Math.PI / 2), mat([x, 0.2, z]), "#6e4f34");
    const P = B.pedal;
    const [pw, ph, pl] = P.size;
    dark.add(new RoundedBoxGeometry(pw, 0.014, pl, 2, 0.005), mat([P.pos[0], 0.007, P.pos[2]], qY(K.rotY)), "#151516");
    dark.add(new RoundedBoxGeometry(pw - 0.01, 0.012, pl * 0.75, 2, 0.004), mat([P.pos[0], ph * 0.7, P.pos[2]], qY(K.rotY).multiply(qAxis(1, 0, 0, -9 * DEG))), "#262729");
  }

  // ---- guitars, stands, amp -------------------------------------------------------------------------------
  const LEAN = -15 * DEG;
  const guitarM = (g) => mul(place(g.pos, g.rotY), mat([0, 0.1, -0.02], qAxis(1, 0, 0, LEAN)));
  /** Body + neck + head in guitar-local frame (y along the neck, z out of the top). */
  function guitar(M, kind) {
    const ac = kind === "acoustic";
    const L = ac ? 0.5 : 0.43;
    const depth = ac ? 0.095 : 0.042;
    const shape = ac ? guitarShape(L, [0.17, 0.175], [0.375, 0.138], [0.375, 0.138], [0.3, 0.01]) : electricShape();
    const eg = new THREE.ExtrudeGeometry(shape, { depth: depth - 0.008, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 6 });
    eg.translate(0, 0, -depth / 2 + 0.004);
    const top = depth / 2;
    if (ac) {
      wood.add(eg, M, "#d4ad6f", ["#d4ad6f", "#5a3320"]);
      dark.add(new THREE.CircleGeometry(0.042, 32), mul(M, mat([0, 0.37, top + 0.0012])), "#120d0a");
      wood.add(new THREE.RingGeometry(0.046, 0.056, 36), mul(M, mat([0, 0.37, top + 0.001])), "#3b2a1c");
      wood.add(new THREE.BoxGeometry(0.15, 0.028, 0.009), mul(M, mat([0, 0.12, top + 0.0045])), "#2a1a12"); // bridge
      metal.add(new THREE.BoxGeometry(0.075, 0.003, 0.003), mul(M, mat([0, 0.128, top + 0.0095])), "#e8e2d4"); // saddle
    } else {
      wood.add(eg, M, "#e7dfcc", ["#e7dfcc", "#d9d0bc"]); // vintage white
      const pg = guitarShape(0.24, [0.1, 0.085], [0.19, 0.06], [0.19, 0.045], [0.15, 0.008]);
      dark.add(new THREE.ShapeGeometry(pg, 4), mul(M, mat([0.012, 0.1, top + 0.004])), "#3a2c24"); // pickguard
      for (const y of [0.15, 0.22, 0.29]) dark.add(new RoundedBoxGeometry(0.075, 0.019, 0.006, 1, 0.003), mul(M, mat([0, y, top + 0.007])), "#ece6d6");
      for (const [x, y] of [[0.085, 0.09], [0.1, 0.13], [0.11, 0.17]]) dark.add(new THREE.CylinderGeometry(0.0095, 0.0105, 0.012, 14).rotateX(Math.PI / 2), mul(M, mat([x, y, top + 0.01])), "#ece6d6");
      metal.add(new THREE.BoxGeometry(0.085, 0.03, 0.008), mul(M, mat([0, 0.075, top + 0.005])), "#c8cbce"); // bridge
    }
    // neck + fretboard + frets + head + tuners
    const n0 = ac ? L - 0.02 : 0.335, n1 = ac ? L + 0.43 : 0.335 + 0.45;
    const neckLen = n1 - n0;
    const neck = new THREE.BoxGeometry(1, 1, 1);
    const pos = neck.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) + 0.5; // 0 at the body, 1 at the nut
      pos.setX(i, pos.getX(i) * (0.056 - 0.012 * y));
      pos.setY(i, n0 + y * neckLen);
      pos.setZ(i, pos.getZ(i) * 0.022 + top - 0.006);
    }
    neck.computeVertexNormals();
    wood.add(neck, M, ac ? "#6a4428" : "#d8b27c");
    const fb = new THREE.BoxGeometry(1, 1, 1);
    const fp2 = fb.attributes.position;
    for (let i = 0; i < fp2.count; i++) {
      const y = fp2.getY(i) + 0.5;
      fp2.setX(i, fp2.getX(i) * (0.055 - 0.012 * y));
      fp2.setY(i, n0 + y * neckLen);
      fp2.setZ(i, fp2.getZ(i) * 0.006 + top + 0.008);
    }
    fb.computeVertexNormals();
    wood.add(fb, M, ac ? "#2a1c14" : "#c79e68");
    for (let f = 1; f <= 14; f++) {
      const y = n1 - neckLen * (1 - Math.pow(2, -f / 12)) * 1.6;
      if (y < n0) break;
      metal.add(new THREE.BoxGeometry(0.052 - 0.012 * ((y - n0) / neckLen), 0.002, 0.002), mul(M, mat([0, y, top + 0.0115])), "#d7d4cc");
    }
    const headQ = qAxis(1, 0, 0, -12 * DEG);
    const HM = mul(M, mat([0, n1, top - 0.004], headQ));
    wood.add(new RoundedBoxGeometry(ac ? 0.07 : 0.06, 0.18, 0.016, 2, 0.005), mul(HM, mat([ac ? 0 : 0.012, 0.09, 0])), ac ? "#2a1c14" : "#d8b27c");
    for (let i = 0; i < 6; i++) {
      const side = ac ? (i < 3 ? -1 : 1) : 1, k = ac ? i % 3 : i;
      const y = ac ? 0.04 + k * 0.05 : 0.02 + k * 0.027;
      metal.add(new THREE.CylinderGeometry(0.005, 0.005, 0.03, 8).rotateZ(Math.PI / 2), mul(HM, mat([side * (ac ? 0.05 : 0.045) + (ac ? 0 : 0.012), y, -0.004])), "#c9c3b5");
      metal.add(new THREE.CylinderGeometry(0.007, 0.007, 0.012, 10).rotateX(Math.PI / 2), mul(HM, mat([ac ? side * 0.024 : 0.034, y, 0.012])), "#c9c3b5");
    }
    metal.add(new THREE.BoxGeometry(ac ? 0.045 : 0.043, 0.005, 0.005), mul(M, mat([0, n1, top + 0.013])), "#efe9da"); // nut
    return { bridgeY: ac ? 0.128 : 0.075, nutY: n1, top, jack: tp(M, [0.15, 0.12, 0]) };
  }
  /** A-frame stand: cradle bar with rubber arms, centre tube up behind the neck, back leg, yoke. */
  function guitarStand(g, M) {
    const S = place(g.pos, g.rotY);
    const col = "#1b1c1e";
    const cz = 0.05;
    dark.rod(tp(S, [-0.13, 0.1, cz]), tp(S, [0.13, 0.1, cz]), 0.008, col, 8);
    for (const sx of [-1, 1]) {
      dark.rod(tp(S, [sx * 0.11, 0.1, cz]), tp(S, [sx * 0.11, 0.15, cz + 0.035]), 0.009, "#2a2a2a", 8);
      dark.rod(tp(S, [sx * 0.13, 0.1, cz]), tp(S, [sx * 0.15, 0.005, cz + 0.08]), 0.007, col, 8);
    }
    const yoke = tp(M, [0, 0.66, -0.04]);
    const baseP = tp(S, [0, 0.1, -0.06]);
    dark.rod(tp(S, [0, 0.1, cz]), baseP, 0.008, col, 8);
    dark.rod(baseP, yoke, 0.009, col, 8);
    dark.rod(baseP, tp(S, [0, 0.005, -0.15]), 0.007, col, 8);
    const yq = new THREE.Quaternion().setFromRotationMatrix(M);
    dark.add(new THREE.TorusGeometry(0.03, 0.006, 6, 14, Math.PI), mat(yoke, yq.clone().multiply(qAxis(1, 0, 0, Math.PI / 2))), "#2a2a2a");
  }
  const acM = guitarM(B.acoustic), elM = guitarM(B.electric);
  const ac = guitar(acM, "acoustic");
  const el = guitar(elM, "electric");
  guitarStand(B.acoustic, acM);
  guitarStand(B.electric, elM);
  // strings: one 6-string geometry in guitar space per guitar; instance i = guitar i (scale x shimmers on a strum)
  const stringGeos = [ac, el].map((gq) => {
    const b = new Bucket(false);
    for (let i = 0; i < 6; i++) {
      const xb = (i - 2.5) * 0.0105, xn = (i - 2.5) * 0.0074;
      b.rod([xb, gq.bridgeY, gq.top + 0.011], [xn, gq.nutY, gq.top + 0.0135], 0.0006 + (5 - i) * 0.00012, null, 3, false);
    }
    const g = mergeGeometries(b.list, false);
    for (const x of b.list) x.dispose();
    return g;
  });
  // the two string sets differ only slightly: use the acoustic set for both; instance matrices carry the guitars
  stringGeos[1].dispose();
  const strings = new THREE.InstancedMesh(stringGeos[0], new THREE.MeshStandardMaterial({ color: "#d9d6cf", metalness: 0.9, roughness: 0.3 }), 2);
  strings.name = "booth.strings";
  strings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const stringBase = [acM, elM].map((m) => {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { p, q, s };
  });
  // electric strings: shift the bridge end (acoustic bridge 0.128 vs electric 0.075) by stretching y a little
  {
    const k = (el.nutY - el.bridgeY) / (ac.nutY - ac.bridgeY);
    stringBase[1].s.y = k;
    stringBase[1].p.add(new THREE.Vector3(0, el.bridgeY - ac.bridgeY * k, el.top - ac.top).applyQuaternion(stringBase[1].q));
  }
  stringBase.forEach((b, i) => strings.setMatrixAt(i, new THREE.Matrix4().compose(b.p, b.q, b.s)));
  root.add(strings);
  const acProxy = proxy([0.4, 1.0, 0.12], mul(acM, mat([0, 0.5, 0])), "booth.acoustic.proxy");
  const elProxy = proxy([0.34, 0.95, 0.08], mul(elM, mat([0, 0.45, 0])), "booth.electric.proxy");

  // combo amp
  const A = B.amp;
  const AM = place(A.pos, A.rotY);
  const ampLed = new THREE.Vector3();
  {
    const [w, h, d] = A.size;
    dark.add(new RoundedBoxGeometry(w, h, d, 2, 0.012), mul(AM, mat([0, h / 2 + 0.012, 0])), "#1c1b1a");
    soft.add(new THREE.BoxGeometry(w - 0.04, h - 0.09, 0.004), mul(AM, mat([0, (h - 0.09) / 2 + 0.03, d / 2 + 0.001])), "#8a8377");
    metal.add(new THREE.BoxGeometry(w - 0.04, 0.04, 0.004), mul(AM, mat([0, h - 0.02, d / 2 + 0.001])), "#b5b2aa");
    for (let i = 0; i < 5; i++) dark.add(new THREE.CylinderGeometry(0.008, 0.009, 0.012, 12).rotateX(Math.PI / 2), mul(AM, mat([-0.12 + i * 0.045, h - 0.02, d / 2 + 0.008])), "#efe8d8");
    dark.add(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 10).rotateX(Math.PI / 2), mul(AM, mat([0.14, h - 0.02, d / 2 + 0.006])), "#0c0c0c"); // input jack
    ampLed.copy(tp(AM, [0.115, h - 0.02, d / 2 + 0.004]));
    leds.add(new THREE.CircleGeometry(0.005, 10), mul(AM, mat([0.115, h - 0.02, d / 2 + 0.0035])), "#ff4a3a");
    dark.rod(tp(AM, [-0.08, h + 0.02, 0]), tp(AM, [0.08, h + 0.02, 0]), 0.008, "#121212", 8); // handle
    for (const sx of [-1, 1]) dark.box([0.015, 0.02, 0.015], tp(AM, [sx * 0.08, h + 0.012, 0]), null, "#121212");
    for (const [sx, sy] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) metal.add(new THREE.SphereGeometry(0.014, 8, 6), mul(AM, mat([sx * (w / 2 - 0.01), 0.012 + sy * h, d / 2 - 0.01])), "#a6a8ab");
  }
  const ampProxy = proxy([A.size[0], A.size[1], A.size[2]], mul(AM, mat([0, A.size[1] / 2 + 0.012, 0])), "booth.amp.proxy");

  // ---- tabla ----------------------------------------------------------------------------------------------
  const TB = B.tabla;
  {
    const rg = TB.rug;
    const rug = new THREE.Mesh(new THREE.BoxGeometry(rg.width, 0.008, rg.depth), new THREE.MeshStandardMaterial({ map: dhurrie(T, rng.fork("dhurrie")), roughness: 0.95 }));
    rug.position.set(rg.pos[0], 0.004, rg.pos[2]);
    rug.name = "booth.tabla.rug";
    rug.receiveShadow = true;
    root.add(rug);
    const cu = TB.cushion;
    soft.add(new RoundedBoxGeometry(cu.size, cu.height, cu.size, 3, 0.03), mat([cu.pos[0], 0.008 + cu.height / 2, cu.pos[2]], qY(4 * DEG)), "#4a5372");
    soft.add(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 10), mat([cu.pos[0], 0.008 + cu.height + 0.001, cu.pos[2]]), "#c4b79c"); // tuft
  }
  const ringR = TB.ring / 2;
  const headsTex = headsAtlas(T, rng.fork("heads"));
  /** Returns { M (drum frame, origin at the floor), headY, headR, mesh } */
  function tablaDrum(cfg, kind) {
    const dayan = kind === "dayan";
    const tilt = dayan ? -(cfg.tilt || 0) * DEG : 0;
    soft.add(new THREE.TorusGeometry(ringR - 0.022, 0.022, 8, 24).rotateX(Math.PI / 2), mat([cfg.pos[0], 0.008 + 0.02, cfg.pos[2]]), "#5b3b35");
    const M = mul(mat([cfg.pos[0], 0.008 + 0.03, cfg.pos[2]]), mat([0, 0, 0], qAxis(1, 0, 0, tilt)));
    const r = cfg.diameter / 2, h = cfg.height;
    let prof;
    if (dayan) {
      prof = [[0, 0], [r + 0.006, 0], [r + 0.012, h * 0.35], [r + 0.006, h * 0.75], [r, h - 0.004], [r - 0.002, h]];
      wood.add(lathe(prof, 28), M, "#6b3f22");
      dark.add(new THREE.TorusGeometry(r + 0.003, 0.007, 6, 28).rotateX(Math.PI / 2), mul(M, mat([0, h - 0.003, 0])), "#2e1d12"); // gajra
      dark.add(new THREE.TorusGeometry(r - 0.004, 0.006, 6, 24).rotateX(Math.PI / 2), mul(M, mat([0, 0.012, 0])), "#2e1d12");
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        const pTop = [c * (r + 0.006), h - 0.006, s * (r + 0.006)];
        const pMid = [c * (r + 0.016), h * 0.35, s * (r + 0.016)];
        const pBot = [c * (r - 0.002), 0.014, s * (r - 0.002)];
        dark.rod(tp(M, pTop), tp(M, pMid), 0.0024, "#3a2618", 4, false);
        dark.rod(tp(M, pMid), tp(M, pBot), 0.0024, "#3a2618", 4, false);
      }
      for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * Math.PI * 2;
        wood.add(new THREE.CylinderGeometry(0.011, 0.012, 0.045, 10), mul(M, mat([Math.cos(a) * (r + 0.024), h * 0.2, Math.sin(a) * (r + 0.024)])), "#9a7a52");
      }
    } else {
      prof = [[0, 0], [r * 0.45, 0], [r * 0.85, h * 0.12], [r * 1.12, h * 0.42], [r * 1.08, h * 0.72], [r * 1.0, h - 0.004], [r - 0.002, h]];
      metal.add(lathe(prof, 32), M, "#d99c6a");
      dark.add(new THREE.TorusGeometry(r + 0.002, 0.008, 6, 32).rotateX(Math.PI / 2), mul(M, mat([0, h - 0.003, 0])), "#2e1d12");
      dark.add(new THREE.TorusGeometry(r * 0.45, 0.006, 6, 20).rotateX(Math.PI / 2), mul(M, mat([0, 0.008, 0])), "#2e1d12");
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        dark.rod(tp(M, [c * (r + 0.004), h - 0.008, s * (r + 0.004)]), tp(M, [c * (r * 1.13 + 0.003), h * 0.42, s * (r * 1.13 + 0.003)]), 0.0018, "#3a2618", 4, false);
        dark.rod(tp(M, [c * (r * 1.13 + 0.003), h * 0.42, s * (r * 1.13 + 0.003)]), tp(M, [c * r * 0.47, 0.01, s * r * 0.47]), 0.0018, "#3a2618", 4, false);
      }
    }
    const hg = new THREE.CircleGeometry(r - 0.001, 40).rotateX(-Math.PI / 2);
    const uv = hg.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5 + (dayan ? 0 : 0.5));
    const hm = new THREE.Mesh(hg, new THREE.MeshStandardMaterial({ map: headsTex, roughness: 0.62, emissive: "#ffd9a0", emissiveIntensity: 0 }));
    hm.name = `booth.tabla.${kind}.head`;
    hm.applyMatrix4(mul(M, mat([0, h + 0.0005, 0])));
    hm.receiveShadow = true;
    root.add(hm);
    const px = proxy([r * 2.3, h + 0.02, r * 2.3], mul(M, mat([0, (h + 0.02) / 2, 0])), `booth.tabla.${kind}.proxy`);
    return { M, h, r, mesh: hm, base: hm.position.clone(), proxy: px };
  }
  const dayan = tablaDrum(TB.dayan, "dayan");
  const bayan = tablaDrum(TB.bayan, "bayan");

  // ---- mic stands, mics, cables ---------------------------------------------------------------------------
  const MS = B.mics;
  const standCol = "#1c1c1d";
  function micStand(m, kind) {
    const [bx, bz] = m.base;
    dark.add(lathe([[0, 0], [MS.baseDiameter / 2, 0], [MS.baseDiameter / 2, 0.008], [MS.baseDiameter / 2 - 0.02, 0.018], [0.02, 0.024], [0, 0.024]], 28), mat([bx, 0, bz]), "#202022");
    const top = v3([bx, m.tubeTop, bz]);
    dark.rod([bx, 0.02, bz], top, kind === "kick" ? 0.01 : 0.011, standCol, 10);
    if (kind !== "kick") dark.add(new THREE.CylinderGeometry(0.016, 0.016, 0.035, 12), mat([bx, m.tubeTop * 0.55, bz]), "#2a2a2c"); // clutch
    const mic = v3(m.mic);
    dark.add(new THREE.SphereGeometry(0.016, 10, 8), mat(top), "#2a2a2c");
    let clip;
    if (kind === "oh") {
      // boom up to above the mic, counterweight behind, pencil condenser hanging down toward the kit
      const end = mic.clone().add(new THREE.Vector3(0, 0.1, 0));
      const dir = new THREE.Vector3().subVectors(end, top).normalize();
      dark.rod(top, end, 0.0085, standCol, 8);
      const back = top.clone().addScaledVector(dir, -0.22);
      dark.rod(top, back, 0.0085, standCol, 8);
      dark.add(new THREE.CylinderGeometry(0.024, 0.024, 0.07, 14), mat(back, new THREE.Quaternion().setFromUnitVectors(UP, dir)), "#151515");
      clip = end;
      const aim = new THREE.Vector3(1.95, 0.9, -4.0).sub(mic).normalize(); // toward the kit centre
      const q = new THREE.Quaternion().setFromUnitVectors(UP, aim.clone().negate());
      dark.rod(end, mic.clone().addScaledVector(aim, -0.06), 0.005, "#2a2a2c", 6);
      metal.add(new THREE.CylinderGeometry(0.0105, 0.0105, 0.12, 14), mat(mic, q), "#a9abae");
      dark.add(new THREE.CylinderGeometry(0.0108, 0.0108, 0.028, 14), mat(mic.clone().addScaledVector(aim, 0.05), q), "#2c2d2f");
      dark.add(new THREE.CylinderGeometry(0.0108, 0.0108, 0.01, 14), mat(mic.clone().addScaledVector(aim, -0.055), q), "#2c2d2f");
    } else if (kind === "kick") {
      const back = mic.clone().add(new THREE.Vector3(-0.08, 0, 0));
      dark.rod(top, back, 0.008, standCol, 8);
      const q = qAxis(0, 0, 1, -Math.PI / 2); // lathe axis y -> +x (toward the kick)
      dark.add(lathe([[0, -0.07], [0.022, -0.068], [0.033, -0.04], [0.036, 0.0], [0.034, 0.04], [0.025, 0.065], [0, 0.07]], 18), mat(mic, q), "#3a3b3d");
      metal.add(new THREE.TorusGeometry(0.035, 0.003, 6, 18).rotateZ(Math.PI / 2), mat(mic.clone().add(new THREE.Vector3(0.02, 0, 0))), "#8a8c90");
    } else {
      // vocal / instrument: large-diaphragm condenser in a shock mount, facing the standing spot
      const mount = mic.clone().add(new THREE.Vector3(0, -0.11, 0));
      const dir = new THREE.Vector3().subVectors(mount, top).normalize();
      dark.rod(top, mount, 0.0085, standCol, 8);
      const back = top.clone().addScaledVector(dir, -0.2);
      dark.rod(top, back, 0.0085, standCol, 8);
      dark.add(new THREE.CylinderGeometry(0.022, 0.022, 0.06, 14), mat(back, new THREE.Quaternion().setFromUnitVectors(UP, dir)), "#151515");
      metal.add(new THREE.TorusGeometry(0.05, 0.004, 6, 24).rotateX(Math.PI / 2), mat(mic.clone().add(new THREE.Vector3(0, -0.03, 0))), "#8f9296");
      metal.add(new THREE.TorusGeometry(0.05, 0.004, 6, 24).rotateX(Math.PI / 2), mat(mic.clone().add(new THREE.Vector3(0, -0.085, 0))), "#8f9296");
      dark.rod(mount, mic.clone().add(new THREE.Vector3(0, -0.085, 0)), 0.006, "#2a2a2c", 6);
      dark.add(new THREE.CylinderGeometry(0.026, 0.024, 0.12, 18), mat(mic.clone().add(new THREE.Vector3(0, -0.04, 0))), "#2e2f33");
      metal.add(new THREE.CylinderGeometry(0.0275, 0.0275, 0.05, 18, 1, true), mat(mic.clone().add(new THREE.Vector3(0, 0.045, 0))), "#c7c9cc");
      metal.add(new THREE.SphereGeometry(0.0275, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(mic.clone().add(new THREE.Vector3(0, 0.07, 0))), "#c7c9cc");
    }
    return clip;
  }
  micStand(MS.ohA, "oh");
  micStand(MS.ohB, "oh");
  micStand(MS.kick, "kick");
  micStand(MS.vocal, "vocal");
  {
    // floor cable runs (y just above the floor; on the drum rug a hair higher)
    const onRug = (x, z) => x > 1.25 && x < 2.85 && z > -4.8 && z < -3.2;
    const run = (pts, r = 0.0035) => {
      const v = pts.map(([x, z, y]) => new THREE.Vector3(x, y != null ? y : onRug(x, z) ? 0.012 + r : 0.002 + r, z));
      const curve = new THREE.CatmullRomCurve3(v, false, "centripetal");
      dark.add(new THREE.TubeGeometry(curve, Math.max(12, pts.length * 10), r, 4, false), null, "#111112");
    };
    const c = B.cart;
    const cx = c.pos[0] - c.width / 2 + 0.03, cz0 = c.pos[2] - c.depth / 2;
    run([[MS.ohA.base[0] + 0.05, MS.ohA.base[1] - 0.04], [1.32, -4.93], [1.9, -4.955], [2.5, -4.95], [cx + 0.04, cz0 + 0.03], [cx + 0.04, cz0 + 0.06, 0.3]]);
    run([[MS.kick.base[0] - 0.06, MS.kick.base[1] - 0.04], [1.355, -4.2], [1.35, -4.75], [1.5, -4.972], [2.3, -4.975], [cx + 0.07, cz0 + 0.02], [cx + 0.07, cz0 + 0.06, 0.3]]);
    run([[MS.vocal.base[0] + 0.08, MS.vocal.base[1] - 0.03], [1.0, -4.9], [1.3, -4.975], [1.6, -4.985], [2.2, -4.99], [cx + 0.1, cz0 + 0.015], [cx + 0.1, cz0 + 0.06, 0.3]]);
    run([[MS.ohB.base[0] + 0.03, MS.ohB.base[1] - 0.06], [2.965, -3.98], [2.97, -4.2], [c.pos[0] + 0.1, cz0 + c.depth + 0.03], [c.pos[0] + 0.1, cz0 + c.depth - 0.03, 0.3]]);
    // electric guitar -> amp input; sustain pedal -> keyboard back
    const jack = el.jack, inp = tp(AM, [0.14, A.size[1] - 0.02, A.size[2] / 2 + 0.01]);
    run([[jack.x, jack.z, jack.y], [jack.x + 0.06, jack.z + 0.03, 0.06], [0.4, -3.1], [0.36, -2.85], [inp.x + 0.05, inp.z, 0.1], [inp.x, inp.z, inp.y]], 0.003);
    const P = B.pedal.pos;
    run([[P[0] - 0.02, P[2] - 0.1, 0.01], [0.36, -4.78], [0.16, -4.8], [0.1, -4.7, 0.25], [0.1, -4.6, K.topY - 0.06]], 0.003);
  }

  // ---- cart: laptop, monitors, interface, headphones ------------------------------------------------------
  const CT = B.cart;
  const [cx, , cz] = CT.pos, cw = CT.width, cd = CT.depth;
  {
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = cx + sx * (cw / 2 - 0.02), z = cz + sz * (cd / 2 - 0.02);
      dark.rod([x, 0.07, z], [x, CT.topY - 0.01, z], 0.011, "#2a2b2d", 10);
      dark.add(new THREE.CylinderGeometry(0.028, 0.028, 0.022, 14).rotateZ(Math.PI / 2), mat([x, 0.03, z]), "#141414"); // caster wheel
      metal.box([0.016, 0.04, 0.04], [x, 0.055, z], null, "#7d8084");
    }
    wood.add(new RoundedBoxGeometry(cw, 0.022, cd, 2, 0.005), mat([cx, CT.topY, cz]), "#7a5a3c");
    wood.add(new RoundedBoxGeometry(cw - 0.01, 0.018, cd - 0.01, 2, 0.004), mat([cx, CT.shelfY, cz]), "#7a5a3c");
    dark.box([cw - 0.01, 0.012, cd - 0.01], [cx, 0.14, cz], null, "#2a2b2d");
    // interface on the shelf, front facing west
    const IM = mat([cx - 0.02, CT.shelfY + 0.009 + 0.025, cz + 0.05], qY(-Math.PI / 2));
    metal.add(new RoundedBoxGeometry(0.19, 0.05, 0.12, 2, 0.008), IM, "#55585d");
    for (const x of [-0.06, 0.0]) dark.add(new THREE.CylinderGeometry(0.011, 0.012, 0.01, 14).rotateX(Math.PI / 2), mul(IM, mat([x, 0.004, 0.064])), "#1e1f21");
    for (const x of [-0.06, 0.0]) leds.add(new THREE.RingGeometry(0.0125, 0.0145, 18), mul(IM, mat([x, 0.004, 0.0605])), "#55e08a");
    dark.add(new THREE.CylinderGeometry(0.018, 0.019, 0.012, 16).rotateX(Math.PI / 2), mul(IM, mat([0.06, 0.004, 0.064])), "#1e1f21");
    for (const x of [-0.08, 0.035]) dark.add(new THREE.CylinderGeometry(0.009, 0.009, 0.006, 12).rotateX(Math.PI / 2), mul(IM, mat([x, -0.012, 0.061])), "#0c0c0c");
    // headphones on a hook on the cart's south side
    const hz = cz + cd / 2;
    metal.rod([cx, CT.topY - 0.05, hz], [cx, CT.topY - 0.05, hz + 0.05], 0.004, "#8a8c90", 6);
    const hy = CT.topY - 0.06;
    dark.add(new THREE.TorusGeometry(0.085, 0.011, 8, 22, Math.PI), mat([cx, hy - 0.085, hz + 0.05]), "#1a1a1b");
    for (const sx of [-1, 1]) {
      dark.add(new THREE.CylinderGeometry(0.048, 0.046, 0.04, 20).rotateZ(Math.PI / 2), mat([cx + sx * 0.088, hy - 0.115, hz + 0.05]), "#1e1e20");
      soft.add(new THREE.TorusGeometry(0.036, 0.012, 6, 18).rotateY(Math.PI / 2), mat([cx + sx * 0.066, hy - 0.115, hz + 0.05]), "#2c2c2e");
    }
  }
  // laptop: base + lid, screen faces the throne
  const throne = layout.drums ? [layout.drums.origin[0], layout.drums.origin[2]] : [2.45, -4.0];
  const lapPos = v3([cx - 0.02, CT.topY + 0.011, cz + 0.02]);
  const lapYaw = Math.atan2(throne[0] - lapPos.x, throne[1] - lapPos.z) * 0.8; // toward the throne, softened
  const LM = mat(lapPos, qY(lapYaw));
  const lapW = 0.29, lapD = 0.2;
  metal.add(new RoundedBoxGeometry(lapW, 0.014, lapD, 2, 0.005), mul(LM, mat([0, 0.007, 0])), "#8d9095");
  dark.add(new THREE.PlaneGeometry(lapW - 0.03, 0.1).rotateX(-Math.PI / 2), mul(LM, mat([0, 0.0142, -0.02])), "#202124");
  const lidQ = qAxis(1, 0, 0, -15 * DEG);
  const LidM = mul(LM, mat([0, 0.014, -lapD / 2 + 0.004], lidQ));
  metal.add(new RoundedBoxGeometry(lapW, 0.19, 0.007, 2, 0.003), mul(LidM, mat([0, 0.095, -0.0035])), "#8d9095");
  dark.add(new THREE.PlaneGeometry(lapW - 0.006, 0.186), mul(LidM, mat([0, 0.095, 0.0002])), "#0d0d0e");
  const scr = T.screen(512, 320);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(lapW - 0.02, 0.17), new THREE.MeshBasicMaterial({ map: scr.texture, toneMapped: false }));
  screen.name = "booth.laptop.screen";
  screen.applyMatrix4(mul(LidM, mat([0, 0.099, 0.0006])));
  root.add(screen);
  // monitors at the ends of the top, toed in toward the throne
  for (const sz of [-1, 1]) {
    const p = v3([cx + 0.02, CT.topY + 0.011, cz + sz * (cd / 2 - 0.065)]);
    const yaw = Math.atan2(throne[0] - p.x, throne[1] - p.z);
    const MM = mat(p, qY(yaw));
    soft.add(new THREE.BoxGeometry(0.1, 0.012, 0.12), mul(MM, mat([0, 0.006, 0])), "#2a2a2c"); // iso pad
    dark.add(new RoundedBoxGeometry(0.11, 0.19, 0.14, 2, 0.01), mul(MM, mat([0, 0.012 + 0.095, 0])), "#1d1d1f");
    dark.add(lathe([[0.042, -0.002], [0.04, 0.0], [0.03, -0.008], [0.012, -0.012], [0, -0.01]], 20).rotateX(Math.PI / 2), mul(MM, mat([0, 0.075, 0.0705])), "#38393c");
    dark.add(new THREE.SphereGeometry(0.012, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), mul(MM, mat([0, 0.155, 0.07])), "#4a4b4e");
    leds.add(new THREE.CircleGeometry(0.003, 8), mul(MM, mat([0.04, 0.03, 0.0706])), "#e8f2ff");
  }
  const cartProxy = proxy([cw + 0.02, CT.topY + 0.25, cd + 0.02], mat([cx, (CT.topY + 0.25) / 2, cz]), "booth.cart.proxy");

  // ---- merge buckets ---------------------------------------------------------------------------------------
  const weave = T.weave ? T.weave({ size: 256, color: "#8a8a8a", threads: 40, kind: "plain", repeat: [4, 4], rng: rng.fork("weave") }) : null;
  if (weave) weave.map.dispose();
  const metalMesh = metal.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75 }), "booth.metal");
  const woodMesh = wood.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.02 }), "booth.wood");
  const darkMesh = dark.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }), "booth.dark");
  const softMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const acMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97 });
  if (weave) {
    softMat.bumpMap = acMat.bumpMap = weave.bumpMap;
    softMat.bumpScale = acMat.bumpScale = 0.6;
  }
  const softMesh = soft.mesh(softMat, "booth.soft");
  const acMesh = acoustic.mesh(acMat, "booth.acoustic");
  const ledMesh = leds.mesh(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), "booth.leds");
  for (const m of [metalMesh, woodMesh, darkMesh, softMesh]) m.castShadow = m.receiveShadow = true;
  acMesh.receiveShadow = true;
  root.add(metalMesh, woodMesh, darkMesh, softMesh, acMesh, ledMesh);

  // ---- light ----------------------------------------------------------------------------------------------
  const LT = B.light;
  const lamp = new THREE.PointLight(LT.color, LT.intensity, LT.distance, LT.decay);
  lamp.position.fromArray(LT.pos);
  lamp.castShadow = false;
  lamp.name = "booth.light";
  root.add(lamp);
  let lampNight = -1;
  const applyNight = (night) => {
    if (Math.abs(night - lampNight) < 0.01) return;
    lampNight = night;
    lamp.intensity = LT.intensity * (0.75 + 0.6 * night);
  };
  applyNight(typeof (ctx.time ?? NO_TIME).night === "number" ? (ctx.time ?? NO_TIME).night : 0);

  scene.add(root);
  strings.computeBoundingSphere();

  // ---- laptop multitrack view -------------------------------------------------------------------------------
  const TRACKS = [["KICK", "#d9734a"], ["SNARE", "#d9a54a"], ["OH L", "#6fae8f"], ["OH R", "#6fae8f"], ["TABLA", "#b07ad0"], ["KEYS", "#5f9fd8"]];
  const SW = 512, SH = 320, HEAD = 96, TOP = 30, LANE = (SH - TOP - 8) / TRACKS.length;
  const bgCanvas = T.makeCanvas(SW, SH);
  {
    const c = bgCanvas.ctx;
    const r = rng.fork("waves");
    c.fillStyle = "#17191d";
    c.fillRect(0, 0, SW, SH);
    c.fillStyle = "#23262c";
    c.fillRect(0, 0, SW, TOP - 2);
    c.fillStyle = "#8b9099";
    c.font = `600 12px ${MONO}`;
    c.textBaseline = "middle";
    c.fillText("BPM 92   4/4", 330, TOP / 2);
    for (let x = HEAD; x < SW; x += 26) {
      c.fillStyle = (x - HEAD) % 104 === 0 ? "#3a3f48" : "#262a31";
      c.fillRect(x, TOP, 1, SH - TOP);
    }
    TRACKS.forEach(([name, col], i) => {
      const y = TOP + i * LANE;
      c.fillStyle = i % 2 ? "#1b1e23" : "#1e2127";
      c.fillRect(0, y, HEAD - 2, LANE - 2);
      c.fillStyle = col;
      c.fillRect(0, y, 4, LANE - 2);
      c.fillStyle = "#c9ced6";
      c.font = `600 11px ${MONO}`;
      c.fillText(name, 10, y + 12);
      c.fillStyle = "#3a3f48";
      c.fillRect(10, y + 24, 14, 10);
      c.fillRect(28, y + 24, 14, 10);
      // clips with waveforms
      let x = HEAD + 6 + Math.floor(r() * 30);
      while (x < SW - 40) {
        const w = 60 + Math.floor(r() * 120);
        const x1 = Math.min(SW - 6, x + w);
        c.fillStyle = col + "40";
        c.fillRect(x, y + 3, x1 - x, LANE - 8);
        c.fillStyle = col + "c0";
        c.fillRect(x, y + 3, x1 - x, 2);
        const mid = y + 3 + (LANE - 6) / 2;
        const hits = i < 2 || i === 4;
        for (let px = x + 1; px < x1 - 1; px += 2) {
          const ph = ((px - x) % (i === 0 ? 26 : 13)) / (i === 0 ? 26 : 13);
          const env = hits ? Math.exp(-ph * 5) : 0.35 + 0.35 * Math.sin(px * 0.05 + i);
          const a = (LANE - 12) / 2 * Math.min(1, env * (0.6 + r() * 0.4));
          c.fillStyle = col;
          c.fillRect(px, mid - a, 1, a * 2);
        }
        x = x1 + 10 + Math.floor(r() * 40);
      }
    });
  }
  const DIGITS = "0123456789".split("");
  const sc = scr.ctx;
  const levels = new Float32Array(TRACKS.length);
  let recording = false, playX = HEAD + 40, recFrom = -1, recSeconds = 0;
  let screenNext = 0, screenDirty = true;
  const meterRng = rng.fork("meters");
  const meterNoise = new Float32Array(64);
  for (let i = 0; i < 64; i++) meterNoise[i] = meterRng();
  let meterIdx = 0;
  function drawScreen() {
    sc.drawImage(bgCanvas.canvas, 0, 0);
    // transport: REC button, time
    sc.fillStyle = recording ? (Math.floor(recSeconds * 2) % 2 ? "#ff3b30" : "#c42a22") : "#4a2a2a";
    sc.beginPath();
    sc.arc(16, TOP / 2, 7, 0, Math.PI * 2);
    sc.fill();
    sc.fillStyle = "#3a3f48";
    sc.fillRect(30, TOP / 2 - 6, 12, 12);
    sc.fillStyle = recording ? "#ff8a80" : "#c9ced6";
    sc.font = `600 14px ${MONO}`;
    sc.textBaseline = "middle";
    const s = Math.floor(recSeconds);
    const mm = Math.floor(s / 60) % 100, ss = s % 60;
    sc.fillText(DIGITS[Math.floor(mm / 10)], 56, TOP / 2);
    sc.fillText(DIGITS[mm % 10], 65, TOP / 2);
    sc.fillText(":", 74, TOP / 2);
    sc.fillText(DIGITS[Math.floor(ss / 10)], 83, TOP / 2);
    sc.fillText(DIGITS[ss % 10], 92, TOP / 2);
    // recorded region
    if (recording && recFrom >= 0) {
      sc.fillStyle = "rgba(255,59,48,0.16)";
      sc.fillRect(recFrom, TOP, Math.max(0, playX - recFrom), SH - TOP - 6);
    }
    // meters in the track headers
    for (let i = 0; i < TRACKS.length; i++) {
      const y = TOP + i * LANE;
      const l = Math.min(1, levels[i]);
      sc.fillStyle = "#0f1114";
      sc.fillRect(50, y + 24, 40, 8);
      sc.fillStyle = l > 0.85 ? "#ff5a4a" : l > 0.6 ? "#e8c84a" : "#4ccf7a";
      sc.fillRect(50, y + 24, 40 * l, 8);
    }
    // playhead
    sc.fillStyle = recording ? "#ff4a3d" : "#e8eaee";
    sc.fillRect(playX, TOP - 4, 2, SH - TOP);
    scr.texture.needsUpdate = true;
  }
  drawScreen();

  // ---- interaction ------------------------------------------------------------------------------------------
  const NEVER = -1e9;
  let now = 0;
  const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _s = new THREE.Vector3();
  const drums2 = [dayan, bayan];
  const headHitAt = [NEVER, NEVER];
  const stringHitAt = [NEVER, NEVER];
  let headsLive = false, stringsLive = false, keyLightAt = NEVER;
  const KMinv = new THREE.Matrix4().copy(KM).invert();
  const keyQ = new THREE.Quaternion().setFromRotationMatrix(KM);
  const bump = (i, a) => {
    levels[i] = Math.min(1, levels[i] + a);
    screenDirty = true;
  };

  function playTabla(hit) {
    const isDayan = hit.object === dayan.proxy;
    const d = isDayan ? dayan : bayan;
    let kind = "tabla-ge";
    if (isDayan) {
      // rim (outer third of the head) = "na", nearer the syahi = "tin"
      _v.copy(hit.point || d.mesh.position);
      const dx = _v.x - d.mesh.position.x, dz = _v.z - d.mesh.position.z;
      kind = Math.hypot(dx, dz) > d.r * 0.62 ? "tabla-na" : "tabla-tin";
    }
    audio.hit(kind, 0.85);
    headHitAt[isDayan ? 0 : 1] = now;
    headsLive = true;
    bump(4, 0.75);
    return true;
  }
  function playKeys(hit) {
    _v.copy(hit.point || keysProxy.position).applyMatrix4(KMinv);
    const u = Math.min(N_WHITE - 1e-4, Math.max(0, ((_v.x + keysW / 2) / keysW) * N_WHITE));
    const wi = Math.floor(u), frac = u - wi;
    const zBack = K.depth / 2 - 0.004 - keysD; // back edge of the key bed (local z)
    const inBlackRow = _v.z < zBack + keysD * BLACK_D;
    let midi = 36 + Math.floor(wi / 7) * 12 + WHITE_SEMI[wi % 7];
    let black = 0; // −1: black key left of this white key, +1: right
    if (inBlackRow) {
      if (frac > 1 - BLACK_W / 2 && HAS_BLACK[wi % 7] && wi < N_WHITE - 1) black = 1;
      else if (frac < BLACK_W / 2 && wi > 0 && HAS_BLACK[(wi - 1) % 7]) black = -1;
    }
    midi += black;
    audio.hit(`ep${midi}`, 0.8);
    const kw = keysW / N_WHITE;
    const cxk = black ? (wi + (black > 0 ? 1 : 0)) * kw - keysW / 2 : (wi + 0.5) * kw - keysW / 2;
    const len = black ? keysD * BLACK_D : keysD;
    const zc = black ? zBack + len / 2 : zBack + keysD / 2;
    _v.set(cxk, keyTop + (black ? 0.0016 : 0.0012), zc).applyMatrix4(KM);
    _s.set(black ? kw * BLACK_W : kw * 0.92, 1, len);
    _m.compose(_v, keyQ, _s);
    keyLight.matrixAutoUpdate = false;
    keyLight.matrix.copy(_m);
    keyLight.matrixWorldNeedsUpdate = true;
    keyLight.visible = true;
    keyLightAt = now;
    bump(5, 0.7);
    return true;
  }
  function playGuitar(i) {
    audio.hit(i === 0 ? "guitar" : "eguitar", 0.85);
    stringHitAt[i] = now;
    stringsLive = true;
    bump(2, 0.55);
    bump(3, 0.5);
    return true;
  }
  function setRecording(on) {
    recording = !!on;
    if (recording) {
      recSeconds = 0;
      recFrom = playX;
    }
    recMat.emissiveIntensity = recording ? 2.4 : 0.04;
    screenDirty = true;
    return recording;
  }

  // door
  let doorTarget = D.startOpen ? 1 : 0, doorPos = doorTarget;
  const doorCollider = { x: 0, z: D.z, w: leafW, d: D.thickness + 0.02, rotY: 0, y0: 0, y1: D.height };
  const door = {
    openness: doorPos,
    toggle() {
      doorTarget = doorTarget > 0.5 ? 0 : 1;
      return doorTarget === 1;
    },
    open() {
      doorTarget = 1;
    },
    close() {
      doorTarget = 0;
    },
    isOpen: () => doorTarget > 0.5,
  };
  const ease = (u) => u * u * (3 - 2 * u);
  function placeDoor() {
    const x = closedX + D.slide * ease(doorPos);
    leaf.position.x = x;
    leafProxy.visible = doorPos < 0.5;
    doorCollider.x = x;
    door.openness = doorPos;
  }
  placeDoor();

  const LBL = { label: "" }; // reused resolve() result (hover runs at ~20 Hz)
  const lbl = (text) => ((LBL.label = text), LBL);
  const hotspots = [
    { zone: null, label: "tabla", objects: [dayan.proxy, bayan.proxy], onActivate: playTabla },
    { zone: null, label: "acoustic guitar", objects: [acProxy], onActivate: () => playGuitar(0) },
    { zone: null, label: "electric guitar", objects: [elProxy, ampProxy], onActivate: () => playGuitar(1) },
    { zone: null, label: "keys", objects: [keysProxy], onActivate: playKeys },
    { zone: null, label: "record", objects: [cartProxy], onActivate: () => (setRecording(!recording), true),
      resolve: () => lbl(recording ? "recording · stop" : "record") },
    { zone: null, label: "booth door · close", objects: [leafProxy, edgeProxy, leafFrameMesh, doorwayProxy], onActivate: () => (door.toggle(), true),
      resolve: () => lbl(doorTarget > 0.5 ? "booth door · close" : "booth door · open") },
  ];
  // test / debug handle (window.__room.objects.booth.userData.booth)
  root.userData.booth = { door, setRecording, isRecording: () => recording, doorCollider };

  // ---- update: eased, allocation-free ----
  function update(dt, t) {
    now = t;
    if (doorPos !== doorTarget) {
      const step = dt / D.seconds;
      doorPos = doorTarget > doorPos ? Math.min(doorTarget, doorPos + step) : Math.max(doorTarget, doorPos - step);
      placeDoor();
    }
    if (headsLive) {
      let any = false;
      for (let i = 0; i < 2; i++) {
        const s = t - headHitAt[i];
        const d = drums2[i];
        let e = 0;
        if (s >= 0 && s < 0.6) {
          const u = s / 0.03;
          e = u * Math.exp(1 - u);
          any = true;
        }
        d.mesh.position.copy(d.base);
        d.mesh.position.y -= 0.0025 * e;
        d.mesh.material.emissiveIntensity = 0.22 * Math.exp(-Math.max(0, s) / 0.12) * (s >= 0 && s < 0.6 ? 1 : 0);
      }
      headsLive = any;
    }
    if (stringsLive) {
      let any = false;
      for (let i = 0; i < 2; i++) {
        const s = t - stringHitAt[i];
        const b = stringBase[i];
        _s.copy(b.s);
        if (s >= 0 && s < 1.6 && !ctx.reducedMotion) {
          _s.x *= 1 + 0.35 * Math.exp(-s / 0.35) * Math.abs(Math.sin(s * 70));
          any = true;
        }
        _m.compose(b.p, b.q, _s);
        strings.setMatrixAt(i, _m);
      }
      strings.instanceMatrix.needsUpdate = true;
      stringsLive = any;
    }
    if (keyLight.visible) {
      const s = t - keyLightAt;
      if (s > 0.45 || s < 0) keyLight.visible = false;
      else keyLight.material.opacity = 0.55 * (1 - s / 0.45);
    }
    if (recording) {
      recSeconds += dt;
      playX += dt * 14;
      if (playX > SW - 4) {
        playX = HEAD + 2;
        recFrom = playX;
      }
      recMat.emissiveIntensity = 2.0 + 0.4 * Math.sin(t * 3.2);
    }
    if (t >= screenNext && (recording || screenDirty)) {
      screenNext = t + 0.125; // <= 8 Hz
      let active = false;
      for (let i = 0; i < levels.length; i++) {
        if (recording) {
          meterIdx = (meterIdx + 1) & 63;
          const base = i < 4 ? 0.35 : 0.15;
          levels[i] = Math.max(levels[i] * 0.55, base * (0.5 + meterNoise[meterIdx]));
        } else levels[i] *= 0.55;
        if (levels[i] > 0.01) active = true;
      }
      screenDirty = active;
      drawScreen();
    }
    const tm = ctx.time ?? NO_TIME;
    applyNight(typeof tm.night === "number" ? tm.night : 0);
  }

  return { root, update, hotspots, dynamicColliders: [doorCollider], door };
}
