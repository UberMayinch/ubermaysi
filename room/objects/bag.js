// objects/bag.js — heavy punching bag on a chain + damped spherical pendulum (SPEC §6).
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), colliders: [bagMesh], hit, state }.
//   hit(dirX, dirZ, strength = 1, hitPointWorld?) -> boolean   (false when debounced)
//   state() -> { angleDeg, omega: [ωx, ωz], theta: [θx, θz], yawDeg }
//
// Hierarchy (y measured from the anchor, which is the ceiling plane):
//   root
//     plate            black hook plate + fixed eye (static)
//     pivot            at the anchor; quaternion = swing tilt
//       swivel         top eye, barrel, bottom eye
//       yaw            rotation.y = twist ψ
//         chain        InstancedMesh of oval links, alternating 90°
//         hardware     O-ring + four D-rings on the top cap (merged)
//         straps       four black leather straps (merged)
//         body         origin at the bag top: squash scales about here
//           bagMesh    leather lathe (the only collider)
//           cap        black top-cap ring
//
// The integrator (stepPendulum / applyHit) is pure and THREE-free so it can be tested in Node.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------
// Pure physics
// ---------------------------------------------------------------------------------------------------

/** Physics constants from LAYOUT.bag. */
export function pendulumParams(b) {
  const tw = b.twist || { omega0: 1.5, damping: 1.2, gain: 2.0, maxDeg: 25 };
  return {
    w0sq: b.g / b.L, // ω0² ≈ 8.18
    c: b.damping, // s⁻¹
    thetaMax: b.thetaMax, // rad
    L: b.L,
    hit: b.hit, // rad/s per unit strength at h = L
    hMin: b.hitHeight[0],
    hMax: b.hitHeight[1],
    tw0sq: tw.omega0 * tw.omega0,
    tc: tw.damping,
    tGain: tw.gain,
    psiMax: tw.maxDeg * DEG,
  };
}

/** Fresh state: tilt θ, angular velocity ω, yaw ψ and yaw rate. */
export function createState() {
  return { tx: 0, tz: 0, wx: 0, wz: 0, psi: 0, wpsi: 0 };
}

/**
 * One semi-implicit Euler step (SPEC §6.2), in place, allocation-free.
 * α = −ω0²·θ − c·ω per component; ω += α·dt; θ += ω·dt; clamp |θ| at θmax and drop the outward radial ω.
 * Twist ψ: same damped spring with its own constants, clamped at ±psiMax.
 */
export function stepPendulum(s, p, dt) {
  s.wx += (-p.w0sq * s.tx - p.c * s.wx) * dt;
  s.wz += (-p.w0sq * s.tz - p.c * s.wz) * dt;
  s.tx += s.wx * dt;
  s.tz += s.wz * dt;
  const m = Math.hypot(s.tx, s.tz);
  if (m > p.thetaMax) {
    const nx = s.tx / m, nz = s.tz / m;
    s.tx = nx * p.thetaMax;
    s.tz = nz * p.thetaMax;
    const radial = s.wx * nx + s.wz * nz;
    if (radial > 0) {
      s.wx -= radial * nx;
      s.wz -= radial * nz;
    }
  }
  s.wpsi += (-p.tw0sq * s.psi - p.tc * s.wpsi) * dt;
  s.psi += s.wpsi * dt;
  if (s.psi > p.psiMax) {
    s.psi = p.psiMax;
    if (s.wpsi > 0) s.wpsi = 0;
  } else if (s.psi < -p.psiMax) {
    s.psi = -p.psiMax;
    if (s.wpsi < 0) s.wpsi = 0;
  }
  return s;
}

/**
 * Apply one punch (SPEC §6.4), in place. (dirX, dirZ) world-horizontal, normalised here.
 * h = anchor → hit point distance along the bag axis (clamped hMin..hMax; pass p.L for a centre hit).
 * lever = signed horizontal offset of the hit line from the bag axis, (r × d̂)·ŷ, in metres (0 = centre).
 * Returns Δω magnitude (rad/s), or 0 if the direction is degenerate.
 */
export function applyHit(s, p, dirX, dirZ, strength = 1, h = p.L, lever = 0) {
  const len = Math.hypot(dirX, dirZ);
  if (!(len > 1e-6) || !(strength > 0)) return 0;
  const hc = Math.min(p.hMax, Math.max(p.hMin, h));
  const dw = p.hit * strength * (hc / p.L);
  s.wx += (dirX / len) * dw;
  s.wz += (dirZ / len) * dw;
  s.wpsi += p.tGain * lever * strength;
  return dw;
}

