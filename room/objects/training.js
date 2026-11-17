// objects/training.js — "Truth in the Wild." corner: ceiling beam + gymnastic rings on webbing straps,
// Swedish bar with dip belt, three kettlebells, two dumbbell pairs, bumper-plate stack and the tatami mat.
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots }.
//
// Draw calls (main pass): beam 1, rails 1, rungs 1, static metal 1, chain 1, rubber/leather 1, kettlebells 1,
// rings 2 x (strap, buckle, wood) = 6, mat 2 = 15. Shadow casters: rails, rungs, 2 rings.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const PI = Math.PI;

// ---- small geometry helpers (build-time only) -------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Apply position / euler rotation / scale to a geometry in place. */
function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  _m.compose(_p.set(p[0], p[1], p[2]), _q, _s.set(s[0], s[1], s[2]));
  return g.applyMatrix4(_m);
}

const flat = (g) => (g.index ? g.toNonIndexed() : g);

/** Per-vertex colour attribute (linear working space, like Color). */
function tint(g, hex) {
  const c = new THREE.Color(hex);
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

/** Hard-edged copy: non-indexed with per-face normals. */
function faceted(g) {
  const f = flat(g);
  f.computeVertexNormals();
  return f;
}

/**
 * Box-projected UVs so wood grain runs along `axis` regardless of how the box is oriented.
 * u = position along axis / su, v = the other in-face coordinate / sv (+ offsets for per-piece variety).
 */
function boxUV(g, axis, su, sv, ou = 0, ov = 0) {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  const ai = { x: 0, y: 1, z: 2 }[axis];
  const others = [0, 1, 2].filter((k) => k !== ai);
  for (let i = 0; i < pos.count; i++) {
    const P = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const N = [Math.abs(nor.getX(i)), Math.abs(nor.getY(i)), Math.abs(nor.getZ(i))];
    let dom = 0;
    if (N[1] > N[dom]) dom = 1;
    if (N[2] > N[dom]) dom = 2;
    let across;
    if (dom === ai) across = others[0];
    else across = others[0] === dom ? others[1] : others[0];
    uv.setXY(i, P[ai] / su + ou, P[across] / sv + ov + dom * 0.173);
  }
  uv.needsUpdate = true;
  return g;
}

/** Strap webbing piece: flat box with UVs scaled so one weave tile is ~0.04 m square. */
function strapPiece(w, l, t, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, l, t);
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  const k = 1 / 0.04;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    if (nx > 0.5) uv.setXY(i, uv.getX(i) * t * k, uv.getY(i) * l * k);
    else if (ny > 0.5) uv.setXY(i, uv.getX(i) * w * k, uv.getY(i) * t * k);
    else uv.setXY(i, uv.getX(i) * w * k, uv.getY(i) * l * k);
  }
  xf(g, [x, y, z]);
  return tint(flat(g), hex);
}

function mergeOrEmpty(list) {
  return mergeGeometries(list, false);
}

// ---- parts ------------------------------------------------------------------------------------------

/** Kettlebell: flat-based ball (lathe) + half-torus handle + two horns. Local origin on the floor. */
function kettlebellGeometry(d, h) {
  const r = d / 2;
  const yc = 0.86 * r;
  const a0 = Math.acos(yc / r);
  const prof = [new THREE.Vector2(0, 0)];
  const steps = 22;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((PI - a0) * i) / steps;
    prof.push(new THREE.Vector2(Math.max(0.0001, r * Math.sin(a)), yc - r * Math.cos(a)));
  }
  const body = new THREE.LatheGeometry(prof, 40);
  const t = r * 0.15;
  const hr = r * 0.68;
  const yhc = h - hr - t;
  const ys = yc + Math.sqrt(r * r - hr * hr) - 0.014;
  const handle = new THREE.TorusGeometry(hr, t, 10, 24, PI);
  xf(handle, [0, yhc, 0]);
  const parts = [flat(body), flat(handle)];
  for (const sx of [-1, 1]) {
    const horn = new THREE.CylinderGeometry(t, t, yhc - ys, 10, 1, true);
    xf(horn, [sx * hr, (yhc + ys) / 2, 0]);
    parts.push(flat(horn));
  }
  return parts;
}

