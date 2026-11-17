// objects/drums.js — four-piece kit (one up, one down) in a blue sparkle wrap, chrome hardware, cymbals,
// throne, double bass pedal, sticks, octopad and rug (SPEC §5.4). No brand marks anywhere.
// Gateway to the "music" zone (YouTube). Every drum, cymbal and pad is playable: a tap plays the synth
// voice, gives a small visual response (head dip / beater stroke / cymbal wobble / pad flash) and still
// opens the panel.
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots }.
//
// Kit-local frame (the root group sits at the throne with rotation.y = rotY): drummer faces +z,
// local +x is the drummer's LEFT, −x the RIGHT. y is height above the floor. The rug top is at y = F.
//
// Draw calls (main pass): rug, shells (instanced), heads (instanced), chrome (merged), dark parts + sticks
// (merged, vertex colours), cymbals (instanced), pads (instanced), LCD, beaters (instanced) = 9.
// Shadow pass: shells, heads, cymbals, dark parts (throne seat) = 4.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

// ---- build-time geometry helpers ----------------------------------------------------------------------

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const qAxis = (x, y, z, angle) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), angle);
const mat = (pos, q, s) => new THREE.Matrix4().compose(pos.isVector3 ? pos : v3(pos), q || new THREE.Quaternion(), s ? (s.isVector3 ? s : v3(s)) : new THREE.Vector3(1, 1, 1));
const mul = (a, b) => new THREE.Matrix4().multiplyMatrices(a, b);

/** Non-indexed copy with position + normal (+ optional flat vertex colour), so buckets merge cleanly. */
function prep(g, color) {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", src.attributes.position.clone());
  out.setAttribute("normal", src.attributes.normal.clone());
  if (color) {
    const c = new THREE.Color(color);
    const n = out.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      a[i * 3] = c.r;
      a[i * 3 + 1] = c.g;
      a[i * 3 + 2] = c.b;
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
  add(geometry, matrix, color) {
    const g = prep(geometry, this.colored ? color || "#ffffff" : null);
    if (matrix) g.applyMatrix4(matrix);
    this.list.push(g);
  }
  /** Cylinder (rod) between two kit-local points. */
  rod(a, b, r, color, seg = 8, caps = true) {
    const A = a.isVector3 ? a : v3(a), B = b.isVector3 ? b : v3(b);
    const d = new THREE.Vector3().subVectors(B, A);
    const len = d.length();
    if (len < 1e-5) return;
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d.multiplyScalar(1 / len));
    this.add(new THREE.CylinderGeometry(r, r, len, seg, 1, !caps), mat(new THREE.Vector3().addVectors(A, B).multiplyScalar(0.5), q), color);
  }
  mesh(material, name) {
    const m = new THREE.Mesh(mergeGeometries(this.list, false), material);
    for (const g of this.list) g.dispose();
    this.list.length = 0;
    m.name = name;
    return m;
  }
}

/** Lathe from [radius, y] pairs. Order: underside outward, outer wall up, top inward (outward normals). */
const lathe = (pts, seg = 48) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg);

/** Hoop ring around a head plane at y = 0: `below` over the shell, `above` proud of the head, `t` thick. */
function hoopGeometry(r, below, above, t, seg = 48) {
  const i = r + 0.0012;
  return lathe([[i, -below], [r + t, -below], [r + t, above - 0.003], [r + t - 0.002, above], [i + 0.001, above], [i, above - 0.002], [i, -below]], seg);
}

// Cymbal profile in units of the cymbal radius: bell, bow, thin edge. Underside outward, then top inward.
const CYMBAL_PROFILE = [
  [0.035, 0.125], [0.1, 0.118], [0.17, 0.095], [0.205, 0.06], [0.24, 0.044], [0.45, 0.028], [0.75, 0.012], [1.0, -0.003],
  [1.0, 0.003], [0.75, 0.02], [0.45, 0.037], [0.24, 0.054], [0.205, 0.07], [0.17, 0.106], [0.1, 0.13], [0.035, 0.137], [0.035, 0.125],
];
const BELL_TOP = 0.137;

// Stick profile along y, centred, 0.40 long: rounded butt, long taper, olive tip.
function stickGeometry(len, r) {
  const h = len / 2, tip = r * 0.5;
  return lathe([
    [0, -h], [r * 0.7, -h + 0.0006], [r, -h + 0.003], [r, h - 0.14], [tip * 1.05, h - 0.03], [tip, h - 0.024],
    [tip * 1.4, h - 0.016], [tip * 1.3, h - 0.007], [tip * 0.6, h - 0.001], [0, h],
  ], 12);
}

/** Head normal tilted `deg` toward kit-local −z (toward the drummer). */
const tiltTowardDrummer = (deg) => qAxis(1, 0, 0, -deg * DEG);

// ---- textures --------------------------------------------------------------------------------------------