/** Swing angle |θ| in degrees. */
export const angleDeg = (s) => Math.hypot(s.tx, s.tz) / DEG;

// ---------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------

/** Resample a polyline profile at uniform arc length so LatheGeometry's v = j/(n−1) is proportional. */
function resample(points, count) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  let k = 1;
  for (let j = 0; j < count; j++) {
    const d = (total * j) / (count - 1);
    while (k < points.length - 1 && cum[k] < d) k++;
    const span = cum[k] - cum[k - 1] || 1;
    const f = Math.min(1, Math.max(0, (d - cum[k - 1]) / span));
    const a = points[k - 1], b = points[k];
    out.push(new THREE.Vector2(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f));
  }
  return { points: out, length: total };
}

/** Quarter arc from angle a0 to a1 (radians) around (cx, cy), as [x, y] pairs, excluding the start. */
function arc(cx, cy, r, a0, a1, steps) {
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/** Oval chain link (stadium centreline swept by a round wire) in the local xy plane, long axis y. */
function linkGeometry(outerLength, outerWidth, wire) {
  const rc = outerWidth / 2 - wire; // centreline radius of the bends
  const hs = outerLength / 2 - wire - rc; // half-length of the straight sides
  const per = 4 * hs + 2 * Math.PI * rc;
  class Stadium extends THREE.Curve {
    getPoint(t, target = new THREE.Vector3()) {
      let d = t * per;
      // start at the right straight's bottom, go up, over the top bend, down the left, under the bottom bend
      if (d < 2 * hs) return target.set(rc, -hs + d, 0);
      d -= 2 * hs;
      if (d < Math.PI * rc) {
        const a = d / rc;
        return target.set(rc * Math.cos(a), hs + rc * Math.sin(a), 0);
      }
      d -= Math.PI * rc;
      if (d < 2 * hs) return target.set(-rc, hs - d, 0);
      d -= 2 * hs;
      const a = Math.PI + d / rc;
      return target.set(rc * Math.cos(a), -hs + rc * Math.sin(a), 0);
    }
  }
  return new THREE.TubeGeometry(new Stadium(), 28, wire, 6, true);
}

/** Box from a to b (centreline), `width` along `side`, `thick` along side × dir. */
function strapGeometry(a, b, width, thick, side) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.divideScalar(len);
  const x = side.clone().sub(dir.clone().multiplyScalar(side.dot(dir))).normalize();
  const z = new THREE.Vector3().crossVectors(x, dir).normalize();
  const g = new THREE.BoxGeometry(width, len, thick);
  const m = new THREE.Matrix4().makeBasis(x, dir, z);
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return g;
}

// ---------------------------------------------------------------------------------------------------
// Textures: leather with panel seams and double stitching
// ---------------------------------------------------------------------------------------------------

/**
 * Bag skin. u = around (lathe φ), v = profile arc length from the bottom centre (v = 0) to the top centre (v = 1).
 * seamsU: vertical seams; seamsV: horizontal seams where the end discs meet the body.
 */
