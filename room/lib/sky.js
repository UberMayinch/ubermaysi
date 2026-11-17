// lib/sky.js — time of day: sun / moon arc, sky dome, fog, exposure and every scene-level light.
//
// createSky(THREE, scene, renderer, layout, rng, TIME) -> sky   (TIME: layout.js { latitude, declination, noon, … })
//   sky.time        the live ctx.time object (mutated in place, never reassigned):
//                     { hour, day, night, golden, sunDir, moonDir, sunColor, skyTop, skyHorizon, sunElevation,
//                       onChange(fn) -> unsubscribe }
//   sky.lights      { hemi, sun, spot, fill, fills[], spill }   (constant set: intensities change, never visibility)
//   sky.dome        the gradient sky (1 draw call); main.js keeps it centred on the camera
//   sky.setHour(h | null, seconds = 0)   pin the clock (eased over `seconds`), null = visitor's local clock
//   sky.stepHour()  next full hour (T key); returns the new hour
//   sky.update(dt, nowMs, o, door)   once per frame: o = 0 (camera indoors) … 1 (outdoors / overview),
//                     door = doorway openness 0..1. Re-reads the clock about once a minute.
//   sky.shadowTick(active, wallSig, dynSum)   shadow policy (see below), once per frame; dynSum = checksum of the
//                     dynamic colliders' poses
//
// Conventions: +x east, −x west, +z south (the garden), −z north. The sun rises in the east, culminates in
// the south (so the garden is sunlit) and sets in the west. A full moon runs opposite.
//
// Shadows: the ceiling spot and the sun/moon DirectionalLight both keep castShadow = true for the life of the
// page (toggling it changes the shader defines and recompiles every material: a visible hitch). Both use
// shadow.autoUpdate = false; each frame only the ACTIVE light re-renders its map. The other keeps its last
// map, re-rendered once when what it sees changes (sun moved, walls cut away / restored, door moved, a
// dynamic object moved). So one shadow pass per frame, no pop when the active light switches.

const D2R = Math.PI / 180;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, k) => a + (b - a) * k;

// Sky palette keyed by sun elevation (degrees). sRGB hex; converted to linear once.
const KEYS = [
  { el: -18, top: "#060a16", hor: "#101729", gnd: "#07090d" },
  { el: -9, top: "#0d1430", hor: "#252c4a", gnd: "#0b0d14" },
  { el: -3, top: "#26315c", hor: "#7a5a72", gnd: "#16151a" },
  { el: 2, top: "#3f5b90", hor: "#eea072", gnd: "#4a3d34" },
  { el: 9, top: "#5f86bd", hor: "#f2c9a0", gnd: "#6a5d50" },
  { el: 22, top: "#6d97cc", hor: "#cfdde6", gnd: "#8a877c" },
  { el: 60, top: "#5f8fca", hor: "#d4e2ea", gnd: "#8f8c82" },
];

// Interior / exterior lighting targets. three r186: physical units (candela for spot / point).
const L = {
  spotNight: 22, spotDay: 17, spotAngle: 1.3, spotPenumbra: 0.55,
  fillNight: 2.4, fillDay: 1.9,
  // corner fills: [fraction of room width from W, fraction of depth from N]; candela night / day
  cornerFills: [[0.17, 0.78], [0.8, 0.8]], cornerFillNight: 2.2, cornerFillDay: 1.6, cornerFillDistance: 6,
  hemiIn: { night: 0.36, day: 1.05 }, // by day: soft daylight from the doorway and paper, not lamp-only
  hemiOut: { night: 0.32, day: 1.15 },
  sun: 3.6, moon: 0.42,
  spill: 2, // doorway daylight, candela at full day with the door open (modest: the polished floor mirrors it)
  exposureIn: { night: 0.84, day: 0.9 },
  exposureOut: { night: 1.05, day: 0.62 },
  envIn: 0.32, envOut: { night: 0.12, day: 0.42 },
  fog: [16, 75],
};