function headTexture(T, rng) {
  const s = 256;
  const { canvas, ctx: c } = T.makeCanvas(s);
  c.fillStyle = "#efeee8";
  c.fillRect(0, 0, s, s);
  const cx = s / 2;
  // beater / stick wear around the centre
  const g = c.createRadialGradient(cx, cx, 0, cx, cx, s * 0.24);
  g.addColorStop(0, "rgba(120,110,96,0.16)");
  g.addColorStop(1, "rgba(120,110,96,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, s, s);
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2, d = Math.abs(rng.gauss(0, s * 0.07));
    c.fillStyle = `rgba(105,95,85,${0.04 + rng() * 0.05})`;
    c.beginPath();
    c.ellipse(cx + Math.cos(a) * d, cx + Math.sin(a) * d, 1.5 + rng() * 3, 1 + rng() * 1.5, rng() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
  // collar where the film turns over the bearing edge
  c.strokeStyle = "rgba(90,80,70,0.10)";
  c.lineWidth = s * 0.03;
  c.beginPath();
  c.arc(cx, cx, s * 0.485, 0, Math.PI * 2);
  c.stroke();
  if (T.grainOverlay) T.grainOverlay(c, s, s, { rng: rng.fork("grain"), amount: 0.035, scale: 6 });
  return T.toTexture(canvas, { srgb: true });
}

/**
 * Sparkle wrap: tiny metal flakes in a lacquer. Returns a grey colour map (multiplies the shell colour) and a
 * roughness (G) / metalness (B) map; flakes are bright, glossy and metallic, the field between them satin.
 */
function sparkleMaps(T, rng) {
  const s = 256;
  const col = T.makeCanvas(s), mr = T.makeCanvas(s);
  col.ctx.fillStyle = "rgb(230,230,230)";
  col.ctx.fillRect(0, 0, s, s);
  mr.ctx.fillStyle = "rgb(0,92,46)"; // roughness 0.36, metalness 0.18
  mr.ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 3400; i++) {
    const x = Math.floor(rng() * s), y = Math.floor(rng() * s), w = rng() < 0.3 ? 2 : 1;
    const k = rng() < 0.65 ? 255 : 150;
    col.ctx.fillStyle = `rgb(${k},${k},${k})`;
    col.ctx.fillRect(x, y, w, 1);
    mr.ctx.fillStyle = k > 200 ? "rgb(0,30,240)" : "rgb(0,60,170)";
    mr.ctx.fillRect(x, y, w, 1);
  }
  return {
    map: T.toTexture(col.canvas, { srgb: true, repeat: [6, 2] }),
    mr: T.toTexture(mr.canvas, { srgb: false, repeat: [6, 2] }),
  };
}

/** Concentric lathing grooves for the cymbals: stripes along the lathe's v (profile) axis. */
function cymbalStripes(T, rng) {
  const { canvas, ctx: c } = T.makeCanvas(4, 512);
  for (let y = 0; y < 512; y++) {
    let v = 0.91 + rng() * 0.09;
    if (rng() < 0.06) v -= 0.07;
    const k = Math.round(v * 255);
    c.fillStyle = `rgb(${k},${k},${k})`;
    c.fillRect(0, y, 4, 1);
  }
  return { map: T.toTexture(canvas, { srgb: true }), rough: T.toTexture(canvas, { srgb: false }) };
}

// ---- build ------------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const D = layout.drums;
  const P = D.pieces;
  const T = ctx.textures;
  const rng = ctx.rng;
  const F = D.rug.height; // rug top: every foot, spur and hoop starts here

  const root = new THREE.Group();
  root.name = "drums";
  root.position.fromArray(D.origin);
  root.rotation.y = D.rotY;

  const chrome = new Bucket(false);
  const dark = new Bucket(true);

  // ---- rug ----
  const rugTex = T.rug({
    rng: rng.fork("rug"),
    colors: { field: "#2c3644", border: "#1f2228", accent: "#9a7b4f", ivory: "#c9bea6" },
  });
  const rugMat = new THREE.MeshStandardMaterial({ map: rugTex.map, roughness: 0.96 });
  if (T.weave) {
    const wv = T.weave({ size: 256, color: "#8a8a8a", threads: 48, kind: "plain", repeat: [16, 16], rng: rng.fork("rugWeave") });
    rugMat.bumpMap = wv.bumpMap;
    rugMat.bumpScale = 0.7;
    wv.map.dispose();
  }
  const rug = new THREE.Mesh(new THREE.BoxGeometry(D.rug.width, D.rug.height, D.rug.depth), rugMat);
  rug.name = "drumRug";
  rug.position.set(D.rug.local[0], F / 2, D.rug.local[2]);
  rug.receiveShadow = true;
  root.add(rug);

  // ---- drums: shells + heads (instanced), hoops + lugs (merged) ----
  const DRUMS = [
    { id: "kick", label: "KICK", q: qAxis(1, 0, 0, Math.PI / 2), lugs: 8, batterTop: false, hoop: [0.018, 0.006, 0.01] },
    { id: "snare", label: "SNARE", q: tiltTowardDrummer(P.snare.tilt), lugs: 10, batterTop: true, hoop: [0.012, 0.008, 0.006] },
    { id: "tom1", label: "TOM", q: tiltTowardDrummer(P.tom1.tilt), lugs: 6, batterTop: true, hoop: [0.012, 0.008, 0.006] },
    { id: "floorTom", label: "FLOOR", q: new THREE.Quaternion(), lugs: 8, batterTop: true, hoop: [0.012, 0.008, 0.006] },
  ].map((d) => {
    const p = P[d.id];
    const r = p.diameter / 2;
    const center = v3(p.local);
    const n = UP.clone().applyQuaternion(d.q);
    return { ...d, p, r, depth: p.depth, center, n, M: mat(center, d.q), sound: p.sound };
  });

  const shellGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 56, 1, true);
  const sparkle = sparkleMaps(T, rng.fork("sparkle"));
  const shells = new THREE.InstancedMesh(shellGeo, new THREE.MeshPhysicalMaterial({
    color: D.colors.shell, map: sparkle.map, roughness: 1, roughnessMap: sparkle.mr, metalness: 1, metalnessMap: sparkle.mr,
    clearcoat: 1, clearcoatRoughness: 0.06,
  }), DRUMS.length);
  shells.name = "drums.shells";

  const headGeo = new THREE.CircleGeometry(0.5, 56).rotateX(-Math.PI / 2);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ map: headTexture(T, rng.fork("head")), roughness: 0.6 }), DRUMS.length * 2);
  heads.name = "drums.heads";
  heads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const headWhite = new THREE.Color("#ffffff"), headReso = new THREE.Color(D.colors.kickReso);

  const headBase = []; // per head instance: { pos, q, s, inward }
  const flipX = qAxis(1, 0, 0, Math.PI);
  DRUMS.forEach((d, i) => {
    shells.setMatrixAt(i, mat(d.center, d.q, [d.r * 2, d.depth, d.r * 2]));
    for (const top of [true, false]) {
      const sgn = top ? 1 : -1;
      const pos = d.center.clone().addScaledVector(d.n, sgn * (d.depth / 2 + 0.0006));
      const q = top ? d.q.clone() : d.q.clone().multiply(flipX);
      const hr = (d.r + 0.0014) * 2;
      const s = new THREE.Vector3(hr, 1, hr);
      heads.setMatrixAt(headBase.length, mat(pos, q, s));
      // the kick's front (+z, non-batter) head is a dark resonant head; every other head is coated white
      heads.setColorAt(headBase.length, d.id === "kick" && top !== d.batterTop ? headReso : headWhite);
      headBase.push({ pos, q, s, inward: d.n.clone().multiplyScalar(-sgn) });

      // hoop
      const [below, above, t] = d.hoop;
      chrome.add(hoopGeometry(d.r, below, above, t), mul(d.M, mat([0, sgn * d.depth / 2, 0], top ? null : flipX)));
    }
    d.batter = i * 2 + (d.batterTop ? 0 : 1);

    // lugs, tension rods, claws (drum-local, axis = y)
    const [, above, t] = d.hoop;
    const R = d.r + 0.008, rodR = d.r + t + 0.004;
    const twoRows = d.depth > 0.3;
    const lugH = twoRows ? 0.05 : Math.min(0.05, d.depth * 0.36);
    const rows = twoRows ? [-(d.depth / 2 - 0.07), d.depth / 2 - 0.07] : [0];
    for (let k = 0; k < d.lugs; k++) {
      const a = ((k + 0.5) / d.lugs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const qa = qAxis(0, 1, 0, -a);
      for (const y of rows) {
        chrome.add(new RoundedBoxGeometry(0.012, lugH, 0.014, 2, 0.004), mul(d.M, mat([ca * R, y, sa * R], qa)));
        const ends = twoRows ? [Math.sign(y)] : [1, -1];
        for (const e of ends) {
          const y0 = y + e * lugH / 2, y1 = e * (d.depth / 2 + above + 0.004);
          chrome.rod(v3([ca * rodR, y0, sa * rodR]).applyMatrix4(d.M), v3([ca * rodR, y1, sa * rodR]).applyMatrix4(d.M), 0.0024, null, 6, false);
          chrome.add(new THREE.CylinderGeometry(0.0042, 0.0042, 0.007, 8), mul(d.M, mat([ca * rodR, y1 + e * 0.0035, sa * rodR])));
          chrome.add(new THREE.BoxGeometry(0.011, 0.012, 0.007), mul(d.M, mat([ca * (d.r + t + 0.002), e * (d.depth / 2 + above - 0.006), sa * (d.r + t + 0.002)], qa)));
        }
      }
    }
  });
  shells.castShadow = shells.receiveShadow = true;
  heads.castShadow = heads.receiveShadow = true;
  root.add(shells, heads);

  const byId = Object.fromEntries(DRUMS.map((d) => [d.id, d]));
  const kick = byId.kick, snare = byId.snare, floorTom = byId.floorTom;

  // snare throw-off + butt plate
  {
    const a = Math.PI * 0.5 + Math.PI / snare.lugs; // between two lugs, on the drummer's left
    const qa = qAxis(0, 1, 0, -a);
    chrome.add(new RoundedBoxGeometry(0.016, 0.05, 0.016, 2, 0.004), mul(snare.M, mat([Math.cos(a) * (snare.r + 0.01), 0, Math.sin(a) * (snare.r + 0.01)], qa)));
    chrome.add(new THREE.BoxGeometry(0.006, 0.006, 0.03), mul(snare.M, mat([Math.cos(a) * (snare.r + 0.02), 0.012, Math.sin(a) * (snare.r + 0.02)], qa)));
  }

  // kick: front port + ring, spurs
  {
    // drum-local (x, y, z) -> kit (x, -z, y) for the kick (y axis = kit +z, the front/reso side)
    const portLocal = [0.1, kick.depth / 2 + 0.0016, 0.07], pr = P.kick.port / 2;
    dark.add(new THREE.CircleGeometry(pr, 32).rotateX(-Math.PI / 2), mul(kick.M, mat(portLocal)), "#030304");
    chrome.add(new THREE.TorusGeometry(pr + 0.001, 0.0035, 6, 36).rotateX(Math.PI / 2), mul(kick.M, mat(portLocal)));

    const y0 = kick.center.y, z0 = kick.center.z, kr = kick.r;
    for (const sx of [1, -1]) {
      // spur: bracket on the shell, leg angled forward and out to the rug
      const ang = -32 * DEG;
      const bx = sx * Math.cos(ang) * (kr + 0.006), by = y0 + Math.sin(ang) * (kr + 0.006);
      chrome.add(new RoundedBoxGeometry(0.03, 0.05, 0.02, 2, 0.006), mat([bx, by, z0 + 0.13], qAxis(0, 0, 1, sx * (90 * DEG + ang))));
      const top = v3([sx * (kr + 0.02), by + 0.02, z0 + 0.13]);
      const foot = v3([sx * (kr + 0.1), F + 0.012, z0 + 0.24]);
      chrome.rod(top, foot, 0.0065);
      dark.add(new THREE.CylinderGeometry(0.009, 0.011, 0.016, 10), mat([foot.x, F + 0.008, foot.z]), "#141414");
    }

  }

  // ---- double bass pedal ----
  // Main pedal (right foot) on the kick hoop: footboard + chain on the drummer's right, two beaters either
  // side of centre on one axle line. Slave pedal (left foot) between the snare stand and the hi-hat pedal,
  // its axle linked to the main pedal's left beater by a telescoping drive shaft with a universal joint at
  // each end. The beaters are a separate 2-instance mesh so a kick tap can swing them (see update()).
  const zH = kick.center.z - kick.depth / 2; // batter head plane
  const pz = P.kick.pedalZ;
  const postZ = zH - 0.03, axleY = F + 0.19;
  const bxs = [-P.kick.beaterX, P.kick.beaterX]; // [right/primary, left/secondary]
  /** Footboard pedal: base plate, hinged board, heel hinge, side posts, axle, cam and chain. */
  function footPedal(x, heelZ, toeZ, zPost, yAxle, posts, axle, camX) {
    chrome.add(new THREE.BoxGeometry(0.095, 0.006, zPost + 0.005 - (heelZ - 0.05)), mat([x, F + 0.003, (zPost + 0.005 + heelZ - 0.05) / 2]));
    const heel = v3([x, F + 0.02, heelZ]), toe = v3([x, F + 0.085, toeZ]);
    const fb = new THREE.Vector3().subVectors(toe, heel);
    dark.add(new RoundedBoxGeometry(0.075, 0.008, fb.length(), 2, 0.003), mat(heel.clone().add(toe).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fb.normalize())), "#2e2f33");
    dark.add(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 10).rotateZ(Math.PI / 2), mat([x, F + 0.016, heelZ]), "#1c1c1e");
    for (const px of posts) {
      chrome.rod([px, F + 0.006, zPost], [px, yAxle + 0.012, zPost], 0.008);
      chrome.add(new THREE.CylinderGeometry(0.013, 0.013, 0.016, 12).rotateZ(Math.PI / 2), mat([px, yAxle, zPost])); // bearing
    }
    chrome.rod([axle[0], yAxle, zPost], [axle[1], yAxle, zPost], 0.006);
    chrome.add(new THREE.CylinderGeometry(0.02, 0.02, 0.012, 14).rotateZ(Math.PI / 2), mat([camX, yAxle, zPost])); // cam
    chrome.rod([camX, F + 0.085, toeZ + 0.005], [camX, yAxle - 0.012, zPost], 0.003, null, 6); // drive chain
  }
  /** Universal joint: two small yokes and a cross block, aligned with `dir` (unit). */
  function uJoint(p, dir) {
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    chrome.add(new THREE.CylinderGeometry(0.009, 0.009, 0.026, 10), mat(p, q));
    dark.add(new THREE.BoxGeometry(0.016, 0.016, 0.016), mat(p, q), "#2a2a2c");
  }
  // main pedal: primary frame posts either side of the footboard, a third post carrying the left axle
  const mainX = -0.045, mainPosts = [-0.098, 0.004, 0.078];
  footPedal(mainX, pz - 0.2, pz + 0.02, postZ, axleY, mainPosts, [-0.108, 0.09], -0.062);
  chrome.add(new THREE.BoxGeometry(0.2, 0.02, 0.034), mat([-0.01, F + 0.01, zH - 0.016])); // hoop clamp + frame bar
  for (const bx of bxs) chrome.add(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 12).rotateZ(Math.PI / 2), mat([bx, axleY, postZ])); // beater hubs
  // slave pedal (left foot)
  const sx = P.kick.slaveX, sPostZ = postZ - 0.015, sAxleY = F + 0.17;
  footPedal(sx, pz - 0.215, pz + 0.005, sPostZ, sAxleY, [sx - 0.045, sx + 0.045], [sx - 0.06, sx + 0.058], sx + 0.012);
  // drive shaft: slave axle end -> main pedal's left axle end, telescoping, U-joints at both ends
  {
    const A = v3([sx - 0.072, sAxleY, sPostZ]), B = v3([mainPosts[2] + 0.024, axleY, postZ]);
    const dir = new THREE.Vector3().subVectors(B, A).normalize();
    chrome.rod([sx - 0.06, sAxleY, sPostZ], A, 0.006);
    chrome.rod([0.09, axleY, postZ], B, 0.006);
    uJoint(A, dir);
    uJoint(B, dir);
    const a1 = A.clone().addScaledVector(dir, 0.016), b1 = B.clone().addScaledVector(dir, -0.016);
    chrome.rod(a1, b1, 0.0055, null, 8);
    chrome.rod(a1, a1.clone().lerp(b1, 0.55), 0.0075, null, 10); // outer sleeve
  }
  // beaters: pivot on the axle, rod up to a felt head that meets the batter head at ~kick centre + 4 cm
  const beaterLen = Math.hypot(kick.center.y + 0.04 - axleY, 0.004);
  const beaterHitAng = Math.atan2(0.004, kick.center.y + 0.04 - axleY); // rod leaning onto the head
  const beaterRestAng = beaterHitAng - 38 * DEG; // pulled back toward the drummer
  const beaterGeo = (() => {
    const b = new Bucket(true);
    b.rod([0, 0, 0], [0, beaterLen, 0], 0.0035, "#c3c6ca", 8);
    b.add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.022, 8), mat([0, beaterLen - 0.03, 0]), "#c3c6ca"); // collar
    b.add(new THREE.CylinderGeometry(0.024, 0.024, 0.04, 18).rotateZ(Math.PI / 2), mat([0, beaterLen, 0]), "#ddd6c6"); // felt
    const g = mergeGeometries(b.list, false);
    for (const x of b.list) x.dispose();
    return g;
  })();
  const beaters = new THREE.InstancedMesh(beaterGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 }), 2);
  beaters.name = "drums.beaters";
  beaters.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const beaterPivots = bxs.map((bx) => v3([bx, axleY, postZ]));
  const AXIS_X = new THREE.Vector3(1, 0, 0), ONE = new THREE.Vector3(1, 1, 1);
  beaterPivots.forEach((p, i) => beaters.setMatrixAt(i, mat(p, qAxis(1, 0, 0, beaterRestAng))));
  beaters.receiveShadow = true;
  root.add(beaters);

  // ---- stands ----
  /**
   * Single-braced tripod at (x, z): leg collar at collarY, feet at `radius`, leg angles in degrees (x, z plane),
   * braces from a lower collar at braceY on the centre tube out to each leg.
   */
  function tripod(x, z, collarY, radius, angles, braceY = collarY * 0.42 + F) {
    chrome.add(new THREE.CylinderGeometry(0.017, 0.017, 0.04, 14), mat([x, collarY, z]));
    chrome.rod([x, braceY - 0.012, z], [x, collarY, z], 0.0095, null, 10);
    chrome.add(new THREE.CylinderGeometry(0.013, 0.013, 0.02, 12), mat([x, braceY, z]));
    for (const deg of angles) {
      const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
      const top = v3([x + c * 0.016, collarY, z + s * 0.016]);
      const foot = v3([x + c * radius, F + 0.012, z + s * radius]);
      chrome.rod(top, foot, 0.0055);
      const mid = top.clone().lerp(foot, 0.55);
      chrome.rod([x + c * 0.012, braceY, z + s * 0.012], mid, 0.0035, null, 6);
      dark.add(new THREE.CylinderGeometry(0.008, 0.01, 0.016, 10), mat([foot.x, F + 0.008, foot.z]), "#141414");
    }
  }

  // throne
  {
    const t = P.throne;
    const yb = t.local[1] - t.thickness / 2, yt = t.local[1] + t.thickness / 2, r = t.diameter / 2;
    dark.add(lathe([[0, yb], [r - 0.02, yb], [r - 0.005, yb + 0.008], [r, yb + 0.025], [r, yt - 0.022], [r - 0.006, yt - 0.006], [r - 0.024, yt], [r * 0.45, yt + 0.003], [0, yt + 0.003]], 40), null, "#1d1b1a");
    chrome.add(new THREE.CylinderGeometry(0.09, 0.1, 0.012, 24), mat([0, yb - 0.006, 0]));
    chrome.rod([0, F + 0.1, 0], [0, yb - 0.01, 0], 0.019, null, 14);
    chrome.rod([0, yb - 0.11, 0], [0, yb - 0.04, 0], 0.024, null, 14); // height lock
    tripod(0, 0, F + 0.21, 0.27, [30, 150, 270]);
  }

  // snare stand + basket. High leg collar, low braces and legs turned so the drive shaft runs between
  // them, under the collar and over the braces, the way a double-pedal player sets the stand.
  {
    const s = snare;
    const sx = s.center.x, sz = s.center.z;
    tripod(sx, sz, F + 0.34, 0.18, [170, 290, 50], F + 0.09);
    const bottom = s.center.clone().addScaledVector(s.n, -(s.depth / 2 + 0.03));
    chrome.rod([sx, F + 0.32, sz], [bottom.x, bottom.y - 0.035, bottom.z], 0.011, null, 12);
    chrome.add(new THREE.SphereGeometry(0.016, 12, 8), mat([bottom.x, bottom.y - 0.02, bottom.z]));
    for (const deg of [90, 210, 330]) {
      const a = deg * DEG;
      const tip = v3([Math.cos(a) * (s.r - 0.004), -(s.depth / 2 + 0.012), Math.sin(a) * (s.r - 0.004)]).applyMatrix4(s.M);
      const elbow = v3([Math.cos(a) * (s.r * 0.55), -(s.depth / 2 + 0.03), Math.sin(a) * (s.r * 0.55)]).applyMatrix4(s.M);
      chrome.rod(bottom.clone().addScaledVector(s.n, 0.012), elbow, 0.005, null, 6);
      chrome.rod(elbow, tip, 0.005, null, 6);
      dark.add(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 8), mat(tip, s.q), "#141414");
    }
  }

  // floor tom legs
  {
    const f = floorTom;
    for (const deg of [110, 230, 350]) {
      const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
      const by = f.center.y + 0.09;
      chrome.add(new RoundedBoxGeometry(0.03, 0.05, 0.026, 2, 0.006), mat([f.center.x + c * (f.r + 0.012), by, f.center.z + s * (f.r + 0.012)], qAxis(0, 1, 0, -a)));
      const top = v3([f.center.x + c * (f.r + 0.03), by + 0.05, f.center.z + s * (f.r + 0.03)]);
      const foot = v3([f.center.x + c * 0.3, F + 0.012, f.center.z + s * 0.3]);
      chrome.rod(top, foot, 0.0065);
      dark.add(new THREE.CylinderGeometry(0.009, 0.011, 0.016, 10), mat([foot.x, F + 0.008, foot.z]), "#141414");
    }
  }

  // single rack tom mount on the kick: post from the shell, ball clamp, L-arm into the tom bracket
  {
    const d = byId.tom1;
    const base = v3([d.center.x * 0.4, 0, kick.center.z + 0.14]);
    base.y = kick.center.y + Math.sqrt(kick.r * kick.r - base.x * base.x);
    chrome.add(new RoundedBoxGeometry(0.05, 0.016, 0.07, 2, 0.005), mat([base.x, base.y + 0.004, base.z]));
    const top = base.clone().setY(base.y + 0.11);
    chrome.rod(base, top, 0.012, null, 12);
    chrome.add(new RoundedBoxGeometry(0.046, 0.036, 0.04, 2, 0.008), mat(top));
    const bracket = v3([0, -0.01, d.r + 0.014]).applyMatrix4(d.M);
    chrome.add(new RoundedBoxGeometry(0.03, 0.045, 0.022, 2, 0.006), mul(d.M, mat([0, -0.01, d.r + 0.01])));
    const elbow = v3([(top.x + bracket.x) / 2, top.y + 0.035, top.z + 0.005]);
    chrome.rod(top, elbow, 0.0085);
    chrome.rod(elbow, bracket, 0.0085);
    chrome.add(new THREE.SphereGeometry(0.013, 10, 8), mat(elbow));
  }

  // ---- cymbals (instanced lathe) + stands ----
  const stripes = cymbalStripes(T, rng.fork("cymbal"));
  const cymGeo = lathe(CYMBAL_PROFILE, 48);
  const cymbals = new THREE.InstancedMesh(cymGeo, new THREE.MeshStandardMaterial({
    color: D.colors.cymbal, metalness: 0.8, roughness: 0.3, envMapIntensity: 2.4, map: stripes.map, roughnessMap: stripes.rough,
  }), 4);
  cymbals.name = "drums.cymbals";
  cymbals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cymbals.castShadow = true;
  const cymBase = []; // { pos, q, s, amp, label, sound }
  const towardDrummer = (local, deg) => {
    const h = new THREE.Vector2(-local[0], -local[2]).normalize();
    const a = deg * DEG;
    return new THREE.Quaternion().setFromUnitVectors(UP, new THREE.Vector3(h.x * Math.sin(a), Math.cos(a), h.y * Math.sin(a)).normalize());
  };
  const spin = () => qAxis(0, 1, 0, rng() * Math.PI * 2);
  const addCymbal = (pos, q, r, amp, label, sound) => {
    const s = new THREE.Vector3(r, r, r);
    cymbals.setMatrixAt(cymBase.length, mat(pos, q, s));
    cymBase.push({ pos, q, s, amp, label, sound, r });
  };

  /**
   * Cymbal on a stand. piece.stand: { legs } for a straight stand (tube rises under the tilter), or
   * { boom: true, base: [x, z], tubeTop, legs } for a boom stand with a counterweighted arm.
   */
  function cymbalStand(piece, label) {
    const c = v3(piece.local), r = piece.diameter / 2, st = piece.stand;
    const q = towardDrummer(piece.local, piece.tilt).multiply(spin());
    addCymbal(c, q, r, 5.5 * DEG, label, piece.sound);
    const n = UP.clone().applyQuaternion(q);
    const tilter = c.clone().addScaledVector(n, -0.024);
    const bx = st.boom ? st.base[0] : tilter.x, bz = st.boom ? st.base[1] : tilter.z;
    tripod(bx, bz, F + 0.32, 0.22, st.legs);
    const T0 = v3([bx, F + 0.3, bz]), T1 = v3([bx, st.boom ? st.tubeTop : Math.min(F + 0.95, tilter.y - 0.3), bz]);
    chrome.rod(T0, T1, 0.0125, null, 12);
    chrome.add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 12), mat([bx, F + 0.62, bz])); // height clamp
    if (st.boom) {
      chrome.add(new THREE.SphereGeometry(0.017, 12, 8), mat(T1));
      chrome.rod(T1, tilter, 0.0095, null, 10);
      const back = new THREE.Vector3().subVectors(T1, tilter).normalize();
      chrome.rod(T1, T1.clone().addScaledVector(back, 0.09), 0.0085, null, 8);
      dark.add(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 14), mat(T1.clone().addScaledVector(back, 0.1), new THREE.Quaternion().setFromUnitVectors(UP, back)), "#1b1b1c");
    } else {
      chrome.add(new THREE.CylinderGeometry(0.016, 0.016, 0.03, 12), mat(T1)); // upper height clamp
      chrome.rod(T1, tilter, 0.0095, null, 10);
    }
    chrome.add(new THREE.CylinderGeometry(0.011, 0.013, 0.026, 12), mat(tilter, q));
    chrome.rod(tilter, c.clone().addScaledVector(n, r * BELL_TOP + 0.03), 0.0035, null, 6);
    dark.add(new THREE.CylinderGeometry(0.014, 0.014, 0.006, 14), mat(c.clone().addScaledVector(n, r * BELL_TOP + 0.004), q), "#3a3532");
    dark.add(new THREE.CylinderGeometry(0.014, 0.014, 0.005, 14), mat(c.clone().addScaledVector(n, r * 0.122 - 0.004), q), "#3a3532");
    chrome.add(new RoundedBoxGeometry(0.03, 0.012, 0.008, 2, 0.003), mat(c.clone().addScaledVector(n, r * BELL_TOP + 0.014), q)); // wing nut
  }
  cymbalStand(P.crash, "CRASH");
  cymbalStand(P.ride, "RIDE");

  // hi-hat: pair facing each other, stand, clutch, pedal (drummer's left foot)
  {
    const h = P.hihat, r = h.diameter / 2;
    const [x, y, z] = h.local;
    const sp = spin();
    addCymbal(v3([x, y + h.gap / 2, z]), sp.clone(), r, 2 * DEG, "HI-HAT", h.sound);
    addCymbal(v3([x, y - h.gap / 2, z]), flipX.clone().multiply(sp), r, 1.2 * DEG, "HI-HAT", h.sound);
    const bellLow = y - h.gap / 2 - r * BELL_TOP;
    tripod(x, z, F + 0.28, 0.2, [0, 120, 240]);
    chrome.rod([x, F + 0.06, z], [x, bellLow - 0.012, z], 0.0125, null, 12);
    chrome.add(new THREE.CylinderGeometry(0.017, 0.017, 0.03, 12), mat([x, F + 0.56, z]));
    dark.add(new THREE.CylinderGeometry(0.016, 0.016, 0.01, 14), mat([x, bellLow - 0.006, z]), "#3a3532");
    chrome.rod([x, bellLow - 0.012, z], [x, y + 0.11, z], 0.0035, null, 6);
    const bellHigh = y + h.gap / 2 + r * BELL_TOP;
    chrome.add(new THREE.CylinderGeometry(0.011, 0.011, 0.026, 12), mat([x, bellHigh + 0.016, z]));
    dark.add(new THREE.CylinderGeometry(0.014, 0.014, 0.005, 14), mat([x, bellHigh + 0.002, z]), "#3a3532");
    // pedal toward the drummer
    chrome.add(new THREE.BoxGeometry(0.09, 0.006, 0.24), mat([x, F + 0.003, z - 0.14]));
    const heel = v3([x, F + 0.02, z - 0.25]), toe = v3([x, F + 0.075, z - 0.04]);
    const fb = new THREE.Vector3().subVectors(toe, heel);
    dark.add(new RoundedBoxGeometry(0.075, 0.008, fb.length(), 2, 0.003), mat(heel.clone().add(toe).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fb.normalize())), "#3b3b3e");
    dark.add(new THREE.CylinderGeometry(0.012, 0.012, 0.075, 10).rotateZ(Math.PI / 2), mat([x, F + 0.016, z - 0.25]), "#202022");
    chrome.rod([x, F + 0.075, z - 0.035], [x, F + 0.06, z - 0.004], 0.004, null, 6);
  }
  root.add(cymbals);

  // ---- octopad: body, 8 pads (instanced), LCD, knobs, stand ----
  const op = P.octopad;
  const [ow, oh, od] = op.size;
  const oc = v3(op.local);
  const yaw = Math.atan2(-oc.x, 0.2 - oc.z); // front (local +z) faces the drummer's hands
  const oq = qAxis(0, 1, 0, yaw).multiply(qAxis(1, 0, 0, op.tilt * DEG));
  const OM = mat(oc, oq);
  dark.add(new RoundedBoxGeometry(ow, oh, od, 3, 0.012), OM, D.colors.padBody);
  dark.add(new RoundedBoxGeometry(ow - 0.02, 0.002, 0.04, 1, 0.0008), mul(OM, mat([0, oh / 2, -od / 2 + 0.035])), "#1f1f21");
  const [cols, rowsN] = [op.pads[1], op.pads[0]];
  const pad = op.pad;
  const pads = new THREE.InstancedMesh(new RoundedBoxGeometry(pad[0], pad[1], pad[2], 2, 0.0022), new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.82 }), cols * rowsN);
  pads.name = "drums.octopad.pads";
  const padBase = new THREE.Color(D.colors.pad);
  const padFlash = new THREE.Color(D.colors.lcd).multiplyScalar(0.55);
  const pitch = 0.084;
  for (let row = 0; row < rowsN; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      pads.setMatrixAt(i, mul(OM, mat([(col - (cols - 1) / 2) * pitch, oh / 2 + pad[1] / 2, -0.014 + row * pitch])));
      pads.setColorAt(i, padBase);
    }
  }
  pads.instanceColor.setUsage(THREE.DynamicDrawUsage);
  pads.castShadow = false;
  pads.receiveShadow = true;
  root.add(pads);

  // LCD (canvas) + bezel + knobs on the rear strip
  const lcdW = 0.1, lcdH = 0.026;
  const lcdTex = T.screen(256, 64);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(lcdW, lcdH).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: lcdTex.texture, toneMapped: false }));
  lcd.name = "drums.octopad.lcd";
  lcd.applyMatrix4(mul(OM, mat([-0.085, oh / 2 + 0.0026, -od / 2 + 0.035])));
  root.add(lcd);
  dark.add(new RoundedBoxGeometry(lcdW + 0.012, 0.004, lcdH + 0.01, 1, 0.0015), mul(OM, mat([-0.085, oh / 2, -od / 2 + 0.035])), "#101011");
  for (let k = 0; k < 4; k++) {
    dark.add(new THREE.CylinderGeometry(0.0075, 0.0085, 0.012, 14), mul(OM, mat([0.03 + k * 0.035, oh / 2 + 0.006, -od / 2 + 0.035])), "#48484b");
  }
  // mount: plate under the body, ball tilter, L-arm into a clamp on a short post rising from the kick shell
  // (the rack-tom mount's twin, on the drummer's right), where the removed middle tom used to hang
  {
    chrome.add(new THREE.BoxGeometry(0.14, 0.008, 0.11), mul(OM, mat([0, -oh / 2 - 0.004, 0])));
    const under = v3([0, -oh / 2 - 0.008, 0]).applyMatrix4(OM);
    const ball = under.clone().setY(under.y - 0.022);
    chrome.add(new THREE.SphereGeometry(0.018, 12, 8), mat(ball));
    const [mx, mz] = op.mount;
    const base = v3([mx, 0, mz]);
    base.y = kick.center.y + Math.sqrt(Math.max(0, kick.r * kick.r - mx * mx));
    chrome.add(new RoundedBoxGeometry(0.05, 0.016, 0.07, 2, 0.005), mat([base.x, base.y + 0.004, base.z], qAxis(0, 0, 1, Math.asin(mx / kick.r))));
    const top = base.clone().setY(ball.y - 0.07);
    chrome.rod(base, top, 0.012, null, 12);
    chrome.add(new RoundedBoxGeometry(0.046, 0.036, 0.04, 2, 0.008), mat(top)); // clamp
    const elbow = v3([(top.x + ball.x) / 2, ball.y - 0.035, (top.z + ball.z) / 2]);
    chrome.rod(top, elbow, 0.0085);
    chrome.rod(elbow, ball, 0.0085);
    chrome.add(new THREE.SphereGeometry(0.012, 10, 8), mat(elbow));
  }

  // LCD content: "latest video" marquee
  const music = ctx.content && ctx.content.zones && ctx.content.zones.music;
  const latest = music && Array.isArray(music.items) ? music.items[0] : null;
  const lcdTitle = (latest && latest.title) || "no signal";
  const lc = lcdTex.ctx;
  const LCD_TEXT = D.colors.lcd;
  lc.font = `22px ${MONO}`;
  const titleW = lc.measureText(lcdTitle).width;
  const scroll = titleW > 236 && !ctx.reducedMotion;
  const staticTitle = scroll ? lcdTitle : T.fitText ? T.fitText(lc, lcdTitle, 236) : lcdTitle;
  const LINE1 = "▶ LATEST VIDEO";
  const PAD_LABELS = Array.from({ length: cols * rowsN }, (_, i) => `PAD ${i + 1}`);
  let lcdLine1 = LINE1;
  function drawLcd(offset) {
    lc.fillStyle = "#04100e";
    lc.fillRect(0, 0, 256, 64);
    lc.fillStyle = LCD_TEXT;
    lc.shadowColor = LCD_TEXT;
    lc.shadowBlur = 4;
    lc.textBaseline = "top";
    lc.font = `600 15px ${MONO}`;
    lc.fillText(lcdLine1, 10, 7);
    lc.save();
    lc.beginPath();
    lc.rect(8, 28, 240, 32);
    lc.clip();
    lc.font = `22px ${MONO}`;
    if (scroll) {
      lc.fillText(lcdTitle, 10 - offset, 32);
      lc.fillText(lcdTitle, 10 - offset + titleW + 48, 32);
    } else lc.fillText(staticTitle, 10, 32);
    lc.restore();
    lc.shadowBlur = 0;
    lcdTex.texture.needsUpdate = true;
  }
  drawLcd(0);

  // ---- sticks: crossed on the snare (A rests on both rims, B on one rim and on A) ----
  {
    const sl = P.sticks.length, sr = P.sticks.radius;
    const s = snare;
    const rim = s.r + s.hoop[2] - 0.002;
    const yA = s.depth / 2 + s.hoop[1] + sr;
    const pA = new THREE.Vector2(0.015, -0.03), dA = new THREE.Vector2(Math.cos(18 * DEG), Math.sin(18 * DEG));
    const pB = new THREE.Vector2(-0.02, 0.02), dB = new THREE.Vector2(Math.cos(-28 * DEG), Math.sin(-28 * DEG));
    // crossing parameter on B: pB + tB dB = pA + tA dA
    const det = dA.x * -dB.y - dA.y * -dB.x;
    const rx = pB.x - pA.x, rz = pB.y - pA.y;
    const tB = (dA.x * rz - dA.y * rx) / det;
    // B's rim intersections
    const b = pB.dot(dB), cc = pB.lengthSq() - rim * rim;
    const disc = Math.sqrt(Math.max(0, b * b - cc));
    const t1 = -b - disc, t2 = -b + disc;
    const tRim = Math.abs(t1 - tB) > Math.abs(t2 - tB) ? t1 : t2;
    const slope = (2 * sr) / (tB - tRim);
    const tMid = (t1 + t2) / 2;
    const place = (p, d, tm, y0, sl0) => {
      const pos = v3([p.x + d.x * tm, y0, p.y + d.y * tm]);
      const dir = new THREE.Vector3(d.x, sl0, d.y).normalize();
      return mul(s.M, mat(pos, new THREE.Quaternion().setFromUnitVectors(UP, dir)));
    };
    const tMidA = -pA.dot(dA);
    dark.add(stickGeometry(sl, sr), place(pA, dA, tMidA, yA, 0), D.colors.stick);
    dark.add(stickGeometry(sl, sr), place(pB, dB, tMid, yA + slope * (tMid - tRim), slope), D.colors.stick);
  }

  // ---- merge the static buckets ----
  const chromeMesh = chrome.mesh(new THREE.MeshStandardMaterial({ color: "#d6d8da", metalness: 0.9, roughness: 0.3 }), "drums.hardware");
  chromeMesh.receiveShadow = true;
  const darkMesh = dark.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.12 }), "drums.dark");
  darkMesh.castShadow = darkMesh.receiveShadow = true;
  root.add(chromeMesh, darkMesh);

  heads.instanceColor.needsUpdate = true;
  for (const m of [shells, heads, cymbals, pads, beaters]) {
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }
  scene.add(root);

  // ---- interaction ----------------------------------------------------------------------------------
  const NEVER = -1e9;
  const drumHitAt = DRUMS.map(() => NEVER);
  const drumAmp = DRUMS.map(() => 0);
  const cymHitAt = cymBase.map(() => NEVER);
  const cymPhase = cymBase.map(() => rng() * Math.PI * 2);
  const padHitAt = PAD_LABELS.map(() => NEVER);
  let now = 0; // simulated seconds, from update()
  let headsLive = false, cymsLive = false, padsLive = false, beatersLive = false;
  const beaterHitAt = [NEVER, NEVER];
  let nextBeater = 0; // kick taps alternate right / left beater
  let lcdLabelUntil = 0, lcdDirty = false, lcdNext = 0;

  const _p = new THREE.Vector3(), _rel = new THREE.Vector3();
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _axis = new THREE.Vector3(), _c = new THREE.Color();

  const setLabel = (text) => {
    lcdLine1 = text;
    lcdLabelUntil = now + 0.9;
    lcdDirty = true;
  };

  function playDrum(i, velocity) {
    const d = DRUMS[i];
    drumHitAt[i] = now;
    drumAmp[i] = 0.0035 + 0.002 * velocity;
    headsLive = true;
    if (d === kick) {
      beaterHitAt[nextBeater] = now;
      nextBeater ^= 1;
      beatersLive = true;
    }
    setLabel(d.label);
    ctx.audio.hit(d.sound, velocity);
  }
  function playCymbal(i, velocity) {
    const c = cymBase[i];
    const hh = c.sound === "hat";
    for (let k = 0; k < cymBase.length; k++) if (k === i || (hh && cymBase[k].sound === "hat")) cymHitAt[k] = now;
    cymsLive = true;
    setLabel(c.label);
    ctx.audio.hit(c.sound, velocity);
  }
  function playPad(i) {
    padHitAt[i] = now;
    padsLive = true;
    setLabel(PAD_LABELS[i]);
    ctx.audio.hit(`pad${i}`, 0.85);
  }

  /** Nearest drum whose (slightly padded) cylinder contains the kit-local point, or -1. */
  function drumAt(p) {
    for (let i = 0; i < DRUMS.length; i++) {
      const d = DRUMS[i];
      _rel.subVectors(p, d.center);
      const ax = _rel.dot(d.n);
      const rad = Math.sqrt(Math.max(0, _rel.lengthSq() - ax * ax));
      if (Math.abs(ax) <= d.depth / 2 + 0.03 && rad <= d.r + 0.03) return i;
    }
    return -1;
  }

  function onActivate(hit) {
    try {
      const o = hit.object;
      const id = hit.instanceId;
      if (o === pads && id != null) playPad(id);
      else if (o === cymbals && id != null) playCymbal(id, 0.85);
      else if (o === lcd) setLabel(LINE1);
      else if (o !== rug && hit.point) {
        root.worldToLocal(_p.copy(hit.point));
        const i = o === beaters ? DRUMS.indexOf(kick) : o === heads && id != null ? id >> 1 : o === shells && id != null ? id : drumAt(_p);
        if (i >= 0) {
          const d = DRUMS[i];
          _rel.subVectors(_p, d.center);
          const ax = _rel.dot(d.n);
          const rad = Math.sqrt(Math.max(0, _rel.lengthSq() - ax * ax));
          playDrum(i, Math.max(0.55, Math.min(1, 1 - 0.35 * (rad / d.r))));
        }
      }
    } catch (err) {
      console.error("[drums] play failed", err);
    }
    return false; // the music panel still opens
  }

  function resolve(hit) {
    if (hit && hit.object === lcd && latest && latest.url) return { label: `▶ ${latest.title || "latest video"}`, url: latest.url };
    return null;
  }

  // ---- update: eased responses, allocation-free ----
  const DIP_TAU = 0.035; // head dip peaks at ~35 ms
  const STROKE_IN = 0.032, STROKE_OUT = 0.085; // beater: ease-in onto the head, exponential return
  function update(dt, t) {
    now = t;

    if (headsLive) {
      let any = false;
      for (let i = 0; i < DRUMS.length; i++) {
        const s = t - drumHitAt[i];
        const hb = headBase[DRUMS[i].batter];
        let off = 0;
        if (s >= 0 && s < 0.5) {
          const u = s / DIP_TAU;
          off = drumAmp[i] * u * Math.exp(1 - u);
          any = true;
        }
        _p.copy(hb.pos).addScaledVector(hb.inward, off);
        _m.compose(_p, hb.q, hb.s);
        heads.setMatrixAt(DRUMS[i].batter, _m);
      }
      heads.instanceMatrix.needsUpdate = true;
      headsLive = any;
    }

    if (beatersLive) {
      let any = false;
      for (let i = 0; i < 2; i++) {
        const s = t - beaterHitAt[i];
        let e = 0;
        if (s >= 0 && s < 0.7) {
          const u = s / STROKE_IN;
          e = u < 1 ? u * u : Math.exp(-(s - STROKE_IN) / STROKE_OUT);
          any = true;
        }
        _q.setFromAxisAngle(AXIS_X, beaterRestAng + (beaterHitAng - beaterRestAng) * e);
        _m.compose(beaterPivots[i], _q, ONE);
        beaters.setMatrixAt(i, _m);
      }
      beaters.instanceMatrix.needsUpdate = true;
      beatersLive = any;
    }

    if (cymsLive) {
      let any = false;
      for (let i = 0; i < cymBase.length; i++) {
        const c = cymBase[i];
        const s = t - cymHitAt[i];
        let ang = 0;
        if (s >= 0 && s < 3.5) {
          ang = c.amp * Math.exp(-1.6 * s) * Math.sin(s * 9.0);
          any = true;
        }
        const ph = cymPhase[i] + s * 2.4;
        _axis.set(Math.cos(ph), 0, Math.sin(ph));
        _qw.setFromAxisAngle(_axis, ang);
        _q.copy(c.q).multiply(_qw);
        _m.compose(c.pos, _q, c.s);
        cymbals.setMatrixAt(i, _m);
      }
      cymbals.instanceMatrix.needsUpdate = true;
      cymsLive = any;
    }

    if (padsLive) {
      let any = false;
      for (let i = 0; i < padHitAt.length; i++) {
        const s = t - padHitAt[i];
        let e = 0;
        if (s >= 0 && s < 0.6) {
          e = Math.exp(-s / 0.12);
          any = true;
        }
        _c.copy(padBase).lerp(padFlash, e);
        pads.setColorAt(i, _c);
      }
      pads.instanceColor.needsUpdate = true;
      padsLive = any;
    }

    if (lcdLabelUntil && t >= lcdLabelUntil) {
      lcdLabelUntil = 0;
      lcdLine1 = LINE1;
      lcdDirty = true;
    }
    if (lcdDirty || (scroll && t >= lcdNext)) {
      lcdNext = t + 0.1; // marquee at 10 Hz
      lcdDirty = false;
      drawLcd(scroll ? (t * 24) % (titleW + 48) : 0);
    }
  }

  const hotspots = [{ zone: "music", label: "YouTube", objects: [root], resolve, onActivate }];
  return { root, update, hotspots };
}