function bagSkin(ctx, color, seamsU, seamsV) {
  const T = ctx.textures;
  const skin = T.leather({ size: 1024, color, wear: 0.55, repeat: [1, 1], rng: ctx.rng.fork("leather") });
  const c = skin.ctx, S = skin.canvas.width;
  const b = skin.bumpMap.image.getContext("2d");
  const r = skin.roughnessMap.image.getContext("2d");
  const rs = skin.roughnessMap.image.width / S; // roughness canvas is half size (its ctx is pre-scaled; reset)
  r.setTransform(rs, 0, 0, rs, 0, 0);
  const rng = ctx.rng.fork("stitch");
  const crease = T.shade(color, -0.55, 0.85);
  const halo = T.shade(color, -0.3, 0.35);
  const thread = T.shade(color, 0.32, 0.9);
  const stitchLen = S * 0.006, gap = S * 0.0045, off = S * 0.0075;

  // one seam along a line: dark crease + soft shadow, embossed in the bump map, stitches on both sides
  const seam = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = -uy, ny = ux;
    c.lineCap = "round";
    c.strokeStyle = halo;
    c.lineWidth = S * 0.007;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    c.strokeStyle = crease;
    c.lineWidth = S * 0.0022;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    b.lineCap = "round";
    b.strokeStyle = "rgba(255,255,255,0.55)"; // puffed panel edges
    b.lineWidth = S * 0.012;
    b.beginPath(); b.moveTo(x0, y0); b.lineTo(x1, y1); b.stroke();
    b.strokeStyle = "#202020"; // the groove itself
    b.lineWidth = S * 0.003;
    b.beginPath(); b.moveTo(x0, y0); b.lineTo(x1, y1); b.stroke();
    r.strokeStyle = "rgba(255,255,255,0.35)"; // creases are a touch rougher
    r.lineWidth = S * 0.004;
    r.beginPath(); r.moveTo(x0, y0); r.lineTo(x1, y1); r.stroke();
    for (const side of [-1, 1]) {
      const sx = nx * off * side, sy = ny * off * side;
      for (let d = gap * 0.5; d < len - stitchLen; d += stitchLen + gap) {
        const j = rng.float(-0.12, 0.12) * gap;
        const ax = x0 + ux * (d + j) + sx, ay = y0 + uy * (d + j) + sy;
        const bx = ax + ux * stitchLen, by = ay + uy * stitchLen;
        c.strokeStyle = thread;
        c.lineWidth = S * 0.0016;
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
        b.strokeStyle = "rgba(255,255,255,0.7)";
        b.lineWidth = S * 0.0018;
        b.beginPath(); b.moveTo(ax, ay); b.lineTo(bx, by); b.stroke();
      }
    }
  };
  // canvas y runs down while texture v runs up (flipY): v -> y = (1 − v)·S
  for (const u of seamsU) seam(u * S, (1 - seamsV[1]) * S, u * S, (1 - seamsV[0]) * S);
  for (const v of seamsV) {
    const y = (1 - v) * S;
    seam(-S * 0.01, y, S * 1.01, y);
  }
  // a little extra handling wear around the strike zone (body centre), very soft
  const g = c.createLinearGradient(0, (1 - seamsV[1]) * S, 0, (1 - seamsV[0]) * S);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.45, T.shade(color, 0.12, 0.08));
  g.addColorStop(0.6, T.shade(color, 0.12, 0.08));
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  skin.map.needsUpdate = skin.bumpMap.needsUpdate = skin.roughnessMap.needsUpdate = true;
  return skin;
}

// ---------------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------------

