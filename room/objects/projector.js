// objects/projector.js — S-wall projector + bracket, linen curtain on a ceiling track, the projected canvas
// image on the cloth (following its folds), beam pyramid and SpotLight.
// Contract: build(scene, layout, ctx) -> { root, update(dt, t), hotspots }.
// The projector SpotLight is owned here (main.js only owns the hemisphere, ceiling spot and fill lights).
//
// Curtain: one displaced grid whose vertex lines fall exactly on the image rectangle. Two meshes share its
// position / normal / uv attributes with different index buffers: "curtainCloth" (the cells outside the
// image, plain linen, noPick) and "projection" (the cells inside: linen + the canvas as an emissive map,
// the zone hotspot). From behind, the image material shows the canvas mirrored, blurred and dim, like light
// through cloth. Both cast shadows. Walk-through: the only footprint is the overhead track.
// Motion (skipped under reduced motion): an almost imperceptible sway, and a per-column spring pushed by the
// player within ripple.near of the line; vertices + analytic normals rewritten in place on a `t` throttle.
//
// Draw calls (main pass): body 1, LED 1, metal (bracket + track) 1, cloth 1, image 1, beam 1 = 6;
// shadow pass: cloth + image = 2.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const ACCENT = "#e08a5f";
const OFFWHITE = "#e9e6e0";
const BG = "#141312";
const SERIF = "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const CARD_PERIOD = 8; // seconds per title card
const CARD_FADE = 1.0; // crossfade length
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LINEN_TILE = 0.32; // metres of cloth per linen texture tile

const ease = (x) => { x = x < 0 ? 0 : x > 1 ? 1 : x; return x * x * (3 - 2 * x); };
const sstep = (a, b, x) => ease((x - a) / (b - a));

function boxGeo(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Flat vertex colour on a (non-indexed) geometry. */
function tint(g, hex) {
  if (g.index) g = g.toNonIndexed();
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

function formatDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).slice(0, 16);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** n segments from a to b appended to arr (a excluded when skipFirst). */
function span(arr, a, b, n, skipFirst) {
  for (let i = skipFirst ? 1 : 0; i <= n; i++) arr.push(a + ((b - a) * i) / n);
}

/** Natural linen: fine warp / weft lines at very low contrast, irregular slub threads, grain. Tileable. */
function linenTexture(T, color, rng) {
  const S = 512;
  const { canvas, ctx: c } = T.makeCanvas(S);
  c.fillStyle = color;
  c.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += 2) { c.fillStyle = `rgba(0,0,0,${(0.02 + rng.float(0, 0.03)).toFixed(3)})`; c.fillRect(0, y, S, 1); }
  for (let x = 0; x < S; x += 2) { c.fillStyle = `rgba(255,255,255,${(0.015 + rng.float(0, 0.03)).toFixed(3)})`; c.fillRect(x, 0, 1, S); }
  for (let i = 0; i < 340; i++) {
    const horiz = i % 3 !== 0;
    const a = rng.float(0, S), b = rng.float(0, S), len = rng.float(16, 150), w = rng.float(0.8, 2.2);
    c.fillStyle = rng.chance(0.55) ? `rgba(255,250,240,${rng.float(0.05, 0.14).toFixed(3)})` : `rgba(70,55,38,${rng.float(0.02, 0.05).toFixed(3)})`;
    for (const o of [0, -S]) {
      if (horiz) c.fillRect(a + o, b, len, w);
      else c.fillRect(b, a + o, w, len);
    }
  }
  T.grainOverlay(c, S, S, { rng, amount: 0.035, scale: 5, fine: 0.02 });
  return T.toTexture(canvas, { srgb: true, wrap: true });
}