/** Hex-head dumbbell lying on a flat of its head, long axis along x. Returns { heads[], metal[] }. */
function dumbbellParts(len, R, headT, handleR, headHex) {
  const heads = [];
  const metal = [];
  const y = (Math.sqrt(3) / 2) * R;
  for (const sx of [-1, 1]) {
    const head = new THREE.CylinderGeometry(R, R, headT, 6);
    xf(head, [0, 0, 0], [0, 0, PI / 2]);
    xf(head, [sx * (len / 2 - headT / 2), y, 0]);
    heads.push(tint(faceted(head), headHex));
    // inner shoulder plate: slightly smaller hex, gives the head a stepped, machined look
    const step = new THREE.CylinderGeometry(R * 0.78, R * 0.78, 0.008, 6);
    xf(step, [0, 0, 0], [0, 0, PI / 2]);
    xf(step, [sx * (len / 2 - headT - 0.004), y, 0]);
    heads.push(tint(faceted(step), headHex));
    // chrome end cap
    const cap = new THREE.CylinderGeometry(handleR * 1.5, handleR * 1.5, 0.006, 16);
    xf(cap, [0, 0, 0], [0, 0, PI / 2]);
    xf(cap, [sx * (len / 2 + 0.002), y, 0]);
    metal.push(flat(cap));
  }
  const handle = new THREE.CylinderGeometry(handleR, handleR, len - 0.004, 20);
  xf(handle, [0, 0, 0], [0, 0, PI / 2]);
  xf(handle, [0, y, 0]);
  metal.push(flat(handle));
  // grip knurl bands
  const grip = len - 2 * headT - 0.06;
  for (const f of [-0.5, 0.5]) {
    const band = new THREE.CylinderGeometry(handleR * 1.08, handleR * 1.08, 0.004, 20);
    xf(band, [0, 0, 0], [0, 0, PI / 2]);
    xf(band, [f * grip, y, 0]);
    metal.push(flat(band));
  }
  return { heads, metal, y };
}

/** Bumper plate: bevelled extruded disc with a centre hole, standing on y = 0 .. 0.05. */
function plateGeometry() {
  const R = 0.225 - 0.004;
  const shape = new THREE.Shape();
  shape.absarc(0, 0, R, 0, PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.03, 0, PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.042,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
    curveSegments: 44,
  });
  g.translate(0, 0, 0.004);
  g.rotateX(-PI / 2);
  return flat(g);
}

