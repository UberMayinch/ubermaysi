// objects/library.js — bookshelf on the E wall (SPEC §5.6) and the doorway to the essays.
//
// Local frame: x along the 3 m length (bay 1 at −x), y up, front faces +z (into the room after rotY).
// Carcass: one merged, chamfered, wood-grained mesh (vertex colours tint the back panel).
// Books: one InstancedMesh for the cloth covers (U-shaped: two boards + spine) plus one sharing its
// instanceMatrix for the cream page blocks, so book i is instance i in both. Spine bands are two more
// InstancedMeshes (cloth / gilt); they are not pickable, so a ray passes through them to the book.
// ctx.content.zones.library.items are mapped onto books on the eye-level shelves; mapped books get gilt
// bands and a slightly richer cloth, and resolve(hit) returns that post.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEG = Math.PI / 180;

export function build(scene, layout, ctx) {
  const L = layout.library;
  const B = L.books;
  const P = L.props || {};
  const rng = ctx.rng;
  const items = (ctx.content && ctx.content.zones && ctx.content.zones.library && ctx.content.zones.library.items) || [];

  const root = new THREE.Group();
  root.name = "library";
  root.position.fromArray(L.pos);
  root.rotation.y = L.rotY;

  // ---- dimensions ----------------------------------------------------------------------------------
  const W = L.width, H = L.height, D = L.depth, T = L.panel;
  const nBays = L.bays;
  const front = D / 2, back = -D / 2;
  const backFront = back + T; // inner face of the back panel
  const pitch = (W - T) / nBays; // panel centre spacing
  const sideX = Array.from({ length: nBays + 1 }, (_, i) => -W / 2 + T / 2 + i * pitch);
  const inner = pitch - T; // clear bay width (0.576)
  const bayLeft = (b) => sideX[b] + T / 2;
  const bayCentre = (b) => (sideX[b] + sideX[b + 1]) / 2;
  const levels = Array.from({ length: L.shelves }, (_, k) => L.baseShelfY + k * L.shelfSpacing); // shelf top surfaces
  const topUnder = H - T;
  const underside = (k) => (k + 1 < levels.length ? levels[k + 1] - T : topUnder);

  // ---- carcass -------------------------------------------------------------------------------------
  const oak = ctx.textures.wood({ kind: "grain", color: L.color, size: 512, rows: 4, plankWidth: 0.11, grain: 0.55, knots: 0.01, repeat: [1, 1], rng: rng.fork("oak") });
  const ws = oak.worldSize[0];
  const uvRng = rng.fork("uv");
  const pieces = [];
  // A board with chamfered long edges. `long` is the axis the grain (and the extrusion) runs along.
  const board = (sx, sy, sz, cx, cy, cz, long, tint = 1, ch = 0.0025) => {
    const len = long === "x" ? sx : long === "y" ? sy : sz;
    const [a, b] = long === "x" ? [sz, sy] : long === "y" ? [sx, sz] : [sx, sy];
    const c = Math.min(ch, a * 0.3, b * 0.3);
    const s = new THREE.Shape();
    const ha = a / 2, hb = b / 2;
    s.moveTo(-ha + c, -hb);
    s.lineTo(ha - c, -hb);
    s.lineTo(ha, -hb + c);
    s.lineTo(ha, hb - c);
    s.lineTo(ha - c, hb);
    s.lineTo(-ha + c, hb);
    s.lineTo(-ha, hb - c);
    s.lineTo(-ha, -hb + c);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: len, steps: 1, bevelEnabled: false, curveSegments: 1 });
    // grain along the extrusion: swap u/v and scale metres → texture tiles; random offset per board
    const uv = g.attributes.uv;
    const ou = uvRng.float(0, 1), ov = uvRng.float(0, 1);
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, v / ws + ou, u / ws + ov);
    }
    g.translate(0, 0, -len / 2);
    if (long === "x") g.rotateY(Math.PI / 2);
    else if (long === "y") g.rotateX(-Math.PI / 2);
    g.translate(cx, cy, cz);
    const col = new Float32Array(g.attributes.position.count * 3).fill(tint);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    pieces.push(g);
  };

  // sides: outer panels full depth, dividers stop at the back panel
  for (let i = 0; i <= nBays; i++) {
    const outer = i === 0 || i === nBays;
    const d = outer ? D : D - T;
    board(T, H - T, d, sideX[i], (H - T) / 2, outer ? 0 : (front + backFront) / 2, "y");
  }
  board(W, T, D, 0, H - T / 2, 0, "x"); // top
  board(W - 2 * T, H - T, T, 0, (H - T) / 2, back + T / 2, "x", 0.8, 0); // back panel, a shade darker
  const shelfDepth = front - backFront;
  for (let b = 0; b < nBays; b++) {
    for (const y of levels) board(inner, T, shelfDepth, bayCentre(b), y - T / 2, (front + backFront) / 2, "x");
    const kick = levels[0] - T; // recessed toe board under the base shelf
    board(inner, kick, 0.018, bayCentre(b), kick / 2, front - 0.03 - 0.009, "x", 0.72, 0.001);
  }
  const carcassGeo = mergeGeometries(pieces);
  for (const g of pieces) g.dispose();
  const carcassMat = new THREE.MeshStandardMaterial({
    map: oak.map, roughnessMap: oak.roughnessMap, bumpMap: oak.bumpMap, bumpScale: 0.35,
    roughness: 0.62, metalness: 0, vertexColors: true,
  });
  const carcass = new THREE.Mesh(carcassGeo, carcassMat);
  carcass.name = "libraryCarcass";
  carcass.castShadow = true;
  carcass.receiveShadow = true;
  root.add(carcass);

  // ---- book placement -------------------------------------------------------------------------------
  const books = []; // { pos, quat, w, h, d, k, b, lean, stack }
  const bRng = rng.fork("books");
  const thick = () => B.thickness[0] + (B.thickness[1] - B.thickness[0]) * Math.pow(bRng(), 1.75);
  const depthFor = (h) => THREE.MathUtils.clamp(B.depth[0] + ((h - B.height[0]) / (B.height[1] - B.height[0])) * 0.08 + bRng.gauss(0, 0.018), B.depth[0], B.depth[1]);
  const zFor = (d) => front - B.frontInset - bRng.float(0, 0.005) - d / 2;
  const qUp = new THREE.Quaternion();
  const stackBay = (B.stackBay || 3) - 1, stackShelf = B.stackShelf ?? 3;
  const objBay = (P.objectsBay || 5) - 1, objShelf = P.objectsShelf ?? 2;
  const props = {}; // bookend + box placement, filled in below

  for (let b = 0; b < nBays; b++) {
    for (let k = 0; k < levels.length; k++) {
      const y0 = levels[k] + 0.0003;
      const hMax = Math.min(B.height[1], underside(k) - levels[k] - B.clearance);
      const x0 = bayLeft(b), xEnd = x0 + inner;

      if (b === stackBay && k === stackShelf) {
        // horizontal stack of books, left of centre, leaving the rest of the shelf empty (ma)
        let y = y0;
        const cx = bayCentre(b) - 0.07;
        for (let i = 0; i < B.stackCount; i++) {
          const h = THREE.MathUtils.clamp(0.31 - i * 0.022 + bRng.float(-0.01, 0.01), B.height[0], B.height[1]);
          const d = THREE.MathUtils.clamp(0.225 - i * 0.016 + bRng.float(-0.008, 0.008), B.depth[0], B.depth[1]);
          const w = bRng.float(0.026, 0.044);
          const yaw = bRng.float(-3, 3) * DEG;
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, Math.PI / 2, "YXZ"));
          books.push({ pos: new THREE.Vector3(cx + bRng.float(-0.008, 0.008), y + w / 2, front - B.frontInset - 0.008 - d / 2), quat: q, w, h, d, k, b, stack: true });
          y += w + 0.0004;
        }
        continue;
      }

      const objects = b === objBay && k === objShelf;
      const fill = bRng.float(B.fill[0], B.fill[1]) * inner;
      const boxW = 0.13, endBase = 0.075, endPlate = 0.004;
      const reserve = objects ? endPlate + endBase + 0.035 + boxW : 0;
      const willLean = !objects && bRng.chance(0.9);
      const leanReserve = willLean ? 0.07 : 0;
      const runMean = k === 0 ? bRng.float(0.27, 0.31) : bRng.float(0.21, 0.28);
      let x = x0 + bRng.float(0.001, 0.006);
      let last = null;
      for (;;) {
        const w = thick();
        const h = THREE.MathUtils.clamp(bRng.gauss(runMean, 0.03), B.height[0], hMax);
        if (x + w > x0 + fill - reserve - leanReserve) break;
        const d = depthFor(h);
        last = { pos: new THREE.Vector3(x + w / 2, y0 + h / 2, zFor(d)), quat: qUp, w, h, d, k, b };
        books.push(last);
        x += w + bRng.float(0.0003, 0.0016);
      }

      if (willLean && last) {
        // Leaner: rotated CCW about z (top toward −x), its top-left corner resting on the neighbour's face.
        const xn = last.pos.x + last.w / 2;
        const w = thick();
        for (const deg of [bRng.float(B.leanDeg[0], B.leanDeg[1]), B.leanDeg[0]]) {
          const a = deg * DEG, ca = Math.cos(a), sa = Math.sin(a);
          let h = bRng.float(B.height[0], hMax);
          h = Math.min(h, last.h / ca, (underside(k) - levels[k] - B.clearance - w * sa) / ca);
          if (h < B.height[0]) continue;
          const px = xn + 0.0005 + h * sa; // bottom-left corner on the shelf
          if (px + w * ca > xEnd - 0.002) continue;
          const d = depthFor(h);
          const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
          const cx = px + (w / 2) * ca - (h / 2) * sa;
          const cy = y0 + (w / 2) * sa + (h / 2) * ca;
          books.push({ pos: new THREE.Vector3(cx, cy, zFor(d)), quat: q, w, h, d, k, b, lean: true });
          break;
        }
      }

      if (objects) {
        const xe = (last ? last.pos.x + last.w / 2 : x0) + 0.0005;
        props.bookend = { x: xe, y: levels[k], h: Math.min(0.16, hMax - 0.02) };
        props.box = { x: Math.min(xe + endPlate + endBase + 0.035 + boxW / 2, xEnd - boxW / 2 - 0.01), y: levels[k], w: boxW };
      }
    }
  }

  const n = books.length;

  // ---- map posts onto books ------------------------------------------------------------------------
  const linkShelves = B.linkShelves || [2, 3, 4];
  const mRng = rng.fork("map");
  const primary = [], secondary = [];
  books.forEach((bk, i) => (linkShelves.includes(bk.k) ? primary : secondary).push(i));
  mRng.shuffle(primary);
  mRng.shuffle(secondary);
  const chosen = primary.concat(secondary).slice(0, Math.min(items.length, n));
  // reading order: top linked shelf first, left to right (north to south) across the bays
  chosen.sort((i, j) => books[j].k - books[i].k || books[i].pos.x - books[j].pos.x);
  const byInstance = new Map();
  chosen.forEach((bi, idx) => byInstance.set(bi, items[idx]));

  // ---- instanced meshes ----------------------------------------------------------------------------
  const tB = 0.07, oB = 0.014, sB = 0.022, fB = 0.012; // board thickness, head/tail overhang, spine, fore-edge inset (unit space)
  const coverParts = [
    new THREE.BoxGeometry(tB, 1, 1).translate(-0.5 + tB / 2, 0, 0),
    new THREE.BoxGeometry(tB, 1, 1).translate(0.5 - tB / 2, 0, 0),
    new THREE.BoxGeometry(1 - 2 * tB, 1, sB).translate(0, 0, 0.5 - sB / 2),
  ];
  const coverGeo = mergeGeometries(coverParts);
  for (const g of coverParts) g.dispose();
  const pageDepth = 1 - sB - fB;
  const pageGeo = new THREE.BoxGeometry(1 - 2 * tB, 1 - 2 * oB, pageDepth).translate(0, 0, -0.5 + fB + pageDepth / 2);

  const covers = new THREE.InstancedMesh(coverGeo, new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0 }), n);
  covers.name = "books";
  const pages = new THREE.InstancedMesh(pageGeo, new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 }), n);
  pages.name = "bookPages";
  pages.instanceMatrix = covers.instanceMatrix; // same matrices: instance i is book i in both

  const m = new THREE.Matrix4(), mb = new THREE.Matrix4(), mt = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1), sc = new THREE.Vector3(), bp = new THREE.Vector3();
  const col = new THREE.Color(), paper = new THREE.Color();
  const cRng = rng.fork("colour");
  const palette = B.palette;
  let prev = -1;
  const bandsCloth = [], bandsGilt = []; // { m: Matrix4, color, book }
  const ivory = new THREE.Color("#e9dcc0");
  const gilt = new THREE.Color(B.gilt || "#cfa75a");

  for (let i = 0; i < n; i++) {
    const bk = books[i];
    m.compose(bk.pos, bk.quat, sc.set(bk.w, bk.h, bk.d));
    covers.setMatrixAt(i, m);

    let ci = cRng.int(0, palette.length - 1);
    if (ci === prev) ci = (ci + 1 + cRng.int(0, palette.length - 2)) % palette.length;
    prev = ci;
    col.set(palette[ci]);
    const mapped = byInstance.has(i);
    if (mapped) col.offsetHSL(0, 0.07, -0.015);
    else col.offsetHSL(cRng.float(-0.01, 0.01), cRng.float(-0.04, 0.02), cRng.float(-0.035, 0.03));
    covers.setColorAt(i, col);
    paper.setRGB(0.96, cRng.float(0.88, 0.94), cRng.float(0.74, 0.84), THREE.SRGBColorSpace);
    pages.setColorAt(i, paper);

    // spine bands: gilt on mapped books, lighter cloth on about half of the rest
    const banded = mapped || cRng.chance(0.5);
    if (!banded) continue;
    mt.compose(bk.pos, bk.quat, one);
    const bh = mapped ? 0.0035 : 0.005;
    const f = mapped ? 0.075 : cRng.float(0.08, 0.12);
    const bandCol = mapped ? gilt : col.clone().lerp(ivory, 0.32);
    for (const sgn of [1, -1]) {
      bp.set(0, sgn * (bk.h / 2 - f * bk.h), bk.d / 2 + 0.0006);
      mb.compose(bp, qUp, sc.set(bk.w * (1 - 2 * tB) * 0.96, bh, 0.0012));
      (mapped ? bandsGilt : bandsCloth).push({ m: mt.clone().multiply(mb), color: bandCol });
    }
  }
  covers.instanceMatrix.needsUpdate = true;
  covers.instanceColor.needsUpdate = true;
  pages.instanceColor.needsUpdate = true;
  covers.computeBoundingSphere();
  covers.computeBoundingBox();
  pages.computeBoundingSphere();
  pages.computeBoundingBox();
  for (const im of [covers, pages]) im.receiveShadow = true;
  root.add(covers, pages);

  const bandGeo = new THREE.BoxGeometry(1, 1, 1);
  const makeBands = (list, mat, name) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(bandGeo, mat, list.length);
    im.name = name;
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m);
      im.setColorAt(i, e.color);
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.raycast = () => {}; // never picked: a ray passes through to the book behind
    root.add(im);
    return im;
  };
  makeBands(bandsCloth, new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 }), "bookBands");
  makeBands(bandsGilt, new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0.75 }), "bookGilt");

  // ---- props: bookend + cord-tied kiri box (bay 5) ------------------------------------------------
  const pickProps = [];
  const z0 = (front + backFront) / 2;
  if (props.bookend) {
    const e = props.bookend;
    const g = mergeGeometries([
      new THREE.BoxGeometry(0.004, e.h, 0.12).translate(e.x + 0.002, e.y + e.h / 2, z0 + 0.02),
      new THREE.BoxGeometry(0.075, 0.0025, 0.12).translate(e.x + 0.004 + 0.0375, e.y + 0.00125, z0 + 0.02),
    ]);
    const bookend = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: P.iron || "#2a2826", roughness: 0.55, metalness: 0.6 }));
    bookend.name = "bookend";
    bookend.receiveShadow = true;
    root.add(bookend);
    pickProps.push(bookend);
  }
  if (props.box) {
    const bx = props.box;
    const bw = bx.w, bh = 0.075, bd = 0.17, lid = 0.018, zc = front - 0.04 - bd / 2;
    const parts = [];
    const tinted = (g, c) => {
      const cc = new THREE.Color(c);
      const a = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < a.length; i += 3) { a[i] = cc.r; a[i + 1] = cc.g; a[i + 2] = cc.b; }
      g.setAttribute("color", new THREE.BufferAttribute(a, 3));
      parts.push(g);
    };
    tinted(new THREE.BoxGeometry(bw - 0.004, bh - lid, bd - 0.004).translate(bx.x, bx.y + (bh - lid) / 2, zc), P.box || "#d6c19c");
    tinted(new THREE.BoxGeometry(bw, lid, bd).translate(bx.x, bx.y + bh - lid / 2, zc), new THREE.Color(P.box || "#d6c19c").offsetHSL(0, 0, 0.03));
    // sanada-himo cord: one loop around the box along z, one along x
    const cord = P.cord || "#3a3858";
    tinted(new THREE.BoxGeometry(0.006, bh + 0.003, bd + 0.003).translate(bx.x, bx.y + bh / 2 + 0.0005, zc), cord);
    tinted(new THREE.BoxGeometry(bw + 0.003, bh + 0.003, 0.006).translate(bx.x, bx.y + bh / 2 + 0.0005, zc), cord);
    const box = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }));
    for (const g of parts) g.dispose();
    box.name = "kiriBox";
    box.receiveShadow = true;
    root.add(box);
    pickProps.push(box);
  }

  // ---- plant on top of bay 2: dark glazed pot with an arching haran (aspidistra) -------------------
  {
    const pRng = rng.fork("plant");
    const cx = bayCentre((P.plantBay || 2) - 1), y = H, cz = -0.01;
    const potH = 0.1, potR = 0.07;
    const prof = [
      [0, 0], [potR * 0.72, 0], [potR * 0.78, 0.004], [potR * 0.92, potH * 0.35], [potR, potH * 0.82],
      [potR * 0.98, potH], [potR * 0.9, potH], [potR * 0.88, potH * 0.86],
    ].map(([r, h]) => new THREE.Vector2(r, h));
    const potGeo = new THREE.LatheGeometry(prof, 28);
    const soil = new THREE.CircleGeometry(potR * 0.88, 20).rotateX(-Math.PI / 2).translate(0, potH * 0.86, 0);
    const parts = [potGeo.toNonIndexed(), soil.toNonIndexed()];
    potGeo.dispose();
    soil.dispose();
    const colours = [new THREE.Color(P.pot || "#3b3733"), new THREE.Color("#2a2119")];
    parts.forEach((g, i) => {
      g.deleteAttribute("uv");
      const a = new Float32Array(g.attributes.position.count * 3);
      for (let j = 0; j < a.length; j += 3) { a[j] = colours[i].r; a[j + 1] = colours[i].g; a[j + 2] = colours[i].b; }
      g.setAttribute("color", new THREE.BufferAttribute(a, 3));
    });
    const pot = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05 }));
    pot.name = "plantPot";
    pot.position.set(cx, y, cz);
    pot.receiveShadow = true;
    root.add(pot);
    pickProps.push(pot);

    // leaves: strips with a folded mid-rib, petiole narrow then a broad lanceolate blade, arching outward
    const pos = [], clr = [], idx = [];
    const base = new THREE.Color(P.leaf || "#3f5a36"), tip = base.clone().offsetHSL(0.02, 0.05, 0.08), stem = base.clone().offsetHSL(-0.03, -0.05, 0.06);
    const maxH = (P.plantMaxHeight || 0.26) - potH; // leaves stay under the ceiling and inside the depth
    const reach = D / 2 - 0.02;
    const nLeaves = 12, seg = 10;
    const c = new THREE.Color();
    for (let l = 0; l < nLeaves; l++) {
      const yaw = (l / nLeaves) * Math.PI * 2 + pRng.float(-0.3, 0.3);
      const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      const len = pRng.float(0.16, 0.24), wid = pRng.float(0.04, 0.058);
      const phi0 = pRng.float(6, 22) * DEG, phi1 = phi0 + pRng.float(45, 75) * DEG;
      // integrate the centreline, then scale to fit height / reach limits
      const pts = [];
      const p = new THREE.Vector3(pRng.float(-0.01, 0.01), 0, pRng.float(-0.01, 0.01));
      for (let s = 0; s <= seg; s++) {
        pts.push(p.clone());
        const phi = phi0 + (phi1 - phi0) * Math.pow(s / seg, 1.6);
        p.addScaledVector(dir, Math.sin(phi) * (len / seg)).y += Math.cos(phi) * (len / seg);
      }
      let top = 0, out = 0;
      for (const q of pts) { top = Math.max(top, q.y); out = Math.max(out, Math.hypot(q.x, q.z)); }
      const fit = Math.min(1, maxH / top, reach / out);
      const start = pos.length / 3;
      for (let s = 0; s <= seg; s++) {
        const t = s / seg;
        const q = pts[s].multiplyScalar(fit);
        const blade = t < 0.3 ? 0.08 : Math.sin(Math.PI * Math.pow((t - 0.3) / 0.7, 0.75));
        const hw = (wid * fit * Math.max(0.08, blade)) / 2;
        const fold = hw * 0.35;
        c.copy(t < 0.3 ? stem : base).lerp(tip, Math.max(0, t - 0.5));
        for (const [o, lift] of [[-1, 0], [0, fold], [1, 0]]) {
          pos.push(cx + q.x + side.x * hw * o, y + potH * 0.86 + q.y + lift, cz + q.z + side.z * hw * o);
          clr.push(c.r, c.g, c.b);
        }
        if (s < seg) {
          const r0 = start + s * 3, r1 = r0 + 3;
          idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1, r0 + 1, r1 + 1, r0 + 2, r0 + 2, r1 + 1, r1 + 2);
        }
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute("color", new THREE.Float32BufferAttribute(clr, 3));
    lg.setIndex(idx);
    lg.computeVertexNormals();
    const leaves = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }));
    leaves.name = "plantLeaves";
    leaves.receiveShadow = true;
    root.add(leaves);
    pickProps.push(leaves);
  }

  scene.add(root);

  // ---- hotspot -------------------------------------------------------------------------------------
  const zone = ctx.content && ctx.content.zones && ctx.content.zones.library;
  const resolve = (hit) => {
    if (!hit || (hit.object !== covers && hit.object !== pages) || hit.instanceId == null) return null;
    const it = byInstance.get(hit.instanceId);
    return it && it.url ? { label: it.title || "untitled", url: it.url } : null;
  };

  return {
    root,
    books: covers,
    bookItems: byInstance,
    hotspots: [{ zone: "library", label: (zone && zone.title ? zone.title.toLowerCase() : "library") + " — essays and criticism", objects: [carcass, covers, pages, ...pickProps], resolve }],
  };
}