export function createSky(THREE, scene, renderer, layout, rng, opts = {}) {
  const LAT = (opts.latitude ?? 48) * D2R; // a temperate latitude
  const DECL = (opts.declination ?? 8) * D2R; // late-summer sun
  const NOON = opts.noon ?? 12.3; // solar noon, local clock
  const REFRESH_MS = (opts.refreshSeconds ?? 60) * 1000;
  const STEP_S = opts.stepSeconds ?? 0.9;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const keys = KEYS.map((k) => ({ el: k.el, top: new THREE.Color(k.top), hor: new THREE.Color(k.hor), gnd: new THREE.Color(k.gnd) }));
  const warmIn = new THREE.Color(0xfff4e6), warmGround = new THREE.Color(0x3a3430);
  const sunLow = new THREE.Color(0xff8a4a), sunHigh = new THREE.Color(0xfff1dc), moonColor = new THREE.Color(0x9fb4e6);
  const white = new THREE.Color(0xffffff), nightTint = new THREE.Color(0x6f82b0), nightGround = new THREE.Color(0x1c1e26);

  // ---- ctx.time ----
  const listeners = [];
  const time = {
    hour: 12, day: 1, night: 0, golden: 0, sunElevation: 0, moonElevation: 0,
    sunDir: new THREE.Vector3(0, 1, 0), moonDir: new THREE.Vector3(0, -1, 0),
    sunColor: new THREE.Color(), skyTop: new THREE.Color(), skyHorizon: new THREE.Color(), skyGround: new THREE.Color(),
    pinned: false,
    onChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };

  // ---- lights ----
  const lights = new THREE.Group();
  lights.name = "lights";
  const hemi = new THREE.HemisphereLight(0xfff4e6, 0x3a3430, L.hemiIn.night);
  hemi.name = "hemi";

  // the ceiling lamp hangs at the room centre (the room is not centred on the origin)
  const R = layout.room;
  const cx = (R.minX + R.maxX) / 2, cz = (R.minZ + R.maxZ) / 2;
  const yard = (layout.garden && layout.garden.bounds) || { minX: -5, maxX: 5, minZ: R.maxZ, maxZ: 10.5 };
  const lampY = R.height - 0.05;
  const spot = new THREE.SpotLight(0xffe2bf, L.spotNight, 0, L.spotAngle, L.spotPenumbra, 2);
  spot.name = "ceilingSpot";
  spot.position.set(cx, lampY, cz);
  spot.target.position.set(cx, 0, cz);
  spot.castShadow = true;
  spot.shadow.mapSize.set(2048, 2048);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 3;
  // the cone is wide so the walls catch light; the shadow frustum only needs the floor corners (+ a margin)
  const cornerAngle = Math.atan(Math.hypot(R.width, R.depth) / 2 / lampY);
  spot.shadow.focus = Math.min(1, (cornerAngle + 0.06) / L.spotAngle);
  spot.shadow.camera.near = 0.2;
  spot.shadow.camera.far = Math.hypot(R.width / 2, R.depth / 2, lampY) + 0.5;
  spot.shadow.autoUpdate = false;
  spot.shadow.needsUpdate = true;

  const fill = new THREE.PointLight(0xffe2bf, L.fillNight, 0, 2);
  fill.name = "ceilingFill";
  fill.position.set(cx, lampY - 0.15, cz);
  // two soft non-shadow fills for the far ends of the big room the one spot reaches thinly: the SW training
  // floor and the SE desk / library. (The NW nook and the NE booth carry their own small lights.)
  const fills = L.cornerFills.map(([fx, fz], i) => {
    const p = new THREE.PointLight(0xffe2bf, 0, L.cornerFillDistance, 2);
    p.name = `cornerFill${i + 1}`;
    p.position.set(R.minX + fx * R.width, lampY - 0.2, R.minZ + fz * R.depth);
    return p;
  });

  // the sun by day, the moon by night (the switch happens while its intensity is ~0)
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.name = "sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.5;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  const sunTarget = new THREE.Vector3(0, 1.2, (R.minZ + yard.maxZ) / 2); // middle of house + garden
  sun.target.position.copy(sunTarget);

  // daylight through the open doorway: sits in the doorway head, looks in and down onto the genkan.
  // Non-shadow; the walls' faces all point away from it, so it only reaches the genkan and the floor near it.
  const door = layout.shell.door;
  const spill = new THREE.SpotLight(0xffffff, 0, 0, 0.78, 0.85, 2);
  spill.name = "doorSpill";
  spill.position.set(door.pos[0], Math.min(1.98, door.height - 0.05), layout.room.maxZ + 0.05);
  spill.target.position.set(door.pos[0], -0.12, layout.room.maxZ - 1.3);

  lights.add(hemi, spot, spot.target, fill, ...fills, sun, sun.target, spill, spill.target);
  scene.add(lights);

  // ---- sky dome ----
  const seed = rng ? rng.float(0, 97) : 13.7;
  const uniforms = {
    uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uSunGlow: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uNight: { value: 0 }, uSeed: { value: seed },
  };
  const domeMat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor, uMoonDir;
      uniform float uSunGlow, uNight, uSeed;
      varying vec3 vDir;
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13) + uSeed);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 col = y > 0.0
          ? mix(uHorizon, uTop, pow(smoothstep(0.0, 1.0, y), 0.55))
          : mix(uHorizon, uGround, smoothstep(0.0, 0.35, -y));
        float s = max(dot(d, uSunDir), 0.0);
        col += uSunColor * uSunGlow * (pow(s, 6.0) * 0.22 + pow(s, 48.0) * 0.5 + smoothstep(0.9992, 0.9996, s) * 6.0);
        if (uNight > 0.001) {
          float m = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.62, 0.7, 0.9) * uNight * (pow(m, 40.0) * 0.05 + pow(m, 600.0) * 0.12 + smoothstep(0.99975, 0.99985, m) * 1.4);
          if (y > 0.0) {
            vec3 g = d * 260.0;
            vec3 c = floor(g);
            float h = hash(c);
            if (h > 0.9965) {
              vec3 j = vec3(hash(c + 1.7), hash(c + 3.1), hash(c + 5.3));
              float r = length(g - c - 0.25 - j * 0.5);
              float tw = 0.55 + 0.45 * fract(h * 931.7);
              col += vec3(0.85, 0.88, 1.0) * smoothstep(0.32, 0.0, r) * tw * uNight * smoothstep(0.02, 0.25, y) * 0.9;
            }
          }
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), domeMat);
  dome.name = "skyDome";
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.castShadow = dome.receiveShadow = false;
  dome.matrixAutoUpdate = true;
  scene.add(dome);
  scene.background = null;
  scene.fog = new THREE.Fog(0x000000, L.fog[0], L.fog[1]);

  // ---- clock ----
  const params = new URLSearchParams(location.search);
  const tParam = params.get("t");
  const clock = { pinned: null, from: 12, to: 12, k: 1, dur: 0, lastRead: -Infinity };
  const localHour = () => {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };
  const norm = (h) => ((h % 24) + 24) % 24;
  if (tParam !== null && tParam !== "" && Number.isFinite(Number(tParam))) clock.pinned = norm(Number(tParam));
  let hourNow = clock.pinned ?? localHour();
  const level = { o: 0, door: 0 };

  // ---- the model ----
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const lastFitDir = new THREE.Vector3(9, 9, 9);
  const mix3 = new THREE.Color();

  function arc(h, opposite, out) {
    const H = (h - NOON) * 15 * D2R + (opposite ? Math.PI : 0);
    const dec = opposite ? -DECL : DECL;
    const east = -Math.cos(dec) * Math.sin(H);
    const north = Math.cos(LAT) * Math.sin(dec) - Math.sin(LAT) * Math.cos(dec) * Math.cos(H);
    const up = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H);
    return out.set(east, up, -north).normalize();
  }

  function palette(el) {
    let i = 0;
    while (i < keys.length - 2 && el > keys[i + 1].el) i++;
    const a = keys[i], b = keys[i + 1];
    const k = smooth(a.el, b.el, el);
    time.skyTop.copy(a.top).lerp(b.top, k);
    time.skyHorizon.copy(a.hor).lerp(b.hor, k);
    time.skyGround.copy(a.gnd).lerp(b.gnd, k);
  }

  /** Recompute ctx.time from hourNow; refit the sun's shadow camera if it moved. */
  function evaluate() {
    const h = norm(hourNow);
    time.hour = h;
    time.pinned = clock.pinned !== null;
    arc(h, false, time.sunDir);
    arc(h, true, time.moonDir);
    const el = Math.asin(time.sunDir.y) / D2R;
    const mel = Math.asin(time.moonDir.y) / D2R;
    time.sunElevation = el;
    time.moonElevation = mel;
    time.day = smooth(-4, 12, el);
    time.night = 1 - smooth(-12, -1, el);
    time.golden = el > -8 ? Math.exp(-(((el - 3) / 7) ** 2)) : 0;
    time.sunColor.copy(sunLow).lerp(sunHigh, smooth(0, 28, el));
    palette(el);

    // DirectionalLight: sun while it is up (or just under), the moon otherwise
    const sunI = L.sun * smooth(-1, 10, el) * (0.75 + 0.25 * smooth(10, 40, el));
    const moonI = L.moon * smooth(-3, -10, el) * smooth(-2, 12, mel);
    const useSun = el > -2;
    const dir = useSun ? time.sunDir : time.moonDir;
    sun.color.copy(useSun ? time.sunColor : moonColor);
    sun.intensity = useSun ? sunI : moonI;
    sun.position.copy(sunTarget).addScaledVector(dir, 20);
    if (dir.distanceToSquared(lastFitDir) > 1e-7) {
      lastFitDir.copy(dir);
      fitSunShadow(dir);
    }

    uniforms.uTop.value.copy(time.skyTop);
    uniforms.uHorizon.value.copy(time.skyHorizon);
    uniforms.uGround.value.copy(time.skyGround);
    uniforms.uSunDir.value.copy(time.sunDir);
    uniforms.uSunColor.value.copy(time.sunColor);
    uniforms.uSunGlow.value = smooth(-8, 2, el) * (0.6 + 0.6 * time.golden);
    uniforms.uMoonDir.value.copy(time.moonDir);
    uniforms.uNight.value = time.night * smooth(-3, 4, mel) * 0.85 + time.night * 0.15;
    scene.fog.color.copy(time.skyHorizon).lerp(time.skyGround, 0.25);

    for (let i = 0; i < listeners.length; i++) {
      try {
        listeners[i](time);
      } catch (err) {
        console.error("[room] time.onChange listener failed", err);
      }
    }
  }

  /** Ortho shadow camera around house + garden (the whole house too: outside the frustum counts as lit). */
  const fitBox = {
    minX: Math.min(R.minX, yard.minX) - 0.2, maxX: Math.max(R.maxX, yard.maxX) + 0.2, minY: -0.2, maxY: 4.7, // maxY: roof, maple, bamboo
    minZ: R.minZ - 0.2, maxZ: yard.maxZ + 0.2,
  };
  function fitSunShadow(dir) {
    const cam = sun.shadow.camera;
    const z = tmpA.copy(dir); // camera looks along −dir
    const x = tmpB.set(0, 1, 0).cross(z).normalize();
    const y = tmpC.copy(z).cross(x);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const P = sun.position;
    for (let i = 0; i < 8; i++) {
      const px = (i & 1 ? fitBox.maxX : fitBox.minX) - P.x;
      const py = (i & 2 ? fitBox.maxY : fitBox.minY) - P.y;
      const pz = (i & 4 ? fitBox.maxZ : fitBox.minZ) - P.z;
      const cx = px * x.x + py * x.y + pz * x.z, cy = px * y.x + py * y.y + pz * y.z, cz = px * z.x + py * z.y + pz * z.z;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
      if (cz < z0) z0 = cz;
      if (cz > z1) z1 = cz;
    }
    cam.left = x0;
    cam.right = x1;
    cam.bottom = y0;
    cam.top = y1;
    cam.near = Math.max(0.1, -z1 - 1);
    cam.far = -z0 + 1;
    cam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }

  /** Lights that depend on where the camera is (o) and on the doorway, every frame. Allocation-free. */
  function applyLevel() {
    const { day, night } = time;
    const o = level.o;
    spot.intensity = lerp(L.spotNight, L.spotDay, day);
    fill.intensity = lerp(L.fillNight, L.fillDay, day);
    const cf = lerp(L.cornerFillNight, L.cornerFillDay, day);
    for (let i = 0; i < fills.length; i++) fills[i].intensity = cf;
    // hemisphere: warm interior bounce indoors, the sky outdoors
    const hin = lerp(L.hemiIn.night, L.hemiIn.day, day);
    const hout = lerp(L.hemiOut.night, L.hemiOut.day, day);
    hemi.intensity = lerp(hin, hout, o);
    // outdoor sky light: the day sky's colour, a cool moonlit blue at night (colour and level kept apart)
    mix3.copy(time.skyTop).lerp(time.skyHorizon, 0.45).lerp(white, 0.3).lerp(nightTint, 1 - day);
    hemi.color.copy(warmIn).lerp(mix3, o + (1 - o) * 0.4 * day);
    mix3.copy(time.skyGround).lerp(warmGround, 0.3).lerp(nightGround, 1 - day);
    hemi.groundColor.copy(warmGround).lerp(mix3, o);
    renderer.toneMappingExposure = lerp(lerp(L.exposureIn.night, L.exposureIn.day, day), lerp(L.exposureOut.night, L.exposureOut.day, day), o);
    scene.environmentIntensity = lerp(L.envIn, lerp(L.envOut.night, L.envOut.day, day), o);
    // squared: 0 while the shoji is closed (the spot sits just outside the panel and would light its face)
    spill.intensity = level.door * level.door * (L.spill * day + 0.5 * night);
    spill.color.copy(time.skyHorizon).lerp(white, 0.55).lerp(time.sunColor, 0.25 * time.golden);
    if (night > 0.5) spill.color.lerp(moonColor, 0.5);
  }

  // ---- public ----
  function setHour(h, seconds = 0) {
    if (h === null || h === undefined || h === "") {
      clock.pinned = null;
      clock.k = 1;
      hourNow = localHour();
      clock.lastRead = performance.now();
      evaluate();
      return time.hour;
    }
    const target = norm(Number(h));
    if (!Number.isFinite(target)) return time.hour;
    clock.pinned = target;
    if (seconds > 0) {
      clock.from = hourNow;
      let to = target;
      while (to < clock.from) to += 24; // always forward
      if (to - clock.from > 12) to -= 24; // …unless it is the long way round
      clock.to = to;
      clock.k = 0;
      clock.dur = seconds;
    } else {
      clock.k = 1;
      hourNow = target;
      evaluate();
    }
    return target;
  }

  function stepHour() {
    const next = norm(Math.floor(time.hour + 1e-6) + 1);
    setHour(next, reducedMotion ? 0 : STEP_S);
    return next;
  }

  function update(dt, nowMs, o, doorOpen) {
    level.o = o;
    level.door = doorOpen;
    if (clock.k < 1) {
      clock.k = Math.min(1, clock.k + dt / clock.dur);
      const e = clock.k < 0.5 ? 2 * clock.k * clock.k : 1 - (-2 * clock.k + 2) ** 2 / 2;
      hourNow = lerp(clock.from, clock.to, e);
      evaluate();
    } else if (clock.pinned === null && nowMs - clock.lastRead > REFRESH_MS) {
      clock.lastRead = nowMs;
      hourNow = localHour();
      evaluate();
    }
    applyLevel();
  }

  // shadow policy: which map re-renders this frame (see header). At most ONE shadow pass per frame (the triangle
  // budget counts it): the inactive map follows door / dynamic-object changes only once they have come to rest,
  // and when both want a pass in the same frame they take turns (the skipped one renders on the next frame).
  const sig = { spot: -1, sun: -1, spotDoor: -1, sunDoor: -1, prevDoor: -1, sunDyn: NaN, prevDyn: NaN, spotPending: false, sunPending: false, flip: false };
  const doorMoved = (last) => Math.abs(last - level.door) > 0.002;
  function shadowTick(active, wallSig, dynSum) {
    const doorResting = Math.abs(level.door - sig.prevDoor) < 1e-4;
    sig.prevDoor = level.door;
    const dynResting = Math.abs(dynSum - sig.prevDyn) < 1e-5;
    sig.prevDyn = dynSum;
    const spotStale = sig.spot !== wallSig || (doorResting && doorMoved(sig.spotDoor));
    const sunStale = sig.sun !== wallSig || (doorResting && doorMoved(sig.sunDoor)) || (dynResting && !(Math.abs(dynSum - sig.sunDyn) < 1e-5));
    if (active === "spot" || spotStale || sig.spotPending) spot.shadow.needsUpdate = true;
    if (active === "sun" || sunStale || sig.sunPending) sun.shadow.needsUpdate = true; // evaluate() also flags it when the sun moves
    sig.spotPending = sig.sunPending = false;
    // (never before both maps exist: a material sampling a not-yet-rendered shadow map is a GL sampler mismatch)
    if (spot.shadow.needsUpdate && sun.shadow.needsUpdate && spot.shadow.map && sun.shadow.map) {
      // both want a pass: alternate (a T-key sun tween flags the sun every frame; the active map must not freeze),
      // and remember the skipped one so its last change is never lost
      const skipSpot = sig.flip;
      sig.flip = !sig.flip;
      if (skipSpot) {
        spot.shadow.needsUpdate = false;
        sig.spotPending = true;
      } else {
        sun.shadow.needsUpdate = false;
        sig.sunPending = true;
      }
    }
    if (spot.shadow.needsUpdate) {
      sig.spot = wallSig;
      sig.spotDoor = level.door;
    }
    if (sun.shadow.needsUpdate) {
      sig.sun = wallSig;
      sig.sunDoor = level.door;
      sig.sunDyn = dynSum;
    }
  }

  clock.lastRead = performance.now();
  evaluate();
  applyLevel();

  return {
    time,
    lights: { hemi, sun, spot, fill, fills, spill },
    dome,
    setHour,
    stepHour,
    update,
    shadowTick,
    refresh: evaluate,
    fogRange: L.fog, // [near, far] at walking distance; main.js pushes them out with the overview distance
  };
}