export function build(scene, layout, ctx) {
  const p = layout.projector;
  const root = new THREE.Group();
  root.name = "projector";

  const bodyW = p.body.size[0], bodyH = p.body.size[1], bodyD = p.body.size[2];

  // ---- body: one vertex-coloured mesh (shell, vents, knob, lens housing, glass) ---------------------
  // local frame: +z is the front, rotY = π points it at the curtain
  const body = new THREE.Group();
  body.name = "projectorBody";
  body.position.fromArray(p.body.pos);
  body.rotation.y = p.body.rotY;
  root.add(body);

  const front = bodyD / 2;
  const bodyParts = [tint(new RoundedBoxGeometry(bodyW, bodyH, bodyD, 3, 0.012), p.body.color)];
  for (let i = 0; i < 7; i++) bodyParts.push(tint(boxGeo(0.12, 0.0016, 0.007, -0.07, bodyH / 2 + 0.0002, -0.075 + i * 0.016), "#2a2a2c"));
  for (let i = 0; i < 5; i++) bodyParts.push(tint(boxGeo(0.0016, 0.05, 0.007, -bodyW / 2 - 0.0002, 0.0, -0.06 + i * 0.016), "#2a2a2c"));
  const lx = p.lens.offsetX;
  const lensX = lx; // lens beside centre on the front face, clear of the LED
  const knob = new THREE.CylinderGeometry(0.014, 0.014, 0.006, 20);
  knob.translate(lensX, bodyH / 2 + 0.002, 0.05);
  bodyParts.push(tint(knob, "#1b1c1e"));
  const housing = new THREE.CylinderGeometry(p.lens.radius + 0.012, p.lens.radius + 0.016, p.lens.length * 0.75, 32);
  housing.rotateX(Math.PI / 2);
  housing.translate(lensX, 0, front + p.lens.length * 0.375);
  bodyParts.push(tint(housing, "#1b1c1e"));
  const glassG = new THREE.CylinderGeometry(p.lens.radius, p.lens.radius, p.lens.length, 32);
  glassG.rotateX(Math.PI / 2);
  glassG.translate(lensX, 0, front + p.lens.length * 0.5 + 0.002);
  bodyParts.push(tint(glassG, "#0a1424"));
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 });
  bodyMat.name = "projectorBody";
  const bodyMesh = new THREE.Mesh(mergeGeometries(bodyParts), bodyMat);
  bodyMesh.name = "projectorShell";
  body.add(bodyMesh);

  const ledMat = new THREE.MeshBasicMaterial({ color: "#6bffb0", toneMapped: false });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.004, 12, 8), ledMat);
  led.position.set(-0.11, -0.03, front + 0.001);
  led.scale.z = 0.5;
  body.add(led);

  // ---- metal: wall bracket + curtain track (one vertex-coloured mesh) --------------------------------
  const bp = p.bracket;
  const wallZ = layout.room.maxZ;
  const backZ = p.body.pos[2] + bodyD / 2; // body back face (rotY π)
  const armLen = wallZ - backZ;
  const bx = p.body.pos[0], by = p.body.pos[1];
  const DARK = "#3b3c3f", TRACK = "#d8d6d1";
  const metal = [
    tint(boxGeo(bp.plate, bp.plate, 0.008, bx, by, wallZ - 0.004), DARK),
    tint(boxGeo(bp.armSection, bp.armSection, armLen, bx, by, backZ + armLen / 2), DARK),
    tint(boxGeo(0.1, 0.06, 0.008, bx, by, backZ + 0.004), DARK),
  ];
  for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    const bolt = new THREE.CylinderGeometry(0.006, 0.006, 0.004, 8);
    bolt.rotateX(Math.PI / 2);
    bolt.translate(bx + dx * (bp.plate / 2 - 0.014), by + dy * (bp.plate / 2 - 0.014), wallZ - 0.01);
    metal.push(tint(bolt, DARK));
  }
  const cu = p.curtain;
  const [X0, X1] = cu.x, CZ = cu.z, CEIL = layout.room.height;
  const tx0 = X0 - 0.02, tx1 = X1 + 0.01;
  metal.push(tint(boxGeo(tx1 - tx0, 0.018, 0.026, (tx0 + tx1) / 2, cu.track, CZ), TRACK)); // profile
  metal.push(tint(boxGeo(tx1 - tx0, 0.004, 0.006, (tx0 + tx1) / 2, cu.track - 0.011, CZ), "#77746e")); // slot
  const nClips = Math.max(2, Math.round((tx1 - tx0) / 0.9) + 1);
  for (let i = 0; i < nClips; i++) {
    const x = tx0 + 0.06 + ((tx1 - tx0 - 0.12) * i) / (nClips - 1);
    metal.push(tint(boxGeo(0.03, CEIL - cu.track - 0.009, 0.018, x, (CEIL + cu.track + 0.009) / 2, CZ), TRACK));
  }
  // gliders + hooks at the top of every pleat
  for (let x = X0 + 0.02; x <= X1 - 0.01; x += cu.pleat.wavelength) {
    metal.push(tint(boxGeo(0.012, cu.track - 0.012 - cu.top, 0.004, x, (cu.track - 0.012 + cu.top) / 2, CZ), "#9a968e"));
  }
  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 });
  metalMat.name = "projectorMetal";
  const metalMesh = new THREE.Mesh(mergeGeometries(metal), metalMat);
  metalMesh.name = "projectorBracket";
  root.add(metalMesh);

  // lens front in world space (body rotY π: local +z → world −z, local +x → world −x)
  const lensPos = new THREE.Vector3();
  {
    const c = Math.cos(p.body.rotY), s = Math.sin(p.body.rotY);
    const lz = front + p.lens.length + 0.002;
    lensPos.set(bx + lensX * c + lz * s, by, p.body.pos[2] - lensX * s + lz * c);
  }

  // ---- curtain grid ------------------------------------------------------------------------------
  const sc = p.screen;
  const IX0 = sc.pos[0] - sc.width / 2, IX1 = sc.pos[0] + sc.width / 2;
  const IY0 = sc.pos[1] - sc.height / 2, IY1 = sc.pos[1] + sc.height / 2;
  const TOP = cu.top, HEM = cu.hem;
  const xs = [], ys = [];
  span(xs, X0, IX0, Math.max(1, Math.round((IX0 - X0) / 0.03)), false);
  span(xs, IX0, IX1, cu.segs[0], true);
  span(xs, IX1, X1, Math.max(1, Math.round((X1 - IX1) / 0.03)), true);
  span(ys, HEM, IY0, Math.max(1, Math.round((IY0 - HEM) / 0.035)), false);
  span(ys, IY0, IY1, cu.segs[1], true);
  span(ys, IY1, TOP, Math.max(2, Math.round((TOP - IY1) / 0.025)), true);
  const NC = xs.length, NR = ys.length, NV = NC * NR;
  const ic0 = xs.indexOf(IX0), ir0 = ys.indexOf(IY0);
  const ic1 = ic0 + cu.segs[0], ir1 = ir0 + cu.segs[1];

  // rest shape: pleats (irregular phase / depth), deeper at the gathered heading, the free edges and the hem
  const pl = cu.pleat;
  const rest = new Float32Array(NV);
  const k = (2 * Math.PI) / pl.wavelength;
  for (let j = 0; j < NR; j++) {
    const y = ys[j];
    const g = sstep(IY1 - 0.18, TOP, y); // heading gather
    const h = 1 - sstep(HEM, IY0 + 0.06, y); // hem
    const drop = TOP - y;
    for (let i = 0; i < NC; i++) {
      const x = xs[i];
      const e = Math.max(1 - sstep(X0, IX0 + 0.05, x), sstep(IX1 - 0.05, X1, x)); // free edges
      const amp = (pl.image + (pl.heading - pl.image) * g + pl.edge * e + (pl.hem - pl.image) * h * (1 - e)) *
        (0.72 + 0.22 * Math.sin(2.3 * x + 1.1) + 0.08 * Math.sin(7.9 * x + 0.4));
      const phase = k * (x - X0) + 0.9 * Math.sin(1.7 * x + 0.4) + 0.35 * Math.sin(4.3 * x + 2.0) + drop * 0.22 * Math.sin(1.1 * x + 0.3);
      const sn = Math.sin(phase);
      const shaped = Math.sign(sn) * Math.pow(Math.abs(sn), 1 - 0.4 * g); // pinched at the heading
      const bow = 0.01 * Math.sin(0.8 * x + 0.3) * (1 - g) * Math.min(1, drop / 1.5);
      rest[j * NC + i] = amp * shaped + bow;
    }
  }

  const position = new Float32Array(NV * 3), normal = new Float32Array(NV * 3);
  const uv = new Float32Array(NV * 2), uv1 = new Float32Array(NV * 2);
  for (let j = 0; j < NR; j++) for (let i = 0; i < NC; i++) {
    const v = j * NC + i;
    position[v * 3] = xs[i];
    position[v * 3 + 1] = ys[j];
    position[v * 3 + 2] = CZ + rest[v];
    uv[v * 2] = (xs[i] - X0) / LINEN_TILE;
    uv[v * 2 + 1] = ys[j] / LINEN_TILE;
    uv1[v * 2] = Math.min(1, Math.max(0, (xs[i] - IX0) / sc.width));
    uv1[v * 2 + 1] = Math.min(1, Math.max(0, (ys[j] - IY0) / sc.height));
  }
  const posAttr = new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage);
  const norAttr = new THREE.BufferAttribute(normal, 3).setUsage(THREE.DynamicDrawUsage);
  const uvAttr = new THREE.BufferAttribute(uv, 2), uv1Attr = new THREE.BufferAttribute(uv1, 2);
  const clothIdx = [], imgIdx = [];
  for (let j = 0; j < NR - 1; j++) for (let i = 0; i < NC - 1; i++) {
    const a = j * NC + i, b = a + 1, c = a + NC, d = c + 1;
    const inImg = i >= ic0 && i < ic1 && j >= ir0 && j < ir1;
    (inImg ? imgIdx : clothIdx).push(a, b, d, a, d, c);
  }
  const makeGeo = (idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", posAttr);
    g.setAttribute("normal", norAttr);
    g.setAttribute("uv", uvAttr);
    g.setAttribute("uv1", uv1Attr);
    g.setIndex(idx);
    return g;
  };
  const clothGeo = makeGeo(clothIdx), imgGeo = makeGeo(imgIdx);

  // analytic normals of z = f(x, y): n ∝ (−∂z/∂x, −∂z/∂y, 1); central differences on the grid
  function writeNormals() {
    for (let j = 0; j < NR; j++) {
      const j0 = j > 0 ? j - 1 : j, j1 = j < NR - 1 ? j + 1 : j;
      const dy = ys[j1] - ys[j0];
      for (let i = 0; i < NC; i++) {
        const i0 = i > 0 ? i - 1 : i, i1 = i < NC - 1 ? i + 1 : i;
        const dzdx = (position[(j * NC + i1) * 3 + 2] - position[(j * NC + i0) * 3 + 2]) / (xs[i1] - xs[i0]);
        const dzdy = (position[(j1 * NC + i) * 3 + 2] - position[(j0 * NC + i) * 3 + 2]) / dy;
        const inv = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
        const v = (j * NC + i) * 3;
        normal[v] = -dzdx * inv;
        normal[v + 1] = -dzdy * inv;
        normal[v + 2] = inv;
      }
    }
  }
  writeNormals();

  // bounds once, from rest plus room for the ripple (never recomputed: the attributes are shared)
  const R = cu.ripple;
  const slack = R.maxPush + 0.1;
  for (const g of [clothGeo, imgGeo]) {
    g.boundingBox = new THREE.Box3(new THREE.Vector3(X0, HEM, CZ - slack), new THREE.Vector3(X1, TOP, CZ + slack));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  }

  // ---- materials: linen (cloth) and linen + projected canvas (image) ---------------------------------
  const linen = { map: linenTexture(ctx.textures, cu.color, ctx.rng.fork("linen")) };
  const clothMat = new THREE.MeshStandardMaterial({
    map: linen.map, roughness: 0.93, side: THREE.DoubleSide,
  });
  clothMat.name = "curtainLinen";
  // weighted hem: a turned-up band (slightly darker, doubled cloth) with a stitch line along its top
  const hemTop = HEM + 0.075;
  clothMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
      #ifdef USE_MAP
        float wy = vMapUv.y * ${LINEN_TILE.toFixed(4)};
        float hemBand = 1.0 - smoothstep(${hemTop.toFixed(4)} - 0.004, ${hemTop.toFixed(4)} + 0.002, wy);
        float stitch = 1.0 - smoothstep(0.0, 0.0018, abs(wy - ${(hemTop - 0.012).toFixed(4)}));
        stitch *= step(0.5, fract(vMapUv.x * ${(LINEN_TILE / 0.008).toFixed(3)}));
        diffuseColor.rgb *= 1.0 - 0.1 * hemBand - 0.22 * stitch;
      #endif`);
  };
  clothMat.customProgramCacheKey = () => "curtainLinenHem";
  const cloth = new THREE.Mesh(clothGeo, clothMat);
  cloth.name = "curtainCloth";
  cloth.castShadow = true;
  cloth.receiveShadow = true;
  cloth.userData.noPick = true;
  root.add(cloth);

  const [cw, ch] = sc.canvas;
  const s = ctx.textures.screen(cw, ch);
  const g = s.ctx;
  s.texture.channel = 1; // sampled with uv1 (the image rectangle)
  const linenMean = new THREE.Color(cu.color);
  const imgMat = new THREE.MeshStandardMaterial({
    map: linen.map, roughness: 0.93, side: THREE.DoubleSide,
    emissive: 0xffffff, emissiveMap: s.texture, emissiveIntensity: 2.1,
  });
  imgMat.name = "curtainProjection";
  const uniforms = {
    uLens: { value: lensPos },
    uLinenMean: { value: (linenMean.r + linenMean.g + linenMean.b) / 3 },
    uFrontAlbedo: { value: 0.4 }, // the projected black level hides some of the room light on the cloth
    uBack: { value: 0.5 },
    uBackTint: { value: new THREE.Color(1.0, 0.86, 0.7) },
    uBlur: { value: new THREE.Vector2(6 / cw, 6 / ch) },
  };
  imgMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uLens;\nvarying float vShade;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShade = max(dot(normalize(objectNormal), normalize(uLens - transformed)), 0.0);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uLinenMean, uFrontAlbedo, uBack;\nuniform vec3 uBackTint;\nuniform vec2 uBlur;\nvarying float vShade;")
      .replace("#include <map_fragment>", `#include <map_fragment>
        float linenL = dot(diffuseColor.rgb, vec3(0.3333)) / max(uLinenMean, 0.001);
        #ifdef USE_EMISSIVEMAP
          vec2 eUv = vEmissiveMapUv;
          float edge = min(min(eUv.x, 1.0 - eUv.x) * 1.78, min(eUv.y, 1.0 - eUv.y));
          float inside = smoothstep(0.0, 0.02, edge);
        #else
          float inside = 1.0;
        #endif
        if (gl_FrontFacing) diffuseColor.rgb *= mix(1.0, uFrontAlbedo, inside);`)
      .replace("#include <emissivemap_fragment>", `#ifdef USE_EMISSIVEMAP
        vec3 img;
        if (gl_FrontFacing) {
          img = texture2D(emissiveMap, eUv).rgb * pow(vShade, 1.6);
        } else {
          img = texture2D(emissiveMap, eUv).rgb * 0.36;
          img += texture2D(emissiveMap, eUv + vec2(uBlur.x, uBlur.y)).rgb * 0.16;
          img += texture2D(emissiveMap, eUv + vec2(-uBlur.x, uBlur.y)).rgb * 0.16;
          img += texture2D(emissiveMap, eUv + vec2(uBlur.x, -uBlur.y)).rgb * 0.16;
          img += texture2D(emissiveMap, eUv + vec2(-uBlur.x, -uBlur.y)).rgb * 0.16;
          img = (img + 0.03) * uBack * uBackTint * vShade;
        }
        totalEmissiveRadiance *= img * mix(1.0, linenL, 0.55) * inside;
      #endif`);
  };
  imgMat.customProgramCacheKey = () => "curtainProjection";
  const image = new THREE.Mesh(imgGeo, imgMat);
  image.name = "projection";
  image.castShadow = true;
  image.receiveShadow = true;
  // the zone hotspot only from the room side (from the nook the bed is what matters)
  image.raycast = function (raycaster, intersects) {
    const n = intersects.length;
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
    if (raycaster.ray.origin.z < CZ) intersects.length = n;
  };
  root.add(image);

  // ---- light + beam --------------------------------------------------------------------------------
  // cone sized to the image's height, soft edge; the distance cut-off stops it just past the curtain (it
  // casts no shadow, so otherwise it would light the nook behind the cloth)
  const light = new THREE.SpotLight(0xfff3e4, p.light.intensity ?? 7, p.light.distance ?? 0, p.light.angle, p.light.penumbra, 2);
  light.name = "projectorLight";
  light.position.copy(lensPos);
  light.target.position.fromArray(sc.pos);
  light.castShadow = false;
  root.add(light, light.target);

  // beam: open pyramid apex at lens, base = image rectangle; vertex colour fades toward the lens
  const hw = sc.width / 2, hh = sc.height / 2;
  const cz = sc.pos[2] + 0.03; // stop just short of the cloth (its folds move)
  const A = [lensPos.x, lensPos.y, lensPos.z];
  const C = [
    [sc.pos[0] - hw, sc.pos[1] + hh, cz], [sc.pos[0] + hw, sc.pos[1] + hh, cz],
    [sc.pos[0] + hw, sc.pos[1] - hh, cz], [sc.pos[0] - hw, sc.pos[1] - hh, cz],
  ];
  const pos = [], col = [];
  for (let i = 0; i < 4; i++) {
    const a = C[i], b = C[(i + 1) % 4];
    pos.push(...A, ...a, ...b);
    col.push(0, 0, 0, 0.35, 0.35, 0.35, 0.35, 0.35, 0.35); // kept faint: a hard-edged additive shell reads as a glitch
  }
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  beamGeo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: 0xfff1dc, vertexColors: true, transparent: true, opacity: p.beam.opacity,
    // faces wind inward: BackSide draws only the near shell seen from outside, nothing from inside the beam
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide, toneMapped: false, fog: false,
  }));
  beam.name = "projectorBeam";
  beam.frustumCulled = false;
  beam.raycast = () => {}; // never blocks or picks
  beam.userData.noPick = true;
  beam.renderOrder = 2;
  root.add(beam);

  // ---- canvas content ------------------------------------------------------------------------------
  const rng = ctx.rng.fork("lines");
  const NL = 15;
  const lines = [];
  for (let i = 0; i < NL; i++) {
    lines.push({
      y: 70 + ((i + 0.5) / NL) * (ch - 140),
      a1: rng.float(10, 42), f1: rng.float(0.0016, 0.0042), s1: rng.float(0.05, 0.16) * rng.sign(), p1: rng.float(0, 6.28),
      a2: rng.float(4, 16), f2: rng.float(0.006, 0.011), s2: rng.float(0.08, 0.22) * rng.sign(), p2: rng.float(0, 6.28),
      accent: i % 5 === 2, alpha: rng.float(0.1, 0.28), w: rng.float(1, 2),
    });
  }

  // Canvas layout for the curtain-sized image (1 px ≈ 3.3 mm): a centred column, clear of the gathered
  // heading at the top (~5 % of the height) and the free edges.
  const LEFT = Math.round(cw * 0.2), MAXW = Math.round(cw * 0.6), LH = Math.round(ch * 0.078);
  const TITLE_PX = Math.round(ch * 0.061), SMALL_PX = Math.round(ch * 0.024);
  const MARK_Y = Math.round(ch * 0.22), CARD_TOP = Math.round(ch * 0.35);
  const TITLE_FONT = `400 ${TITLE_PX}px ${SERIF}`;

  // static overlay: soft centred vignette + wordmark
  const ov = ctx.textures.makeCanvas(cw, ch);
  {
    const o = ov.ctx;
    const vg = o.createRadialGradient(cw * 0.5, ch * 0.5, ch * 0.42, cw * 0.5, ch * 0.5, cw * 0.62);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.45)");
    o.fillStyle = vg;
    o.fillRect(0, 0, cw, ch);
    o.fillStyle = "rgba(233,230,224,0.62)";
    o.font = `500 ${Math.round(ch * 0.03)}px ${MONO}`;
    o.textBaseline = "alphabetic";
    if ("letterSpacing" in o) o.letterSpacing = "2px";
    o.fillText(ctx.content?.site?.title || "ubermayinch", LEFT, MARK_Y);
    o.fillStyle = ACCENT;
    o.fillRect(LEFT, MARK_Y + 12, 26, 2);
  }

  // cards from ctx.content.latest, prepared lazily once each (no per-frame measuring/allocation)
  const latest = (ctx.content && Array.isArray(ctx.content.latest) ? ctx.content.latest : []).filter((it) => it && it.title).slice(0, 12);
  const cards = new Array(latest.length).fill(null);
  function prep(i) {
    const it = latest[i];
    g.font = TITLE_FONT;
    const words = String(it.title).replace(/\s+/g, " ").trim().split(" ");
    const out = [];
    let cur = "";
    for (let w = 0; w < words.length; w++) {
      const test = cur ? cur + " " + words[w] : words[w];
      if (g.measureText(test).width > MAXW && cur) {
        if (out.length === 2) { cur = test; break; } // third line takes the remainder, trimmed below
        out.push(cur);
        cur = words[w];
      } else cur = test;
    }
    if (out.length < 3) out.push(cur);
    out[out.length - 1] = ctx.textures.fitText(g, out[out.length - 1], MAXW);
    return {
      label: String(it.sourceLabel || it.source || "").toUpperCase(),
      lines: out,
      date: formatDate(it.date),
    };
  }

  function drawCard(i, alpha) {
    if (alpha <= 0.002) return;
    const c = cards[i] || (cards[i] = prep(i));
    const n = c.lines.length;
    const head = SMALL_PX + 26; // kicker line + air
    const blockH = head + n * LH + SMALL_PX + 22;
    const top = CARD_TOP + (1 - alpha) * 10;
    g.globalAlpha = alpha;
    g.fillStyle = ACCENT;
    g.fillRect(LEFT - 24, top + 2, 2, blockH - 10);
    g.font = `500 ${SMALL_PX}px ${MONO}`;
    g.textBaseline = "alphabetic";
    if ("letterSpacing" in g) g.letterSpacing = "3px";
    g.fillText(c.label, LEFT, top + SMALL_PX);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    g.font = TITLE_FONT;
    g.fillStyle = OFFWHITE;
    for (let k2 = 0; k2 < n; k2++) g.fillText(c.lines[k2], LEFT, top + head + TITLE_PX * 0.8 + k2 * LH);
    g.font = `400 ${SMALL_PX}px ${MONO}`;
    g.fillStyle = "rgba(233,230,224,0.55)";
    g.fillText(c.date, LEFT, top + head + n * LH + SMALL_PX + 8);
    g.globalAlpha = 1;
  }

  function draw(t) {
    g.globalAlpha = 1;
    g.fillStyle = BG;
    g.fillRect(0, 0, cw, ch);

    // drifting generative lines (frozen under reduced motion)
    const tl = ctx.reducedMotion ? 0 : t;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (let i = 0; i < NL; i++) {
      const L = lines[i];
      g.strokeStyle = L.accent ? ACCENT : OFFWHITE;
      g.globalAlpha = L.alpha;
      g.lineWidth = L.w;
      g.beginPath();
      for (let x = -20; x <= cw + 20; x += 20) {
        const y = L.y + L.a1 * Math.sin(x * L.f1 + tl * L.s1 + L.p1) + L.a2 * Math.sin(x * L.f2 + tl * L.s2 + L.p2);
        if (x === -20) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;

    // title cards with crossfade
    const n = latest.length;
    if (n) {
      const idx = Math.floor(t / CARD_PERIOD);
      const local = t - idx * CARD_PERIOD;
      const a = ease(local / CARD_FADE);
      if (idx > 0 && local < CARD_FADE) drawCard((idx - 1) % n, 1 - a);
      drawCard(idx % n, a);
    }

    g.drawImage(ov.canvas, 0, 0);
    s.texture.needsUpdate = true;
  }

  // ---- cloth motion ----------------------------------------------------------------------------------
  // push profile down the drop: 0 at the heading (hooked to the track), full from mid-height to the hem
  const prof = new Float32Array(NR);
  for (let j = 0; j < NR; j++) prof[j] = sstep(0, 1.3, TOP - ys[j]) * (1 - 0.3 * (1 - sstep(HEM, HEM + 0.25, ys[j]))); // the hem lags
  const push = new Float32Array(NC), vel = new Float32Array(NC);
  let side = -1; // which side of the player the cloth is on (−1: cloth at the player's −z)
  let contact = false, clothNext = 0, rippleLive = false;
  const player = ctx.player || null;

  function stepRipple(dt) {
    let near = false, P = 0, px = 0;
    if (player && !player.outside && Number.isFinite(player.x) && Number.isFinite(player.z)) {
      const dz = player.z - CZ;
      px = player.x;
      if (Math.abs(dz) > R.near || px < X0 - 0.4 || px > X1 + 0.4) {
        side = dz > 0 ? -1 : 1; // re-latch only when clear of the cloth
        contact = false;
      } else {
        near = true;
        // contact bound: the body keeps the cloth at least R.contact away on its side
        let need = side < 0 ? Math.min(0, player.z - R.contact - CZ) : Math.max(0, player.z + R.contact - CZ);
        if (Math.abs(need) > R.maxPush) { side = -side; need = 0; } // the cloth slips over the shoulder
        contact = need !== 0;
        const air = 0.035 * (1 - Math.abs(dz) / R.near); // a gentle bow ahead of the body
        P = side * Math.max(Math.abs(need), air);
      }
    }
    let live = false;
    const w2 = 1 / (R.width * R.width);
    for (let i = 0; i < NC; i++) {
      let target = 0;
      if (near) { const dx = xs[i] - px; target = P * Math.exp(-dx * dx * w2); }
      const kk = contact ? R.k * 5 : R.k;
      vel[i] += (kk * (target - push[i]) - R.damping * vel[i]) * dt;
      push[i] += vel[i] * dt;
      if (Math.abs(push[i]) > 1e-4 || Math.abs(vel[i]) > 1e-4) live = true;
    }
    rippleLive = live || near;
  }

  function writeCloth(t) {
    const sw = cu.sway;
    for (let i = 0; i < NC; i++) {
      const x = xs[i];
      const off = sw * (Math.sin(0.5 * t + 0.8 * x) + 0.6 * Math.sin(0.27 * t - 1.9 * x + 1.0)) + push[i];
      for (let j = 0; j < NR; j++) {
        const v = j * NC + i;
        position[v * 3 + 2] = CZ + rest[v] + off * prof[j];
      }
    }
    writeNormals();
    posAttr.needsUpdate = true;
    norAttr.needsUpdate = true;
  }

  draw(0);
  let next = 1 / sc.fps;
  let ledPhase = 0;
  const period = 1 / sc.fps;

  scene.add(root);

  return {
    root,
    update(dt, t) {
      if (t >= next) {
        next = t + period;
        draw(t);
        ledPhase = 0.75 + 0.25 * Math.sin(t * 1.6);
        ledMat.color.setRGB(0.42 * ledPhase, 1.0 * ledPhase, 0.69 * ledPhase);
      }
      if (ctx.reducedMotion) return;
      stepRipple(dt);
      if (t >= clothNext) {
        clothNext = t + (rippleLive ? 1 / 40 : 1 / 12);
        writeCloth(t);
      }
    },
    hotspots: [{ zone: "screen", label: "latest, from everywhere", objects: [image] }],
  };
}