export function build(scene, layout, ctx) {
  const b = layout.bag;
  const A = b.anchor;
  const R = b.diameter / 2; // 0.175
  const H = b.height; // 1.20
  const topLocal = b.topY - A[1]; // −0.60 (anchor-relative)
  const ringY = -b.chainLength; // −0.45: chain + hardware from the anchor down to the O-ring centre

  const root = new THREE.Group();
  root.name = "bag";

  // ---- materials ----
  const steel = new THREE.MeshStandardMaterial({ color: "#9a9a96", metalness: 0.9, roughness: 0.35 });
  const blackMetal = new THREE.MeshStandardMaterial({ color: "#232220", metalness: 0.6, roughness: 0.45 });
  const capSkin = ctx.textures.leather({ size: 256, color: "#1b1816", wear: 0.3, repeat: [4, 1], rng: ctx.rng.fork("cap") });
  const blackLeather = new THREE.MeshStandardMaterial({
    color: "#ffffff", map: capSkin.map, bumpMap: capSkin.bumpMap, bumpScale: 0.6,
    roughnessMap: capSkin.roughnessMap, roughness: 0.6,
  });

  // ---- hook plate + fixed eye (static, in root) ----
  {
    const parts = [];
    const plate = new THREE.CylinderGeometry(0.05, 0.054, 0.012, 32);
    plate.translate(0, -0.006, 0);
    parts.push(plate);
    for (let i = 0; i < 4; i++) {
      // four bolt heads
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const bolt = new THREE.CylinderGeometry(0.0065, 0.0075, 0.004, 6);
      bolt.translate(Math.cos(a) * 0.034, -0.014, Math.sin(a) * 0.034);
      parts.push(bolt);
    }
    const boss = new THREE.CylinderGeometry(0.009, 0.011, 0.008, 12);
    boss.translate(0, -0.016, 0);
    parts.push(boss);
    const eye = new THREE.TorusGeometry(0.011, 0.0035, 8, 16, Math.PI); // arc in xy, opening up
    eye.rotateZ(Math.PI);
    eye.translate(0, -0.014, 0);
    parts.push(eye);
    const mesh = new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), blackMetal);
    mesh.name = "bagPlate";
    mesh.position.fromArray(A);
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // ---- pivot (swing) ----
  const pivot = new THREE.Group();
  pivot.name = "bagPivot";
  pivot.position.fromArray(A);
  root.add(pivot);

  // swivel: top eye (zy plane) hooked through the fixed eye, a turned barrel, bottom eye (xy plane)
  const swivelBottom = -0.088; // centre of the bottom eye
  {
    const parts = [];
    const topEye = new THREE.TorusGeometry(0.0095, 0.0032, 8, 20);
    topEye.rotateY(Math.PI / 2);
    topEye.translate(0, -0.031, 0);
    parts.push(topEye);
    const barrel = new THREE.LatheGeometry(
      [[0.0001, -0.072], [0.0085, -0.072], [0.011, -0.068], [0.011, -0.05], [0.0075, -0.044], [0.0045, -0.041], [0.0001, -0.041]].map(([x, y]) => new THREE.Vector2(x, y)),
      16,
    );
    parts.push(barrel);
    const neck = new THREE.CylinderGeometry(0.0035, 0.0035, 0.008, 8);
    neck.translate(0, -0.076, 0);
    parts.push(neck);
    const botEye = new THREE.TorusGeometry(0.0085, 0.0032, 8, 20);
    botEye.translate(0, swivelBottom, 0);
    parts.push(botEye);
    const mesh = new THREE.Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), steel);
    mesh.name = "bagSwivel";
    pivot.add(mesh);
  }

  const yaw = new THREE.Group();
  yaw.name = "bagYaw";
  pivot.add(yaw);

  // ---- chain: interlocking oval links, alternating 90° ----
  const LINK = { length: 0.04, width: 0.024, wire: 0.0034 };
  const pitch = LINK.length - 4 * LINK.wire; // inner length: each link drops by this much
  const eyeBottomWire = swivelBottom - 0.0085; // centre of the swivel eye's lowest wire
  const firstCentre = eyeBottomWire + 2 * LINK.wire - (LINK.length / 2 - LINK.wire);
  // O-ring (vertical, in the zy plane since the last link alternates) — its top wire hangs in the last link
  const ORING = { r: 0.019, wire: 0.0042 };
  const nLinks = Math.max(4, Math.round((firstCentre - (ringY + ORING.r) - (LINK.length / 2 - LINK.wire)) / pitch) + 1);
  const lastBottomWire = firstCentre - (nLinks - 1) * pitch - (LINK.length / 2 - LINK.wire);
  const ringCentre = lastBottomWire + LINK.wire + ORING.wire - ORING.r; // ≈ ringY
  {
    const geo = linkGeometry(LINK.length, LINK.width, LINK.wire);
    const chain = new THREE.InstancedMesh(geo, steel, nLinks);
    chain.name = "bagChain";
    const rng = ctx.rng.fork("chain");
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < nLinks; i++) {
      // link 0 sits in the zy plane (perpendicular to the swivel's xy bottom eye)
      const a = (i % 2 === 0 ? Math.PI / 2 : 0) + rng.float(-4, 4) * DEG;
      q.setFromAxisAngle(up, a);
      p.set(0, firstCentre - i * pitch, 0);
      chain.setMatrixAt(i, m.compose(p, q, one));
    }
    chain.instanceMatrix.needsUpdate = true;
    chain.computeBoundingSphere();
    yaw.add(chain);
  }
  const ringPlaneZY = nLinks % 2 === 0; // last link in xy -> ring in zy, and vice versa

  // ---- body group (origin at the bag top; squash scales about here) ----
  const body = new THREE.Group();
  body.name = "bagBody";
  body.position.y = topLocal;
  yaw.add(body);

  // leather lathe: flat ends with a rounded edge, a barely-there fullness through the middle
  const E = 0.04; // edge radius
  const Rs = R - 0.004; // radius at the ends; the middle swells to R
  const prof = [[0, -H]];
  prof.push([Rs - E, -H]);
  prof.push(...arc(Rs - E, -H + E, E, -Math.PI / 2, 0, 8));
  for (let i = 1; i < 16; i++) {
    const y = -H + E + ((H - 2 * E) * i) / 16;
    const t = (y + H / 2) / (H / 2 - E); // −1..1
    prof.push([R - 0.004 * t * t, y]);
  }
  prof.push([Rs, -E]);
  prof.push(...arc(Rs - E, -E, E, 0, Math.PI / 2, 8));
  prof.push([0, 0]);
  const lathe = resample(prof, 96);
  // where the end discs meet the body, as v fractions (the horizontal seams)
  const vBottom = (Rs - E + (Math.PI / 2) * E * 0.5) / lathe.length;
  const vTop = 1 - vBottom;
  const SEGMENTS = 48;
  const SEAMS = 4; // vertical panel seams at φ = 45°, 135°, … (u = 1/8, 3/8, …)
  const seamsU = Array.from({ length: SEAMS }, (_, i) => (i + 0.5) / SEAMS);
  const skin = bagSkin(ctx, b.color, seamsU, [vBottom, vTop]);
  const bagGeo = new THREE.LatheGeometry(lathe.points, SEGMENTS);
  const leather = new THREE.MeshStandardMaterial({
    color: "#ffffff", map: skin.map, bumpMap: skin.bumpMap, bumpScale: 0.9,
    roughnessMap: skin.roughnessMap, roughness: 0.55,
  });
  const bagMesh = new THREE.Mesh(bagGeo, leather);
  bagMesh.name = "bagMesh";
  bagMesh.castShadow = true;
  bagMesh.receiveShadow = true;
  body.add(bagMesh);

  // LatheGeometry places φ = 2π·u at (x, z) = (r·sin φ, r·cos φ)
  const atPhi = (phi, r, y, target = new THREE.Vector3()) => target.set(r * Math.sin(phi), y, r * Math.cos(phi));

  // top cap: black reinforcement over the top edge and the whole top face
  const CAP = { band: 0.055, t: 0.0025 };
  {
    const pts = [[Rs + CAP.t * 0.4, -CAP.band - 0.0005], [Rs + CAP.t, -CAP.band + 0.002]];
    pts.push([Rs + CAP.t, -E]);
    pts.push(...arc(Rs - E, -E, E + CAP.t, 0, Math.PI / 2, 8));
    pts.push([0.04, CAP.t], [0, CAP.t]); // covers the whole top face
    const capGeo = new THREE.LatheGeometry(resample(pts, 40).points, SEGMENTS);
    const cap = new THREE.Mesh(capGeo, blackLeather);
    cap.name = "bagCap";
    cap.receiveShadow = true;
    body.add(cap);
  }

  // ---- straps and hardware (yaw space, anchor-relative y) ----
  const STRAP = { width: 0.026, thick: 0.0035, attachR: 0.105 };
  const capTop = topLocal + CAP.t; // top face of the cap
  {
    const strapParts = [], hw = [];
    // O-ring
    const oring = new THREE.TorusGeometry(ORING.r, ORING.wire, 10, 28);
    if (ringPlaneZY) oring.rotateY(Math.PI / 2);
    oring.translate(0, ringCentre, 0);
    hw.push(oring);
    const ringBottom = ringCentre - ORING.r;
    const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), side = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0), rot = new THREE.Quaternion();
    for (let i = 0; i < SEAMS; i++) {
      const phi = seamsU[i] * Math.PI * 2;
      // D-ring standing on the cap, in the radial plane
      const D = { r: 0.011, wire: 0.0026 };
      const dring = new THREE.TorusGeometry(D.r, D.wire, 6, 14, Math.PI);
      dring.rotateY(phi + Math.PI / 2); // arc plane contains the radial direction
      dring.translate(...atPhi(phi, STRAP.attachR, capTop + D.wire * 0.5).toArray());
      hw.push(dring);
      const foot = new THREE.BoxGeometry(0.03, 0.003, 0.012); // clip plate riveted to the cap
      foot.rotateY(phi + Math.PI / 2);
      foot.translate(...atPhi(phi, STRAP.attachR, capTop + 0.0015).toArray());
      hw.push(foot);
      // strap: from the bottom of the O-ring to the top of the D-ring, flat face outward
      atPhi(phi, 0.006, ringBottom + 0.002, tmpA);
      atPhi(phi, STRAP.attachR - 0.002, capTop + D.r + D.wire * 0.5, tmpB);
      side.set(Math.cos(phi), 0, -Math.sin(phi)); // tangential direction at φ
      strapParts.push(strapGeometry(tmpA, tmpB, STRAP.width, STRAP.thick, side));
      // folded tail: a short second layer at the D-ring end
      const tail = tmpA.clone().lerp(tmpB, 0.8);
      const dir = tmpB.clone().sub(tmpA).normalize();
      const out = new THREE.Vector3().crossVectors(side, dir).normalize().multiplyScalar(STRAP.thick);
      strapParts.push(strapGeometry(tail.add(out), tmpB.clone().add(out), STRAP.width * 0.96, STRAP.thick, side));
      // two rivets through the fold, axis along `out`
      rot.setFromUnitVectors(up, out.clone().normalize());
      for (const f of [0.86, 0.94]) {
        const pos = tmpA.clone().lerp(tmpB, f).add(out.clone().multiplyScalar(0.5));
        const rv = new THREE.CylinderGeometry(0.0032, 0.0032, STRAP.thick * 2 + 0.003, 8);
        rv.applyQuaternion(rot).translate(pos.x, pos.y, pos.z);
        hw.push(rv);
      }
    }
    const straps = new THREE.Mesh(mergeGeometries(strapParts.map((g) => g.toNonIndexed())), blackLeather);
    straps.name = "bagStraps";
    straps.receiveShadow = true;
    yaw.add(straps);
    const hardware = new THREE.Mesh(mergeGeometries(hw.map((g) => g.toNonIndexed())), steel);
    hardware.name = "bagHardware";
    yaw.add(hardware);
  }

  scene.add(root);

  // ---- simulation ----
  const P = pendulumParams(b);
  const S = createState();
  const sq = b.squash || { scale: [1.04, 0.97, 1.04], ms: 120 };
  let squash = 0; // 1 right after a hit, eases to 0
  let lastHit = -Infinity;
  const axis = new THREE.Vector3();
  const qInv = new THREE.Quaternion();
  const rel = new THREE.Vector3();
  const dLocal = new THREE.Vector3();

  function update(dt) {
    stepPendulum(S, P, dt);
    const m = Math.hypot(S.tx, S.tz);
    if (m < 1e-6) pivot.quaternion.identity();
    else pivot.quaternion.setFromAxisAngle(axis.set(-S.tz, 0, S.tx).normalize(), m);
    yaw.rotation.y = S.psi;
    if (squash > 0) {
      squash = Math.max(0, squash - dt / (sq.ms / 1000));
      const k = squash * squash * (3 - 2 * squash); // smoothstep ease back
      body.scale.set(1 + (sq.scale[0] - 1) * k, 1 + (sq.scale[1] - 1) * k, 1 + (sq.scale[2] - 1) * k);
    } else if (body.scale.x !== 1) body.scale.set(1, 1, 1);
  }

  function hit(dirX, dirZ, strength = 1, point) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - lastHit < b.debounceMs) return false;
    const len = Math.hypot(dirX, dirZ);
    if (!(len > 1e-6)) return false;
    let h = P.L, lever = 0;
    if (point && point.isVector3) {
      // into the swinging bag's frame: −y is down the bag axis, xz is the offset from the axis
      qInv.copy(pivot.quaternion).invert();
      rel.set(point.x - A[0], point.y - A[1], point.z - A[2]).applyQuaternion(qInv);
      h = -rel.y;
      dLocal.set(dirX / len, 0, dirZ / len).applyQuaternion(qInv);
      // yaw frame also rotated by ψ, but the torque is about the same axis, so ψ doesn't matter here
      lever = rel.z * dLocal.x - rel.x * dLocal.z; // (r × d̂)·ŷ
      lever = Math.max(-R, Math.min(R, lever));
    }
    const dw = applyHit(S, P, dirX, dirZ, strength, h, lever);
    if (!dw) return false;
    lastHit = now;
    squash = 1;
    if (ctx.audio && typeof ctx.audio.bagHit === "function") ctx.audio.bagHit(dw / P.hit);
    return true;
  }

  const state = () => ({ angleDeg: angleDeg(S), omega: [S.wx, S.wz], theta: [S.tx, S.tz], yawDeg: S.psi / DEG });

  return { root, update, colliders: [bagMesh], hit, state };
}