// ---- build ------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const L = layout.training;
  const rng = ctx.rng.fork("training");
  const T = ctx.textures;

  const root = new THREE.Group();
  root.name = "training";

  // ---- materials ----
  const metalMat = new THREE.MeshStandardMaterial({ color: "#b9bcc0", metalness: 0.9, roughness: 0.34 });
  metalMat.name = "trainingMetal";

  // pine for rails + rungs (grain runs along the rail)
  const pine = T.wood({ kind: "grain", size: 512, color: L.swedishBar.color, grain: 0.55, knots: 0.0, rng: rng.fork("pine") });
  const pineMat = new THREE.MeshStandardMaterial({
    map: pine.map, roughnessMap: pine.roughnessMap, bumpMap: pine.bumpMap, bumpScale: 0.35, roughness: 0.62,
  });
  pineMat.name = "pine";

  // kuri-brown ceiling beam
  const beamTex = T.wood({ kind: "grain", size: 512, color: "#6a4b34", grain: 0.6, knots: 0.0, rng: rng.fork("beam") });
  const beamMat = new THREE.MeshStandardMaterial({
    map: beamTex.map, roughnessMap: beamTex.roughnessMap, bumpMap: beamTex.bumpMap, bumpScale: 0.4, roughness: 0.7,
  });

  // ring wood: grain follows the torus' U (around the ring); squeeze V so only a few boards cross the tube
  const ringTex = T.wood({ kind: "grain", size: 512, color: L.rings.color, grain: 0.5, knots: 0.0, rng: rng.fork("ringwood") });
  for (const tx of [ringTex.map, ringTex.roughnessMap, ringTex.bumpMap]) {
    if (!tx) continue;
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.repeat.set(1, 0.22);
  }
  const ringMat = new THREE.MeshStandardMaterial({
    map: ringTex.map, roughnessMap: ringTex.roughnessMap, bumpMap: ringTex.bumpMap, bumpScale: 0.25, roughness: 0.5,
  });
  ringMat.name = "ringWood";

  // webbing: neutral twill, tinted per vertex (black strap, yellow marker)
  const web = T.weave({ size: 128, color: "#e0e0e0", color2: "#c6c6c6", threads: 16, kind: "twill", contrast: 0.3, rng: rng.fork("web") });
  for (const tx of [web.map, web.bumpMap]) {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  }
  const webMat = new THREE.MeshStandardMaterial({
    color: "#ffffff", map: web.map, bumpMap: web.bumpMap, bumpScale: 0.6, roughness: 0.88, vertexColors: true,
  });
  webMat.name = "webbing";

  // dark rubber / leather, coloured per vertex
  const rubberMat = new THREE.MeshStandardMaterial({
    color: "#ffffff", vertexColors: true, roughness: 0.78, metalness: 0.04, side: THREE.DoubleSide,
  });
  rubberMat.name = "rubberLeather";

  const ironMap = T.noise({ size: 256, color: "#35363b", amount: 0.18, scale: 6, rng: rng.fork("iron") });
  ironMap.wrapS = ironMap.wrapT = THREE.RepeatWrapping;
  const ironMat = new THREE.MeshStandardMaterial({ color: "#ffffff", map: ironMap, metalness: 0.55, roughness: 0.5 });
  ironMat.name = "castIron";

  // ---- ceiling beam + rings ----
  const R = L.rings;
  const beamGeo = new RoundedBoxGeometry(R.beam[0], R.beam[1], R.beam[2], 2, 0.006);
  boxUV(beamGeo, "z", beamTex.worldSize[0], beamTex.worldSize[1], rng.float(0, 1), rng.float(0, 1));
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.name = "ceilingBeam";
  beam.position.set(R.anchor[0], R.beamBottomY + R.beam[1] / 2, R.anchor[2]);
  beam.receiveShadow = true;
  root.add(beam);

  const staticMetal = []; // world-space geometry merged into one draw call
  const staticRubber = [];

  const pivotY = R.beamBottomY; // strap top; rings sway about here
  const ringGroups = [];
  const swayPhase = [0, 1.9];
  R.centers.forEach((c, i) => {
    const g = new THREE.Group();
    g.name = `ringAssembly${i + 1}`;
    g.position.set(c[0], pivotY, R.anchor[2] + (c[2] - R.anchor[2]));
    const ry = (y) => y - pivotY; // world y -> group-local y

    // eye washer fixed to the beam underside, static (world space)
    const washer = new THREE.TorusGeometry(0.027, 0.004, 8, 24);
    xf(washer, [c[0], pivotY - 0.004, c[2]], [PI / 2, 0, 0]);
    staticMetal.push(flat(washer));
    const plate = new THREE.CylinderGeometry(0.037, 0.037, 0.003, 20, 1);
    xf(plate, [c[0], pivotY - 0.0015, c[2]]);
    staticMetal.push(flat(plate));

    // strap: main run, cap over the ring, loop strips, tail + yellow marker
    const ringTop = c[1] + R.radius + R.tube; // 2.118
    const sw = R.strapWidth;
    const st = R.strapThickness;
    const black = "#222224";
    const yellow = "#e6b52f";
    const parts = [];
    const mainTop = 0;
    const mainBottom = ry(ringTop) + 0.0005;
    parts.push(strapPiece(sw, mainTop - mainBottom, st, 0, (mainTop + mainBottom) / 2, 0, black));
    parts.push(strapPiece(sw, 0.0015, 0.0345, 0, ry(ringTop) + 0.00075, 0, black)); // cap over the ring
    for (const sz of [-1, 1]) parts.push(strapPiece(sw, 0.026, 0.0015, 0, ry(ringTop) - 0.012, sz * 0.0155, black));
    const tailTop = ry(R.buckleY - 0.03);
    const markTop = ry(R.tailEndY + R.tailMarker);
    const tailEnd = ry(R.tailEndY);
    parts.push(strapPiece(sw, tailTop - markTop, st, 0, (tailTop + markTop) / 2, 0.0185, black));
    parts.push(strapPiece(sw, markTop - tailEnd, st + 0.0004, 0, (markTop + tailEnd) / 2, 0.0185, yellow));
    const strap = new THREE.Mesh(mergeOrEmpty(parts), webMat);
    strap.name = `strap${i + 1}`;
    strap.castShadow = false;
    g.add(strap);

    // cam buckle
    const bk = new RoundedBoxGeometry(0.05, 0.07, 0.04, 2, 0.006);
    xf(bk, [0, ry(R.buckleY), 0]);
    const pin = new THREE.CylinderGeometry(0.0045, 0.0045, 0.058, 12);
    xf(pin, [0, ry(R.buckleY) + 0.016, 0.019], [0, 0, PI / 2]);
    const cam = new THREE.CylinderGeometry(0.009, 0.009, 0.034, 14);
    xf(cam, [0, ry(R.buckleY) - 0.012, 0.02], [0, 0, PI / 2]);
    const buckle = new THREE.Mesh(mergeOrEmpty([flat(bk), flat(pin), flat(cam)]), metalMat);
    buckle.name = `buckle${i + 1}`;
    g.add(buckle);

    // the ring (plane x–y, as in the layout stub / spec)
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R.radius, R.tube, 16, 56), ringMat);
    ring.name = `ring${i + 1}`;
    ring.position.set(0, ry(c[1]), 0);
    ring.castShadow = true;
    ring.receiveShadow = true;
    g.add(ring);

    // generous invisible pick proxy (material.visible=false: raycastable, never drawn). Torus, not a disc,
    // so the hole stays click-through.
    const proxy = new THREE.Mesh(
      new THREE.TorusGeometry(R.radius, 0.032, 6, 18),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    proxy.name = `ringPick${i + 1}`;
    proxy.position.copy(ring.position);
    g.add(proxy);

    root.add(g);
    ringGroups.push(g);
  });

  // ---- Swedish bar ----
  const SB = L.swedishBar;
  const bar = new THREE.Group();
  bar.name = "swedishBar";
  bar.position.fromArray(SB.pos);
  bar.rotation.y = SB.rotY;
  bar.updateMatrix();
  const barM = bar.matrix.clone();
  const W = (g) => g.applyMatrix4(barM); // bar-local -> world

  const railDepth = SB.rail[2];
  const railZ = -SB.depth / 2 + railDepth / 2 + 0.0; // back face flush to the wall side
  const railBottom = 0.085; // clears the 0.08 m skirting that runs under the bar
  const railH = SB.rail[1] - railBottom;
  const railY = railBottom + railH / 2;
  const railParts = [];
  for (const sx of [-1, 1]) {
    const rail = new RoundedBoxGeometry(SB.rail[0], railH, railDepth, 2, 0.004);
    xf(rail, [sx * SB.railX, railY, railZ]);
    boxUV(rail, "y", pine.worldSize[0], pine.worldSize[1], rng.float(0, 1), rng.float(0, 1));
    railParts.push(rail);
  }
  // arms carrying the forward-offset top rung
  const topRungY = SB.rungStartY + (SB.rungs - 1) * SB.rungSpacing;
  const armLen = SB.topRungForward + 0.015;
  for (const sx of [-1, 1]) {
    const arm = new RoundedBoxGeometry(0.03, 0.03, armLen, 2, 0.004);
    xf(arm, [sx * SB.railX, topRungY, railZ - railDepth / 2 + 0.005 + armLen / 2]);
    boxUV(arm, "z", pine.worldSize[0], pine.worldSize[1], rng.float(0, 1), rng.float(0, 1));
    railParts.push(arm);
  }
  const rails = new THREE.Mesh(mergeOrEmpty(railParts), pineMat);
  rails.name = "swedishBarRails";
  rails.castShadow = true;
  rails.receiveShadow = true;
  bar.add(rails);

  // 14 rungs, one InstancedMesh
  const rungGeo = new THREE.CylinderGeometry(SB.rungRadius, SB.rungRadius, SB.rungLength, 20);
  xf(rungGeo, [0, 0, 0], [0, 0, PI / 2]);
  boxUV(rungGeo, "x", pine.worldSize[0], pine.worldSize[1]);
  const rungs = new THREE.InstancedMesh(rungGeo, pineMat, SB.rungs);
  rungs.name = "swedishBarRungs";
  const tone = new THREE.Color();
  for (let i = 0; i < SB.rungs; i++) {
    const top = i === SB.rungs - 1;
    _m.makeTranslation(0, SB.rungStartY + i * SB.rungSpacing, railZ + (top ? SB.topRungForward : 0));
    rungs.setMatrixAt(i, _m);
    const k = 0.9 + rng.float(0, 0.1);
    rungs.setColorAt(i, tone.setRGB(k, k * 0.985, k * 0.96));
  }
  rungs.instanceMatrix.needsUpdate = true;
  if (rungs.instanceColor) rungs.instanceColor.needsUpdate = true;
  rungs.castShadow = true;
  rungs.receiveShadow = true;
  bar.add(rungs);

  // wall brackets: steel plates screwed across the rails, top and bottom
  const plateZ = railZ + railDepth / 2 + 0.002;
  for (const sx of [-1, 1]) {
    for (const y of [0.14, 2.335]) {
      const pl = new RoundedBoxGeometry(0.034, 0.07, 0.004, 2, 0.0015);
      xf(pl, [sx * SB.railX, y, plateZ]);
      staticMetal.push(W(flat(pl)));
      for (const dy of [-0.022, 0.022]) {
        const sc = new THREE.CylinderGeometry(0.0048, 0.0048, 0.004, 10);
        xf(sc, [sx * SB.railX, y + dy, plateZ + 0.003], [PI / 2, 0, 0]);
        staticMetal.push(W(flat(sc)));
      }
    }
  }

  // dip belt on the 9th rung: leather sheets folded over the rung, D-ring, chain, carabiner
  const beltY = SB.rungStartY + SB.beltRung * SB.rungSpacing;
  const beltZ = railZ;
  const beltW = 0.1;
  const beltLen = 0.3;
  const sheetOff = SB.rungRadius + 0.0045;
  const leather = "#4a2a1b";
  const belt = [];
  for (const sz of [-1, 1]) {
    const sheet = new THREE.BoxGeometry(beltW, beltLen, 0.006);
    xf(sheet, [0, beltY - beltLen / 2, beltZ + sz * sheetOff]);
    belt.push(tint(W(flat(sheet)), leather));
  }
  const wrapTop = new THREE.CylinderGeometry(sheetOff, sheetOff, beltW, 16, 1, true, 0, PI);
  xf(wrapTop, [0, beltY, beltZ], [0, 0, PI / 2]);
  belt.push(tint(W(flat(wrapTop)), leather));
  const wrapBot = new THREE.CylinderGeometry(sheetOff, sheetOff, beltW, 16, 1, true, PI, PI);
  xf(wrapBot, [0, beltY - beltLen, beltZ], [0, 0, PI / 2]);
  belt.push(tint(W(flat(wrapBot)), leather));
  // stitched edge strip + webbing tag colour hint
  for (const sz of [-1, 1]) {
    const stripe = new THREE.BoxGeometry(beltW - 0.016, 0.01, 0.0075);
    xf(stripe, [0, beltY - beltLen + 0.04, beltZ + sz * sheetOff]);
    belt.push(tint(W(flat(stripe)), "#2b1a12"));
  }
  staticRubber.push(...belt);

  const ringBottomY = beltY - beltLen - sheetOff;
  const dring = new THREE.TorusGeometry(0.012, 0.0022, 8, 20);
  xf(dring, [0, ringBottomY + 0.004, beltZ], [0, 0, 0]);
  staticMetal.push(W(flat(dring)));

  // chain: instanced oval links, alternately turned 90 degrees
  const pitch = 0.0155;
  const links = Math.floor(SB.chainLength / pitch);
  const linkGeo = new THREE.TorusGeometry(0.005, 0.0016, 6, 14);
  linkGeo.scale(1, 1.5, 1);
  const chain = new THREE.InstancedMesh(linkGeo, metalMat, links);
  chain.name = "dipChain";
  const chainTop = ringBottomY - 0.006;
  for (let i = 0; i < links; i++) {
    _e.set(0, (i % 2) * (PI / 2), 0);
    _q.setFromEuler(_e);
    _m.compose(_p.set(0, chainTop - i * pitch, beltZ), _q, _s.set(1, 1, 1));
    chain.setMatrixAt(i, _m);
  }
  chain.instanceMatrix.needsUpdate = true;
  bar.add(chain);

  // carabiner
  const caraTop = chainTop - (links - 1) * pitch - 0.012;
  const cara = new THREE.TorusGeometry(0.02, 0.0035, 8, 28);
  cara.scale(0.8, 2.1, 1);
  xf(cara, [0, caraTop - 0.042, beltZ]);
  staticMetal.push(W(flat(cara)));
  const gate = new THREE.CylinderGeometry(0.0022, 0.0022, 0.04, 8);
  xf(gate, [0.0155, caraTop - 0.042, beltZ + 0.0]);
  staticMetal.push(W(flat(gate)));

  root.add(bar);

  // ---- weights ----
  // kettlebells: one merged cast-iron mesh
  const kbParts = [];
  L.kettlebells.forEach((k) => {
    const yaw = rng.float(-L.kettlebellYaw, L.kettlebellYaw);
    const parts = kettlebellGeometry(k.diameter, k.height);
    for (const p of parts) {
      xf(p, [0, 0, 0], [0, yaw, 0]);
      xf(p, [k.pos[0], 0, k.pos[2]]);
      kbParts.push(p);
    }
  });
  const kettlebells = new THREE.Mesh(mergeOrEmpty(kbParts), ironMat);
  kettlebells.name = "kettlebells";
  kettlebells.receiveShadow = true;
  root.add(kettlebells);

  // dumbbells: hex rubber heads (merged into the rubber mesh), chrome handles (merged into static metal)
  const dbSpecs = [
    { spec: L.dumbbellsA, len: 0.35, R: 0.06, headT: 0.085, handleR: 0.0155, hex: "#1c1c1e" },
    { spec: L.dumbbellsB, len: 0.4, R: 0.09, headT: 0.1, handleR: 0.0165, hex: "#161618" },
  ];
  for (const d of dbSpecs) {
    const { heads, metal } = dumbbellParts(d.len, d.R, d.headT, d.handleR, d.hex);
    for (const wz of d.spec.z) {
      const yaw = d.spec.rotY + rng.float(-0.03, 0.03);
      for (const hg of heads) staticRubber.push(xf(xf(hg.clone(), [0, 0, 0], [0, yaw, 0]), [d.spec.pos[0], 0, wz]));
      for (const mg of metal) staticMetal.push(xf(xf(mg.clone(), [0, 0, 0], [0, yaw, 0]), [d.spec.pos[0], 0, wz]));
    }
  }

  // plate stack: 3 bevelled bumper plates, each a touch off-centre and turned, with a muted accent stripe
  const PL = L.plates;
  for (let i = 0; i < PL.count; i++) {
    const yaw = rng.float(0, PI * 2);
    const ox = rng.float(-PL.offset, PL.offset);
    const oz = rng.float(-PL.offset, PL.offset);
    const y = i * PL.thickness;
    const disc = tint(plateGeometry(), "#171718");
    xf(disc, [0, 0, 0], [0, yaw, 0]);
    xf(disc, [PL.pos[0] + ox, y, PL.pos[2] + oz]);
    staticRubber.push(disc);
    const stripe = new THREE.RingGeometry(0.168, 0.18, 56);
    xf(stripe, [0, 0, 0], [-PI / 2, 0, 0]);
    xf(stripe, [PL.pos[0] + ox, y + PL.thickness + 0.0004, PL.pos[2] + oz]);
    staticRubber.push(tint(flat(stripe), "#8a3b1e"));
    // pale hub ring so the hole reads
    const hub = new THREE.RingGeometry(0.03, 0.04, 28);
    xf(hub, [0, 0, 0], [-PI / 2, 0, 0]);
    xf(hub, [PL.pos[0] + ox, y + PL.thickness + 0.0004, PL.pos[2] + oz]);
    staticMetal.push(flat(hub));
  }

  const metalMesh = new THREE.Mesh(mergeOrEmpty(staticMetal), metalMat);
  metalMesh.name = "trainingMetal";
  metalMesh.receiveShadow = true;
  root.add(metalMesh);

  const rubberMesh = new THREE.Mesh(mergeOrEmpty(staticRubber), rubberMat);
  rubberMesh.name = "trainingRubber";
  rubberMesh.receiveShadow = true;
  root.add(rubberMesh);

  // ---- tatami ----
  const M = L.mat;
  const tat = T.tatami({ width: M.width, depth: M.depth, rng: rng.fork("tatami") });
  const topMat = new THREE.MeshStandardMaterial({ map: tat.map, bumpMap: tat.bumpMap, bumpScale: 0.7, roughness: 0.9 });
  topMat.name = "tatamiTop";
  const matTop = new THREE.Mesh(new THREE.PlaneGeometry(M.width, M.depth).rotateX(-PI / 2), topMat);
  matTop.name = "mat";
  matTop.position.set(M.pos[0], M.height + 0.0002, M.pos[2]);
  matTop.rotation.y = M.rotY;
  matTop.receiveShadow = true;
  const sideMat = new THREE.MeshStandardMaterial({ color: "#1d222b", roughness: 0.92 });
  const matBody = new THREE.Mesh(new THREE.BoxGeometry(M.width, M.height - 0.0004, M.depth), sideMat);
  matBody.name = "matBody";
  matBody.position.set(M.pos[0], (M.height - 0.0004) / 2, M.pos[2]);
  matBody.rotation.y = M.rotY;
  matBody.receiveShadow = true;
  root.add(matBody, matTop);

  scene.add(root);

  // ---- idle sway ----
  const amp = THREE.MathUtils.degToRad(R.swayDeg);
  const w = (PI * 2) / R.swayPeriod;
  let update;
  if (!ctx.reducedMotion) {
    update = (dt, t) => {
      for (let i = 0; i < ringGroups.length; i++) {
        const g = ringGroups[i];
        const ph = swayPhase[i % swayPhase.length];
        g.rotation.z = amp * Math.sin(w * t + ph);
        g.rotation.x = amp * 0.4 * Math.sin(w * 0.93 * t + ph * 1.3 + 0.7);
      }
    };
  }

  const hotspots = [
    {
      zone: "training",
      label: "Truth in the Wild.",
      objects: [...ringGroups, bar, kettlebells, rubberMesh, metalMesh, matTop, matBody],
    },
  ];

  const out = { root, hotspots };
  if (update) out.update = update;
  return out;
}
