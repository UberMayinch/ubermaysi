// layout.js — single source of truth for every world position, rotation and size in the room.
//
// Pure data + a few pure helpers. No three.js import, so it also loads in Node (see checkLayout()).
//
// Conventions (SPEC §2): metres, Y-up. The origin is NOT the room centre (the room grew west and north):
//   x ∈ [-4.5, 3]  west(−) → east(+)    z ∈ [-5, 2.5]  north(−) → south(+)    floor y = 0, ceiling y = 2.8
//   Room centre (-0.75, -1.25). Code that depends on the room box reads ROOM, never literal numbers.
//   Every object's local FRONT faces +z before rotation. rotY rotates about +Y (three.js convention):
//   rotY = −π/2 turns local +z to world −x, rotY = π turns it to world −z.
//   `pos` is always [x, y, z] of the object's root: floor-contact centre unless the key says anchor/centre.
//
// Ownership: each objects/<name>.js reads LAYOUT.<name>. If a value you need is missing, add it under
// your own module's key here and nowhere else.

const PI = Math.PI;

/** Room box. Walls: N at z = minZ, S at z = maxZ, W at x = minX, E at x = maxX. */
export const ROOM = {
  width: 7.5, // x extent
  depth: 7.5, // z extent
  height: 2.8,
  minX: -4.5,
  maxX: 3.0,
  minZ: -5.0,
  maxZ: 2.5,
};

export const LAYOUT = {
  room: ROOM,

  // ---- objects/shell.js: floor, walls, ceiling, door, ceiling light, wall decor --------------------
  shell: {
    // Dojo floor: aged, hand-polished dark keyaki/cedar planks running E–W, a soft mirror-like clearcoat.
    // rows: planks per texture tile; shell.js raises it to cover the larger room side (42 × 0.18 = 7.56 m >= 7.5,
    // so the floor never repeats; the texture is square, MAX_SIZE 1024 px).
    floor: { plankWidth: 0.18, plankLength: [0.8, 1.6], rows: 42, color: "#533c2d", roughness: 0.5, clearcoat: 0.85, clearcoatRoughness: 0.13 },
    // Genkan: stone-tiled entry at the LOW level (y −0.12), x/z = the sunken rect. kamachi = the timber step-edge
    // beam on its N, W and E sides, OUTSIDE the rect (top flush with the main floor, inner face = the riser).
    // The W beam stops short of the S wall where the open shoji slides over the genkan-level sill rail.
    genkan: { x: [-1.9, 0.3], z: [1.3, 2.5], y: -0.12, kamachi: 0.09, stone: "#6b6964", course: 0.27 },
    // Open shoe shelf (getabako) on the genkan stone against its W step, front (local +z) facing +x (east), clear
    // of the open shoji (z <= 2.43) and of the door walking line (front face x −1.6, line x −1.10…−0.20).
    getabako: { pos: [-1.75, -0.12, 1.84], rotY: PI / 2, width: 0.9, depth: 0.3, height: 0.4 },
    // Low timber bench (koshikake) for changing shoes, against the E step; width along x, depth along z.
    genkanBench: { pos: [0.13, -0.12, 1.8], rotY: 0, width: 0.3, depth: 0.75, height: 0.36 },
    // Slim glazed umbrella stand with two closed umbrellas (handles up to ~y 0.8) in the SE corner of the genkan.
    umbrellaStand: { pos: [0.14, -0.12, 2.31], diameter: 0.19, height: 0.46 },
    // Outdoor shoes just stepped out of, toes turned to the door, west of the walking line.
    outdoorShoes: { pos: [-1.38, -0.12, 1.62], yaw: 0.08 },
    // Indoor slippers waiting on the timber just above the step, toes pointing into the room.
    slippers: { pos: [-0.65, 0, 1.06], width: 0.24, depth: 0.27, height: 0.05 },
    // Flat stepping stone (kutsunugi-ishi) outside the door: plan size [x, z], top y.
    stepStone: { pos: [-0.65, -0.12, 2.98], size: [0.74, 0.44], top: -0.065 },
    walls: { color: "#ece6dc", roughness: 0.95, thickness: 0.06 },
    ceiling: { color: "#f3efe8", thickness: 0.06 },
    // Dark timber skirting / posts (dojo flavour). Must stay inside the wall plane by <= 0.02.
    skirting: { height: 0.08, depth: 0.014, color: "#4b3526" },
    timber: { color: "#4b3526", postSize: 0.09 },
    // Dark timber ceiling cornice (mawaribuchi) on all walls. Sits above everything wall-mounted (library top 2.5).
    cornice: { height: 0.06, depth: 0.03 },
    // Doorway in the S wall: opening x = pos ± width/2, y from y0 to height. A sliding shoji runs on the inside
    // face (panel z range `panelZ`) along a kamoi/shikii track from track[0] to track[1]; it slides `slide` m west.
    door: { pos: [-0.65, 0, 2.5], rotY: PI, width: 0.9, depth: 0.04, height: 2.05, y0: -0.12, panelZ: [2.44, 2.475], track: [-2.08, -0.1], slide: 0.94, seconds: 0.6 },
    // South facade (plaster above dark vertical koshi boards, timber posts and bands) and the roof.
    // roof.y = underside at [north eave, south eave]; eave = overhang past the outer wall face on the S side.
    facade: { koshiTop: 0.95, band: [2.05, 2.13], postW: 0.12 },
    roof: { y: [3.12, 2.93], thickness: 0.07, eave: 0.72, sideOverhang: 0.2, color: "#33322f" },
    // Flush washi disc; main.js places the actual lights (SPEC §4.2).
    // At the room centre; a little larger than before for the 7.5 m room.
    ceilingLight: { pos: [-0.75, 2.78, -1.25], diameter: 0.5, height: 0.07 },
    // Allow-listed wall decor slot: an enso ink scroll hung flat on the S wall's interior face, facing north,
    // west of the projector bracket (x −2.25) and outside the bag clearance (anchor (−3.5, 1.6), ≈0.94 m).
    // pos = centre of the scroll on the wall plane; it may protrude at most `depth` into the room (−z).
    enso: { pos: [-2.9, 1.5, 2.5], rotY: PI, width: 0.45, height: 1.3, depth: 0.04, wall: "S" },
  },

  // ---- objects/projector.js: S-wall projector, linen curtain on a ceiling track, image on the cloth ---
  projector: {
    // Body on a bracket from the S wall (west of the door track); lens points −z (local +z after rotY π).
    // Lens world x = body x − lens.offsetX = −2.31 (beam / light aim at the image centre regardless).
    body: { pos: [-2.25, 2.35, 2.25], rotY: PI, size: [0.3, 0.1, 0.24], color: "#e8e8e6" },
    lens: { radius: 0.032, length: 0.04, offsetX: 0.06 },
    bracket: { arm: 0.25, armSection: 0.04, plate: 0.12 },
    // Projected 16:9 image ON the curtain (follows its folds): x −4.35…−0.15, y 0.219…2.581.
    screen: { pos: [-2.25, 1.4, -2.49], rotY: 0, width: 4.2, height: 2.3625, canvas: [1280, 720], fps: 30 },
    // Heavy natural linen on a slim ceiling track along z (the old N wall line). Walk-through: no collider.
    // x = cloth extent (track runs x[0]−0.02 … x[1]+0.01); top = heading line, hem = bottom edge.
    // pleat: wavelength (m), depth across the image / at the gathered heading / at the free edges / at the hem.
    // segs: grid segments across the image [x, y]; the margins get their own few rows / columns.
    curtain: {
      x: [-4.47, -0.04], z: -2.5, track: 2.72, top: 2.69, hem: 0.05, color: "#e7e0d2",
      pleat: { wavelength: 0.17, image: 0.008, heading: 0.042, edge: 0.03, hem: 0.016 },
      segs: [130, 30],
      // ripple: the player within `near` m of the line pushes the cloth (spring per column)
      ripple: { near: 0.5, contact: 0.32, maxPush: 0.42, width: 0.42, k: 34, damping: 4.2 },
      sway: 0.003,
    },
    // Light: cone sized to the image's height; distance cut-off just past the curtain so the shadowless
    // spot does not carry on into the sleeping nook behind it.
    light: { angle: 0.25, penumbra: 0.6, intensity: 12, distance: 5.3 },
    beam: { opacity: 0.03 },
  },

  // ---- objects/loft.js: ground-level sleeping nook behind the curtain --------------------------------
  // Region x −4.5…−0.05, z −5.0…−2.6. All values world-space; plan rects are [x0, x1] / [z0, z1].
  loft: {
    region: { x: [-4.5, -0.05], z: [-5.0, -2.6] },
    // low oak platform bed, long side on the N wall, head to the W wall (NW corner post left clear)
    bed: { x: [-4.4, -2.35], z: [-4.92, -3.42], height: 0.22, top: 0.05, plinthInset: 0.09, color: "#c9ab82" },
    mattress: { inset: 0.04, height: 0.12, color: "#ece6da" },
    duvet: { color: "#cfc4b0", fold: "#d9d0be", from: -3.55 }, // covers x from the foot to `from`, folded back there
    pillows: { color: ["#f0ebe1", "#e3dccd"] },
    // bedside table at the head, on the bed's south side, with a paper lamp, books and a cup
    table: { pos: [-4.2, 0, -3.16], size: [0.36, 0.42, 0.36], color: "#b8946a" },
    lamp: { pos: [-4.24, 0.42, -3.2], height: 0.36, diameter: 0.26, glow: "#ffd7a3",
      // shadowless, so short-range and nudged toward the bed: it must not reach the room-side floor through the curtain
      light: { intensity: 1.3, distance: 1.3, decay: 2, offset: [0.25, 0.1, -0.25] } },
    books: { pos: [-4.1, -3.1], colors: ["#55634f", "#c4b59a", "#7a5a44"] },
    cup: { pos: [-4.08, -3.04], color: "#9aa39b" },
    rug: { x: [-3.85, -2.45], z: [-3.38, -2.7], height: 0.018, color: "#ddd5c6" },
    cushion: { pos: [-1.35, 0, -4.25], diameter: 0.44, height: 0.15, mat: 0.62, color: "#7d8a86", matColor: "#b9ad97" },
    // shaker-style peg rail on the N wall, two garments hanging from it
    rail: { x: [-1.35, -0.45], y: 1.66, z: -5.0, depth: 0.2, color: "#b8946a", garments: ["#a3b0ba", "#6f6253"] },
    plant: { pos: [-2.0, 0, -4.66], pot: "#d9d3c7", leaf: "#5b7d45", height: 1.75 },
    // high paper window panel: a flat fitting on the N wall face above the bed (the wall is not cut)
    window: { x: [-3.95, -2.85], y: [1.48, 2.16], z: -5.0, depth: 0.035, frame: "#5a4330", glow: "#fff1dc" },
    // sitting up against the pillows, looking south-east at the back of the glowing curtain
    vantage: { pos: [-3.95, 0.75, -4.22], target: [-1.9, 1.2, -2.5], label: "bed" },
  },

  // ---- objects/training.js: rings, Swedish bar, tatami mat, weights --------------------------------
  training: {
    // Spans z −1.6…−0.7, back face on the W wall, front (local +z) faces +x.
    swedishBar: {
      pos: [-4.42, 0, -1.15], rotY: PI / 2, width: 0.9, depth: 0.15, height: 2.4,
      railX: 0.43, rail: [0.04, 2.4, 0.08], // rail box: wide(x) × tall(y) × deep(z)
      rungs: 14, rungRadius: 0.0175, rungLength: 0.86, rungSpacing: 0.16, rungStartY: 0.18, topRungForward: 0.1,
      beltRung: 9, chainLength: 0.4, color: "#d8b98a",
    },
    // Tatami (igusa weave, dark cloth heri borders) at the spec'd mat footprint.
    mat: { pos: [-3.5, 0, 0.2], rotY: 0, width: 1.2, depth: 1.0, height: 0.01 },
    rings: {
      anchor: [-3.5, 2.8, 0.2], // ceiling attachment
      centers: [[-3.5, 2.0, -0.05], [-3.5, 2.0, 0.45]],
      outerDiameter: 0.236, radius: 0.104, tube: 0.014, color: "#c49a6c",
      beam: [0.08, 0.08, 0.7], beamBottomY: 2.72, // beam box x × y × z, running along z
      strapWidth: 0.038, strapThickness: 0.002, buckleY: 2.25, tailEndY: 1.8, tailMarker: 0.12,
      swayDeg: 0.6, swayPeriod: 2.2,
    },
    kettlebells: [
      { pos: [-4.35, 0, 0.1], diameter: 0.17, height: 0.23, kg: 8 },
      { pos: [-4.35, 0, 0.35], diameter: 0.2, height: 0.27, kg: 16 },
      { pos: [-4.35, 0, 0.6], diameter: 0.22, height: 0.3, kg: 24 },
    ],
    kettlebellYaw: 0.3, // random ±
    // Pairs: two dumbbells each, handles along x, at the listed world z.
    dumbbellsA: { pos: [-2.6, 0, -0.55], rotY: 0, width: 0.35, depth: 0.28, height: 0.12, z: [-0.63, -0.47], kg: 10 },
    dumbbellsB: { pos: [-2.6, 0, -0.15], rotY: 0, width: 0.4, depth: 0.4, height: 0.18, z: [-0.26, -0.04], kg: 20 },
    plates: { pos: [-2.55, 0, 0.5], diameter: 0.45, height: 0.15, count: 3, thickness: 0.05, hole: 0.025, offset: 0.02 },
  },

  // ---- objects/bag.js: punching bag + pendulum sim (SPEC §6) ---------------------------------------
  bag: {
    anchor: [-3.5, 2.8, 1.6], // ceiling attachment; the `pivot` group sits here
    clearance: 0.8, // nothing above clearanceAboveY within this horizontal radius of the anchor
    clearanceAboveY: 0.95,
    chainLength: 0.45, strapLength: 0.15, straps: 4,
    height: 1.2, diameter: 0.35, topY: 2.2, bottomY: 1.0, color: "#5a1d12",
    L: 1.2, g: 9.81, damping: 1.8, thetaMax: 0.35,
    // spec HIT 0.40 assumes no damping; with c = 1.8 that peaks at 5.2°. 0.62 gives the spec's ≈8° single-hit peak.
    hit: 0.62, hitHeight: [0.6, 1.8], debounceMs: 80,
    twist: { omega0: 1.5, damping: 1.2, gain: 2.0, maxDeg: 25 },
    squash: { scale: [1.04, 0.97, 1.04], ms: 120 },
  },

  // ---- objects/drums.js: kit + octopad + rug (SPEC §5.4) -------------------------------------------
  drums: {
    // Kit origin = throne. Drummer faces local +z = world −x (west). Local +x = drummer's LEFT.
    // world = (2.45 − z_local, y, −4.0 + x_local)   → use drumToWorld(). The kit sits in the glass booth (`booth`).
    origin: [2.45, 0, -4.0], rotY: -PI / 2,
    rug: { local: [0, 0, 0.4], width: 1.6, depth: 1.6, height: 0.008 },
    // shell: deep cobalt sparkle wrap (owner's compact stage kit; no brand marks). kickReso tints the front head.
    colors: { shell: "#3158c8", kickReso: "#303136", head: "#efeee8", stick: "#d9bd90", cymbal: "#c9a14a", pad: "#1a1a1a", padBody: "#2a2a2c", lcd: "#3fd0c0" },
    // local [x, y, z] of each piece's centre; sizes in metres; tilt in degrees. `sound` = lib/audio.js hit() kind.
    // Four-piece, one up / one down: kick, snare and the rack tom are nudged from SPEC §5.4 so the shells and
    // hoops clear each other (kick hoops rest on the rug, snare lifts over the kick, tom over the snare); the
    // rack tom sits just left of centre on the kick, the ride comes lower/closer over the freed space.
    // Double pedal: beaters at ±beaterX on the main pedal; slave pedal (left foot) centred at x = slaveX,
    // between the snare stand and the hi-hat pedal (hi-hat moved out to make room).
    pieces: {
      throne: { local: [0, 0.5, 0], diameter: 0.36, thickness: 0.08 },
      kick: { local: [0, 0.29, 0.6], diameter: 0.56, depth: 0.45, port: 0.12, pedalZ: 0.3, beaterX: 0.032, slaveX: 0.37, sound: "kick" },
      snare: { local: [0.22, 0.64, 0.28], diameter: 0.36, depth: 0.14, tilt: 8, sound: "snare" },
      hihat: { local: [0.56, 0.85, 0.35], diameter: 0.36, gap: 0.01, sound: "hat" },
      tom1: { local: [0.07, 0.82, 0.57], diameter: 0.25, depth: 0.2, tilt: 12, sound: "tom1" },
      floorTom: { local: [-0.5, 0.5, 0.3], diameter: 0.41, depth: 0.4, sound: "floor" },
      // stand: straight (tube under the tilter) or boom (base [x, z], tube top y); legs = tripod angles in degrees
      crash: { local: [0.45, 1.45, 0.65], diameter: 0.41, tilt: 15, sound: "crash", stand: { legs: [90, 210, 330] } },
      // ride: lifted 10 cm and moved out 8 cm (phase 4) so the octopad below it has stick room
      ride: { local: [-0.5, 1.2, 0.64], diameter: 0.51, tilt: 10, sound: "ride", stand: { boom: true, base: [-0.6, 0.85], tubeTop: 0.86, legs: [90, 210, 330] } },
      // octopad: where the removed middle tom was, over the kick on the drummer's right of the rack tom, on a
      // clamp arm from a post on the kick shell (mount = post base [x, z] on the shell); faces the throne.
      octopad: { local: [-0.35, 0.86, 0.45], size: [0.38, 0.07, 0.28], tilt: 26, pads: [2, 4], pad: [0.07, 0.006, 0.07], sound: "pad", mount: [-0.17, 0.6] },
      sticks: { length: 0.4, radius: 0.007 },
    },
  },

  // ---- objects/booth.js: soundproof glass music corner around the kit -----------------------------
  // Interior x [0, 3], z [−5, −2.5]. Glass on the W (x = 0) and S (z = −2.5) sides; N and E are the room
  // walls (acoustic treatment). Walking line: door (x 0.25…1.15) → strip along the S glass (z −2.5…−3.26,
  // clear of the kit) → the throne's south-east side (≈ 2.55, −3.45). Instruments sit west of the kit around a
  // free standing spot (≈ 0.62, −3.95). All positions world; rotY about +Y (Object3D convention).
  booth: {
    x: [0.0, 3.0], z: [-5.0, -2.5], height: 2.8,
    // frame: face width / depth of the dark aluminium-and-timber sections; channel: top/bottom channel height;
    // panes: two panes `gap` apart (double glazing). mullions: positions of the vertical frames along each run.
    glass: { frame: 0.045, depth: 0.07, channel: 0.07, pane: 0.006, gap: 0.03, tint: "#22302f", frameColor: "#23262a", mullionsW: [-4.15, -3.3], mullionsS: [2.05] },
    // Sliding leaf on its own track just outside (south of) the fixed glass; opening x, leaf z centre, height.
    // Starts OPEN (leaf parked east, outside the fixed S panel). transom glass above the door up to the ceiling.
    door: { x: [0.25, 1.15], z: -2.445, height: 2.12, overlap: 0.03, thickness: 0.04, slide: 0.93, seconds: 0.7, startOpen: true },
    recLight: { pos: [0.7, 2.37, -2.5], size: [0.22, 0.075, 0.09] },
    // acoustic treatment: [along-wall centre, y centre, width, height, colour key]; N: along x at z = −5, E: along z at x = 3
    colors: { charcoal: "#3b3d40", oat: "#b9ae97", indigo: "#4a5372", slat: "#a07a52", felt: "#2a2b2e" },
    panels: {
      N: [[0.55, 1.55, 0.62, 1.1, "charcoal"], [2.3, 1.55, 0.56, 1.1, "indigo"]],
      E: [[-4.2, 1.55, 0.6, 1.1, "oat"], [-3.48, 1.55, 0.6, 1.1, "indigo"], [-2.86, 1.55, 0.5, 1.1, "charcoal"]],
    },
    diffuser: { wall: "N", x: [1.0, 1.9], y: [0.95, 2.25], slat: 0.032, gap: 0.018 },
    depth: 0.05, // panel thickness (<= 0.06)
    clouds: [[1.95, -3.95, 1.2, 0.62], [0.62, -4.2, 1.0, 0.6]], cloudY: 2.48,
    bassTrap: { leg: 0.34, y: [1.2, 2.74] }, // NE corner wedge, mounted above the cart
    // keys: 61-key board on an X-stand along the W glass; local +z (player side) faces east (rotY π/2)
    keyboard: { pos: [0.25, 0, -4.45], rotY: PI / 2, width: 0.96, depth: 0.3, height: 0.085, topY: 0.8, standDepth: 0.36 },
    stool: { pos: [0.63, 0, -4.45], diameter: 0.34, height: 0.5 },
    pedal: { pos: [0.48, 0, -4.62], size: [0.09, 0.04, 0.2] },
    // guitars on A-frame stands along the W glass, fronts facing east; small combo amp in the SW corner by the door
    acoustic: { pos: [0.2, 0, -3.75], rotY: PI / 2, footprint: [0.28, 0.34] },
    electric: { pos: [0.2, 0, -3.33], rotY: PI / 2, footprint: [0.28, 0.34] },
    amp: { pos: [0.14, 0, -2.86], rotY: PI / 2, size: [0.36, 0.3, 0.2] },
    // tabla: woven rug, floor cushion (walk-over, 7 cm), player faces north; dayan (right hand, east) + bayan
    tabla: {
      rug: { pos: [1.02, 0, -4.05], width: 0.46, depth: 0.86 },
      cushion: { pos: [1.02, 0, -3.82], size: 0.38, height: 0.07 },
      dayan: { pos: [1.13, 0, -4.28], diameter: 0.145, height: 0.25, tilt: 8 },
      bayan: { pos: [0.92, 0, -4.3], diameter: 0.23, height: 0.24 },
      ring: 0.2, // ring-cushion (chutta) outer diameter
    },
    // mic stands (round cast bases; base footprints only, booms pass overhead): mic = capsule position
    mics: {
      ohA: { base: [1.24, -4.8], tubeTop: 1.62, mic: [1.9, 1.88, -4.38] },
      ohB: { base: [2.9, -3.8], tubeTop: 1.62, mic: [2.05, 1.88, -3.58] },
      kick: { base: [1.43, -3.9], tubeTop: 0.2, mic: [1.6, 0.22, -3.9] },
      vocal: { base: [0.84, -4.8], tubeTop: 0.82, mic: [1.02, 0.72, -4.56] }, // instrument mic behind the tabla, seated height
      baseDiameter: 0.18,
    },
    // rolling cart against the E wall in the NE corner (laptop + monitors on top, interface on the shelf)
    cart: { pos: [2.82, 0, -4.58], width: 0.32, depth: 0.6, topY: 0.86, shelfY: 0.46 },
    light: { pos: [1.5, 2.3, -3.8], color: "#ffd9ae", intensity: 0.9, distance: 4.2, decay: 2 }, // one small non-shadow light
  },

  // ---- objects/desk.js: standing desk, laptop, journal (SPEC §5.5) ---------------------------------
  desk: {
    // Local +z is the side where the user stands (world −z after rotY π).
    pos: [1.3, 0, 2.1], rotY: PI, width: 1.4, depth: 0.7, topY: 1.05, topThickness: 0.025,
    frame: { legX: 0.6, color: "#1f1f1f" },
    topColor: "#6b4a33",
    // Local coordinates on the desk (y = desk top surface).
    // Laptop is the second screen of the streaming rig: front-left, turned toward the user.
    laptop: { local: [-0.47, 1.05, -0.02], rotDeg: 25, base: [0.31, 0.016, 0.22], lid: [0.31, 0.21, 0.006], openDeg: 110, canvas: [1024, 680], color: "#b9bcc0" },
    journal: { local: [0.42, 1.05, 0.08], rotDeg: 12, page: [0.148, 0.01, 0.21], vDeg: 3, cover: "#2f3b30" },
    pen: { length: 0.14, radius: 0.0045 },
    mug: { local: [-0.33, 1.05, 0.26] },
    keypad: { size: [0.1, 0.02, 0.04], readout: "105" },
    // Streaming rig (desk-local, y absolute; top surface y 1.05). Clamps grip the back edge (z −0.35) and
    // wrap it by 7 mm. Pole entries are [x, z]. Everything stays below y 2.15 (projector at y 2.30).
    rig: {
      monitor: { center: [-0.03, 1.45, -0.15], size: [0.612, 0.36], tiltDeg: 4, canvas: [1024, 576], hz: 8 },
      monitorArm: { pole: [0.36, -0.315], top: 1.47, joint: 1.44, elbow: [0.12, -0.3] },
      headphones: { hookY: 1.33 },
      mic: { pole: [0.62, -0.315], riserTop: 1.16, elbowY: 1.66, center: [0.34, 1.42, 0.2], aim: [-0.1, 1.52, 0.42] },
      keyLight: { pole: [-0.58, -0.315], center: [-0.56, 1.84, -0.24], size: [0.25, 0.17], aim: [0, 1.55, 0.6] },
      streamPad: { local: [-0.15, 1.05, -0.01], rotDeg: 8, grid: [3, 5], tiltDeg: 24 },
      mixer: { local: [0.12, 1.05, -0.02], rotDeg: -6 },
      mat: { local: [-0.02, 1.05, 0.2], size: [0.5, 0.24] },
      keyboard: { local: [-0.06, 1.05, 0.19] },
      mouse: { local: [0.15, 1.05, 0.2], rotDeg: -8 },
      onAir: { local: [0.52, 1.05, -0.29], rotDeg: -20 },
      colors: {
        gear: "#1c1d20", body: "#26272b", soft: "#2c2d31", mat: "#2b2c30", light: "#d8ccb6", onAir: "#bf5440",
        recKey: "#b04a3c", keys: ["#a8875a", "#7a988b", "#a5705d", "#7a86a8", "#927a92", "#c2b8a2", "#76845f"],
      },
    },
  },

  // ---- objects/library.js (SPEC §5.6) --------------------------------------------------------------
  library: {
    // Spans z −0.6…2.4 against the E wall; front (local +z) faces −x into the room.
    pos: [2.825, 0, 0.9], rotY: -PI / 2, width: 3.0, depth: 0.35, height: 2.5,
    bays: 5, bayWidth: 0.6, panel: 0.02, shelves: 6, baseShelfY: 0.08, shelfSpacing: 0.39, color: "#ad8762", // spec oak #b88a5a, eased toward the hinoki floor
    books: {
      thickness: [0.02, 0.06], height: [0.18, 0.33], depth: [0.13, 0.24], frontInset: 0.02, clearance: 0.03,
      fill: [0.85, 0.95], leanEvery: 12, leanDeg: [8, 15], stackBay: 3, stackCount: 4,
      palette: ["#7a2e22", "#2f4858", "#8c7a5b", "#3d5a40", "#c4b59a", "#5a3e5d", "#1f2a36", "#a8642a"],
      // Shelf levels are 0-based (0 = base shelf at baseShelfY); bays are 1-based like the spec.
      stackShelf: 3, linkShelves: [2, 3, 4], gilt: "#cfa75a",
    },
    // Props: plant on top of bay 2, bookend + cord-tied kiri box on one shelf of bay 5.
    props: { plantBay: 2, plantMaxHeight: 0.26, objectsBay: 5, objectsShelf: 2, pot: "#3b3733", leaf: "#3f5a36", box: "#d6c19c", cord: "#3a3858", iron: "#2a2826" },
  },

  // ---- objects/garden.js: small Japanese garden + outdoor training yard ----------------------------
  // x ∈ [-5, 5], z ∈ [2.5, 10.5], ground y = -0.12. Fenced W, S, E and along z = 2.5 beside the house.
  // SHELL's step stone owns doorClear. Lists are world [x, z, …]; `pos` is [x, y, z] with y = ground.
  garden: {
    bounds: { minX: -5, maxX: 5, minZ: 2.5, maxZ: 10.5 },
    groundY: -0.12,
    doorClear: { minX: -1.3, maxX: 0.0, minZ: 2.5, maxZ: 3.3 },
    gravel: { color: "#c9c2b2", tile: 2.0, rakePitch: 0.045 }, // raked E–W; one texture tile = `tile` metres
    // moss islands: [x, z, rx, rz, mound height] (clipped to the fence line); the mat's island is flat
    moss: { color: "#55653a", patches: [[-2.9, 7.2, 2.0, 1.75, 0.04], [0.45, 8.4, 1.3, 0.75, 0], [-4.2, 9.75, 1.0, 0.9, 0.03], [-4.0, 3.55, 1.15, 0.85, 0.03]] },
    // rake rings around the rock island in the gravel: [x, z, radius]
    rings: [[1.45, 7.0, 0.78]],
    // kenninji-gaki: split-bamboo slats between dark timber posts, runs [x0, z0, x1, z1] on the boundary,
    // slats `inset` inside it. Posts every ~postSpacing, bamboo rails at `rails` heights on the inner face.
    fence: {
      height: 1.8, inset: 0.05, slatWidth: 0.052, postSize: 0.09, postSpacing: 1.9, rails: [0.3, 0.85, 1.4],
      runs: [[-5, 2.5, -5, 10.5], [-5, 10.5, 5, 10.5], [5, 10.5, 5, 2.5], [-5, 2.5, -4.63, 2.5], [3.13, 2.5, 5, 2.5]], // the z 2.5 runs end just outside the house corners (outer facade x −4.58 / 3.08)
      bamboo: "#cbbb8a", timber: "#3b2b21",
    },
    // tobi-ishi [x, z, size]: from SHELL's door step south, curving east to the turf; a branch to the mat
    stones: [
      [-0.62, 3.74, 0.46], [-0.42, 4.34, 0.42], [-0.1, 4.88, 0.44], [0.36, 5.32, 0.4], [0.92, 5.58, 0.44],
      [1.5, 5.66, 0.4], [2.05, 5.56, 0.42],
      [0.06, 5.98, 0.36], [-0.04, 6.6, 0.4], [0.12, 7.22, 0.36], [0.4, 7.76, 0.38],
    ],
    // Japanese maple (momiji): bent trunk leaning east, layered canopy pads
    tree: { pos: [-3.0, -0.12, 7.0], height: 3.5, canopy: 1.75, trunk: 0.13, color: "#a63c26" },
    // Kasuga-style toro; window glows at night
    lantern: { pos: [-1.85, -0.12, 8.45], height: 1.32, base: 0.46, rotY: 0.35 },
    // tsukubai: low stone basin with water
    basin: { pos: [-1.15, -0.12, 9.15], diameter: 0.52, height: 0.28 },
    bamboo: { pos: [-4.35, -0.12, 9.85], radius: 0.38, culms: 9, height: [3.3, 4.5], culmRadius: [0.022, 0.034] },
    shrubs: [[-4.35, 3.3, 0.85, 0.58], [-3.6, 3.05, 0.62, 0.44], [-4.45, 5.15, 0.72, 0.5], [1.8, 10.0, 0.8, 0.52], [-0.4, 10.05, 0.62, 0.42]], // [x, z, diameter, height]
    rocks: [ // [x, z, w, d, h, rotY]
      [-2.2, 6.3, 0.72, 0.52, 0.42, 0.4], [-3.95, 8.35, 0.56, 0.46, 0.32, 1.1], [-1.55, 7.38, 0.36, 0.3, 0.16, 2.0],
      [-0.78, 9.4, 0.3, 0.26, 0.14, 0.7], [-1.6, 9.5, 0.28, 0.24, 0.12, 2.6],
      [1.4, 6.96, 0.56, 0.44, 0.38, 0.9], [1.82, 7.24, 0.3, 0.26, 0.17, 0.2],
    ],
    // training strip: dark turf running N–S on the east side
    turf: { pos: [3.6, -0.12, 6.7], width: 2.2, length: 7.0, color: "#2b3429" },
    // battle ropes: one 9 m rope folded round a low anchor = two 4.5 m halves running north to the handles
    ropes: { anchor: [4.15, -0.12, 9.85], length: 4.5, radius: 0.019, spread: 0.46, curve: 0.11, wavelength: 2.4, handle: 0.32, color: "#23262a", tape: "#121212", seconds: 4 },
    // prowler sled: slides along the lane axis (z) only; centre z ∈ laneZ. Push poles at the north end.
    sled: { laneX: 3.05, laneZ: [3.85, 9.55], startZ: 4.75, length: 1.0, width: 0.6, poleHeight: 0.95, plates: 3, maxSpeed: 0.9 },
    yogaMat: {
      pos: [0.45, -0.12, 8.38], rotY: 0, width: 1.83, depth: 0.61, height: 0.006, color: "#5a6c92",
      seat: [1.05, 0.63, 8.38], look: [-2.4, 0.55, 8.0], // seated vantage: eye 0.75 above the ground
    },
    // "elsewhere" notice post / mailbox beside the path, front turned toward the door
    mailbox: { pos: [0.5, -0.12, 4.22], rotY: -2.4, height: 1.25 },
  },
};

export default LAYOUT;

// ---- camera (SPEC §7) -----------------------------------------------------------------------------

export const CAMERA = {
  fov: 50, near: 0.05, far: 80, damping: 0.08, // far: the portrait-phone overview sits ~42 m out
  minDistance: 0.8, maxDistance: 24,
  minPolar: (15 * PI) / 180, maxPolar: (95 * PI) / 180,
  // controls.target is clamped to the house + garden box shrunk by 0.05 m, every frame.
  targetMin: [Math.min(ROOM.minX, -5) + 0.05, -0.07, ROOM.minZ + 0.05],
  targetMax: [Math.max(ROOM.maxX, 5) - 0.05, ROOM.height - 0.05, 10.45],
  tweenSeconds: 0.8,
};

/** Time of day (lib/sky.js). The visitor's local clock unless ?t=HH or __room.setTime(h) pins it. */
export const TIME = {
  latitude: 48, declination: 8, noon: 12.3, // degrees, degrees, local clock hour of the sun's culmination
  refreshSeconds: 60, // re-read the local clock this often
  stepSeconds: 0.9, // T key: ease to the next full hour over this long
};

/**
 * First-person walk mode (main.js). The player is a circle of `radius` on the xz plane at eye height `eye`.
 * Solid = every footprint() that intersects y ∈ solidY (so the mat, rug, rings and projector are not),
 * except the bag, which is pushed instead (bagPush) and only blocks at a smaller radius (bagBlock).
 */
export const WALK = {
  eye: 1.6, fov: 65,
  radius: 0.25,
  wallInset: 0.04, // extra margin past the wall plane (timber posts, skirting)
  solidY: [0.1, 1.7],
  speed: 1.6, run: 2.8, // m/s; Shift = run
  accel: 10, decel: 12, // 1/s, exponential approach to the target velocity
  turnSpeed: 1.9, turnAccel: 12, // rad/s for Left/Right arrows
  pitchSpeed: 1.2, pitchAccel: 9, // rad/s for Up/Down arrows (look up / down), eased in and out
  lookSpeed: 0.0042, // rad per px of drag
  maxPitch: 1.25, // drag and Up/Down share this clamp
  bob: { amp: 0.022, stride: 1.25 }, // vertical bob amplitude (m), metres per bob cycle (two steps)
  spawn: [-0.65, 2.15], spawnTo: [-0.65, 1.0], spawnYaw: 0, introSeconds: 1.7, // genkan -> up onto the timber, facing north
  // The walkable world: room + garden joined through the doorway (fixed geometry, see the phase-4 brief).
  world: {
    low: -0.12, // genkan floor and outside ground; the timber floor is y 0
    genkan: { minX: -1.9, maxX: 0.3, minZ: 1.3 }, // = LAYOUT.shell.genkan; the low rect runs on south through the doorway
    stepEase: 0.15, stepRate: 22, // eye height eases over this many metres across the step edge, then lags at 1/rate s
    doorway: { minX: -1.1, maxX: -0.2 }, doorPass: 0.8, // passable while door openness > doorPass
    wallT: 0.1, // S wall thickness for the player (z from room.maxZ)
    garden: { minX: -5, maxX: 5, minZ: 2.5, maxZ: 10.5 },
    fenceHeight: 1.8,
    passIds: ["doorLeaf", "shell.door"], // footprints the door logic owns (never static solids)
    outsideBlend: [ROOM.maxZ - 0.25, ROOM.maxZ + 0.45], // camera z over which lighting / exposure blends indoors -> outdoors
  },
  reach: 2.6, // look-ray length for targeting
  nearby: 1.6, coneDeg: 60, // proximity fallback: within `near` m and inside this forward cone (full angle)
  bagPush: 0.45, bagBlock: 0.38, bagPushMs: 320, bagPushStrength: 0.45,
  tweenSeconds: 0.8, returnSeconds: 0.6,
};

/**
 * Preset views, indexed by number key. Every preset satisfies the CAMERA limits (checked by checkLayout()).
 * 1 is the start view (the dollhouse: house + garden from the south-west, so the S / W walls and the ceiling
 * cut away). 6 looks back at the house from the garden. 7 is the "elsewhere" notice post in the garden.
 * In walk mode a preset places the player at pos (x, z) at eye height, looking at target.
 * @type {{ id: number, name: string, pos: number[], target: number[] }[]}
 */
export const PRESETS = [
  { id: 0, name: "screen", pos: [-2.1, 1.6, 0.95], target: [-2.25, 1.4, -2.49] }, // nearly square on to the curtain image, clear of the plates
  { id: 1, name: "overview", pos: [-8.9, 10.4, 13.4], target: [-0.3, 0.3, 2.6] },
  { id: 2, name: "training", pos: [-1.2, 1.7, 1.0], target: [-3.7, 1.4, 0.2] },
  { id: 3, name: "music", pos: [2.7, 1.6, -2.85], target: [2.0, 0.85, -4.0] }, // inside the booth, SE corner: kit, keys, tabla, guitar, rec cart
  { id: 4, name: "desk", pos: [1.2, 1.65, 1.1], target: [1.25, 1.08, 2.1] },
  { id: 5, name: "library", pos: [0.8, 1.5, 0.9], target: [2.8, 1.3, 0.9] },
  { id: 6, name: "garden", pos: [1.0, 1.6, 9.5], target: [-0.75, 1.0, 2.6] },
  { id: 7, name: "elsewhere", pos: [-0.45, 1.45, 3.35], target: [0.62, 0.95, 3.78] },
];

export const START_PRESET = 1;

/** Content zones, in HUD order. Same ids as content.json `zones`. */
export const ZONES = ["music", "library", "journal", "laptop", "training", "screen", "door"];

/** zone id → PRESETS index the camera tweens to when that zone's panel opens. "door" = the garden notice post. */
export const ZONE_PRESET = { music: 3, library: 5, journal: 4, laptop: 4, training: 2, screen: 0, door: 7 };

// ---- helpers ----------------------------------------------------------------------------------------

/**
 * Rotate a local [x, y, z] by rotY about +Y and translate by origin. Matches Object3D.rotation.y.
 * @returns {number[]} world [x, y, z]
 */
export function localToWorld(local, origin, rotY) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return [origin[0] + local[0] * c + local[2] * s, origin[1] + local[1], origin[2] - local[0] * s + local[2] * c];
}

/** Drum-kit local → world: (2.45 − z, y, −4.0 + x). */
export const drumToWorld = (local) => localToWorld(local, LAYOUT.drums.origin, LAYOUT.drums.rotY);

/** Desk local → world. */
export const deskToWorld = (local) => localToWorld(local, LAYOUT.desk.pos, LAYOUT.desk.rotY);

// ---- footprints (debug overlap check, SPEC §9) ----------------------------------------------------

/**
 * @typedef {Object} Footprint
 * @property {string} id
 * @property {string} [group]  footprints in the same group may overlap each other (e.g. kit pieces on the rug)
 * @property {number} x        centre, world
 * @property {number} z
 * @property {number} w        size along local x (before rotY)
 * @property {number} d        size along local z
 * @property {number} rotY
 * @property {number} y0       bottom of the object
 * @property {number} y1       top of the object
 * @property {boolean} [round] drawn as a circle of diameter w in debug (still checked as a square)
 */

const fp = (id, pos, w, d, rotY, y0, y1, extra) => ({ id, x: pos[0], z: pos[2], w, d, rotY: rotY || 0, y0, y1, ...extra });

/** Builds the footprint list from LAYOUT (call again if LAYOUT is edited at runtime). @returns {Footprint[]} */
export function footprints() {
  const { shell, projector, training: t, bag, drums, desk, library } = LAYOUT;
  const list = [];

  // Curtain: only the ceiling track is a footprint, overhead (y0 > WALK.solidY), so the cloth is walk-through.
  const cu = projector.curtain;
  list.push(fp("screen", [(cu.x[0] + cu.x[1]) / 2, 0, cu.z], cu.x[1] - cu.x[0], 0.04, 0, cu.track - 0.02, ROOM.height));
  const body = projector.body;
  list.push(fp("projector", body.pos, body.size[0], body.size[2], body.rotY, body.pos[1] - body.size[1] / 2, body.pos[1] + body.size[1] / 2));

  // Sleeping nook (ground level, behind the curtain): bed, table, peg rail + garments, plant, cushion solid;
  // rug flat; paper window flat on the N wall above the bed.
  if (LAYOUT.loft) {
    const L = LAYOUT.loft, lg = { group: "loft" };
    const rect = (id, x, z, y0, y1, extra) => list.push(fp(id, [(x[0] + x[1]) / 2, 0, (z[0] + z[1]) / 2], x[1] - x[0], z[1] - z[0], 0, y0, y1, { ...lg, ...extra }));
    rect("loft.bed", L.bed.x, L.bed.z, 0, L.bed.height + L.mattress.height + 0.12);
    const tb = L.table;
    list.push(fp("loft.table", tb.pos, tb.size[0], tb.size[2], 0, 0, tb.size[1] + L.lamp.height, lg));
    rect("loft.rug", L.rug.x, L.rug.z, 0, L.rug.height);
    list.push(fp("loft.cushion", L.cushion.pos, L.cushion.mat, L.cushion.mat, 0, 0, L.cushion.height + 0.03, lg));
    rect("loft.rail", L.rail.x, [L.rail.z, L.rail.z + L.rail.depth], 0.5, L.rail.y + 0.06);
    list.push(fp("loft.plant", L.plant.pos, 0.36, 0.36, 0, 0, L.plant.height, { ...lg, round: true }));
    rect("loft.window", L.window.x, [L.window.z, L.window.z + L.window.depth], L.window.y[0], L.window.y[1]);
  }

  // the shoji where it rests when OPEN (west of the doorway); the doorway itself is ENGINE's wall-gap logic
  const dr = shell.door, stackX1 = dr.pos[0] - dr.width / 2, stackX0 = stackX1 - dr.slide;
  list.push(fp("door", [(stackX0 + stackX1) / 2, 0, (dr.panelZ[0] + dr.panelZ[1]) / 2], stackX1 - stackX0, dr.panelZ[1] - dr.panelZ[0], 0, 0, dr.height + 0.03));
  const gb = shell.getabako;
  list.push(fp("getabako", gb.pos, gb.width, gb.depth, gb.rotY, gb.pos[1], gb.pos[1] + gb.height));
  const bn = shell.genkanBench;
  if (bn) list.push(fp("genkanBench", bn.pos, bn.width, bn.depth, bn.rotY, bn.pos[1], bn.pos[1] + bn.height));
  const us = shell.umbrellaStand;
  if (us) list.push(fp("umbrellaStand", us.pos, us.diameter, us.diameter, 0, us.pos[1], us.pos[1] + 0.92, { round: true })); // umbrella handles on top
  const sl = shell.slippers;
  list.push(fp("slippers", sl.pos, sl.width, sl.depth, 0, 0, sl.height));
  const cl = shell.ceilingLight;
  list.push(fp("ceilingLight", cl.pos, cl.diameter, cl.diameter, 0, cl.pos[1] - cl.height / 2, ROOM.height, { round: true }));
  const en = shell.enso;
  const enIn = [Math.sin(en.rotY), Math.cos(en.rotY)]; // into-the-room direction of the scroll's face
  list.push(fp("enso", [en.pos[0] + (enIn[0] * en.depth) / 2, 0, en.pos[2] + (enIn[1] * en.depth) / 2], en.width, en.depth, en.rotY, en.pos[1] - en.height / 2, en.pos[1] + en.height / 2));

  const sb = t.swedishBar;
  list.push(fp("swedishBar", sb.pos, sb.width, sb.depth, sb.rotY, 0, sb.height));
  list.push(fp("mat", t.mat.pos, t.mat.width, t.mat.depth, t.mat.rotY, 0, t.mat.height));
  const r = t.rings;
  list.push(fp("rings", r.anchor, r.outerDiameter, r.beam[2], 0, r.centers[0][1] - r.outerDiameter / 2, ROOM.height));
  t.kettlebells.forEach((k, i) => list.push(fp(`kettlebell${i + 1}`, k.pos, k.diameter, k.diameter, 0, 0, k.height, { round: true })));
  for (const key of ["dumbbellsA", "dumbbellsB"]) {
    const dd = t[key];
    list.push(fp(key, dd.pos, dd.width, dd.depth, dd.rotY, 0, dd.height));
  }
  list.push(fp("plates", t.plates.pos, t.plates.diameter, t.plates.diameter, 0, 0, t.plates.height, { round: true }));

  list.push(fp("bag", bag.anchor, bag.diameter, bag.diameter, 0, bag.bottomY, ROOM.height, { round: true }));

  // Drum rug + kit pieces: one group, so they may overlap each other.
  const g = { group: "drums" };
  const rug = drums.rug;
  list.push(fp("drumRug", drumToWorld(rug.local), rug.width, rug.depth, drums.rotY, 0, rug.height, g));
  const p = drums.pieces;
  const piece = (id, w, d, h) => {
    const wpos = drumToWorld(p[id].local);
    list.push(fp(`drums.${id}`, wpos, w, d, drums.rotY, 0, wpos[1] + h, { ...g, round: w === d }));
  };
  piece("throne", p.throne.diameter, p.throne.diameter, p.throne.thickness / 2);
  piece("kick", p.kick.diameter, p.kick.depth, p.kick.diameter / 2);
  piece("snare", p.snare.diameter, p.snare.diameter, p.snare.depth / 2);
  piece("hihat", p.hihat.diameter, p.hihat.diameter, 0.02);
  piece("tom1", p.tom1.diameter, p.tom1.diameter, p.tom1.depth / 2);
  piece("floorTom", p.floorTom.diameter, p.floorTom.diameter, p.floorTom.depth / 2);
  piece("crash", p.crash.diameter, p.crash.diameter, 0.05);
  piece("ride", p.ride.diameter, p.ride.diameter, 0.05);
  // the octopad rides on a clamp arm over the kick (no floor stand): covered by the kick / floor tom footprints

  // Music booth: fixed glass (full height, the door opening left free; the sliding leaf is a dynamic collider),
  // instruments, cart, mic-stand bases. One group. Laid out clear of every drum footprint in plan.
  if (LAYOUT.booth) {
    const B = LAYOUT.booth, bg = { group: "booth" };
    const [bx0, bx1] = B.x, [bz0, bz1] = B.z, gt = 0.08, H = B.height;
    list.push(fp("booth.glassW", [bx0, 0, (bz0 + bz1) / 2], gt, bz1 - bz0, 0, 0, H, bg));
    const [dx0, dx1] = B.door.x;
    list.push(fp("booth.glassS1", [(bx0 + dx0) / 2, 0, bz1], dx0 - bx0, gt, 0, 0, H, bg));
    list.push(fp("booth.glassS2", [(dx1 + bx1) / 2, 0, bz1], bx1 - dx1, gt, 0, 0, H, bg));
    const k = B.keyboard;
    list.push(fp("booth.keyboard", k.pos, k.width + 0.04, k.standDepth, k.rotY, 0, k.topY + 0.1, bg));
    list.push(fp("booth.stool", B.stool.pos, B.stool.diameter, B.stool.diameter, 0, 0, B.stool.height, { ...bg, round: true }));
    for (const id of ["acoustic", "electric"]) {
      const gq = B[id];
      list.push(fp(`booth.${id}`, gq.pos, gq.footprint[1], gq.footprint[0], gq.rotY, 0, 1.06, bg));
    }
    list.push(fp("booth.amp", B.amp.pos, B.amp.size[0], B.amp.size[2], B.amp.rotY, 0, B.amp.size[1], bg));
    const tb = B.tabla;
    list.push(fp("booth.tablaCushion", tb.cushion.pos, tb.cushion.size, tb.cushion.size, 0, 0, tb.cushion.height, bg)); // walk-over
    list.push(fp("booth.dayan", tb.dayan.pos, tb.ring, tb.ring, 0, 0, tb.dayan.height + 0.06, { ...bg, round: true }));
    list.push(fp("booth.bayan", tb.bayan.pos, tb.bayan.diameter + 0.03, tb.bayan.diameter + 0.03, 0, 0, tb.bayan.height + 0.05, { ...bg, round: true }));
    for (const [id, m] of Object.entries(B.mics)) {
      if (!m || !m.base) continue;
      list.push(fp(`booth.mic.${id}`, [m.base[0], 0, m.base[1]], B.mics.baseDiameter, B.mics.baseDiameter, 0, 0, m.tubeTop, { ...bg, round: true }));
    }
    const c = B.cart;
    list.push(fp("booth.cart", c.pos, c.width, c.depth, 0, 0, c.topY + 0.25, bg));
    const tr = B.bassTrap, leg = tr.leg;
    list.push(fp("booth.bassTrap", [bx1 - leg / 2, 0, bz0 + leg / 2], leg, leg, 0, tr.y[0], tr.y[1], bg));
  }

  list.push(fp("library", library.pos, library.width, library.depth, library.rotY, 0, library.height));
  list.push(fp("desk", desk.pos, desk.width, desk.depth, desk.rotY, 0, desk.topY));

  // Garden (outside, ground y = -0.12): solid props only; stones, mats, turf and ropes are walk-over flat.
  if (LAYOUT.garden) {
    const G = LAYOUT.garden;
    const gy = G.groundY;
    const gg = { group: "garden" };
    const at = (x, z) => [x, gy, z];
    const tr = G.tree;
    list.push(fp("garden.tree", at(tr.pos[0] + 0.14, tr.pos[2]), 0.62, 0.38, 0, gy, gy + tr.height, gg)); // trunk leans east
    const ln = G.lantern;
    list.push(fp("garden.lantern", ln.pos, ln.base, ln.base, ln.rotY, gy, gy + ln.height, gg));
    const bs = G.basin;
    list.push(fp("garden.basin", bs.pos, bs.diameter, bs.diameter, 0, gy, gy + bs.height, { ...gg, round: true }));
    G.rocks.forEach(([x, z, w, d, h, r], i) => {
      if (h > 0.3) list.push(fp(`garden.rock${i + 1}`, at(x, z), w, d, r, gy, gy + h, gg));
    });
    G.shrubs.forEach(([x, z, dia, h], i) => list.push(fp(`garden.shrub${i + 1}`, at(x, z), dia * 0.8, dia * 0.8, 0, gy, gy + h, { ...gg, round: true })));
    const bb = G.bamboo;
    list.push(fp("garden.bamboo", bb.pos, bb.radius * 2, bb.radius * 2, 0, gy, gy + bb.height[1], { ...gg, round: true }));
    const ra = G.ropes.anchor;
    list.push(fp("garden.ropeAnchor", ra, 0.2, 0.2, 0, gy, gy + 0.3, gg));
    const mb = G.mailbox;
    list.push(fp("garden.mailbox", mb.pos, 0.34, 0.26, mb.rotY, gy, gy + mb.height, gg));
  }
  return list;
}

/** Pairs (by id) that are allowed to overlap in plan. Same-`group` pairs are always allowed. */
export const FOOTPRINT_ALLOW = [
  ["mat", "rings"],
  ["desk", "projector"], // share (x, z) but separated vertically
];

/** Ids ignored by the bag-clearance check. */
export const CLEARANCE_IGNORE = ["bag"];

/** World-space corners [[x, z] × 4] of a footprint rectangle. */
export function footprintCorners(f) {
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  const hw = f.w / 2, hd = f.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c]);
}

// Penetration depth of two convex quads (SAT). <= 0 means separated or just touching.
function overlapDepth(a, b) {
  let depth = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const p0 = poly[i], p1 = poly[i + 1];
      const ex = p1[0] - p0[0], ez = p1[1] - p0[1];
      const len = Math.hypot(ex, ez) || 1;
      const nx = ex / len, nz = ez / len; // rectangle edge directions are its separating axes
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const q of a) { const v = q[0] * nx + q[1] * nz; aMin = Math.min(aMin, v); aMax = Math.max(aMax, v); }
      for (const q of b) { const v = q[0] * nx + q[1] * nz; bMin = Math.min(bMin, v); bMax = Math.max(bMax, v); }
      depth = Math.min(depth, Math.min(aMax, bMax) - Math.max(aMin, bMin));
    }
  }
  return depth;
}

// Shortest horizontal distance from a point to a footprint rectangle (0 if inside).
function distanceToFootprint(f, px, pz) {
  const c = Math.cos(f.rotY), s = Math.sin(f.rotY);
  const dx = px - f.x, dz = pz - f.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - f.w / 2, 0), Math.max(Math.abs(lz) - f.d / 2, 0));
}

/**
 * SPEC §9 checks, pure: footprint overlaps (> tolerance), bag clearance, footprints inside the room,
 * presets within camera limits. Returns human-readable violations; empty array = all good.
 * @param {number} [tolerance=0.01]
 * @returns {string[]}
 */
export function checkLayout(tolerance = 0.01) {
  const out = [];
  const list = footprints();
  const allowed = (a, b) =>
    (a.group && a.group === b.group) ||
    FOOTPRINT_ALLOW.some(([p, q]) => (p === a.id && q === b.id) || (p === b.id && q === a.id));

  // vertically separated footprints (an overhead deck over a drum kit) never collide
  const stacked = (a, b) => a.y1 <= b.y0 + tolerance || b.y1 <= a.y0 + tolerance;
  // a corner may sit in the room or in the garden (the fence line and house front may straddle z = 2.5 a little)
  const gb = WALK.world.garden;
  const inRoom = (x, z) => x >= ROOM.minX - 0.021 && x <= ROOM.maxX + 0.021 && z >= ROOM.minZ - 0.021 && z <= ROOM.maxZ + 0.021;
  const inGarden = (x, z) => x >= gb.minX - 0.021 && x <= gb.maxX + 0.021 && z >= gb.minZ - 0.1 && z <= gb.maxZ + 0.021;
  const corners = list.map(footprintCorners);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (allowed(list[i], list[j]) || stacked(list[i], list[j])) continue;
      const depth = overlapDepth(corners[i], corners[j]);
      if (depth > tolerance) out.push(`overlap: ${list[i].id} ↔ ${list[j].id} by ${depth.toFixed(3)} m`);
    }
    for (const [x, z] of corners[i]) {
      if (!inRoom(x, z) && !inGarden(x, z)) {
        out.push(`outside room and garden: ${list[i].id} corner (${x.toFixed(3)}, ${z.toFixed(3)})`);
        break;
      }
    }
  }

  const { anchor, clearance, clearanceAboveY } = LAYOUT.bag;
  for (const f of list) {
    if (CLEARANCE_IGNORE.includes(f.id) || f.y1 <= clearanceAboveY) continue;
    const dist = distanceToFootprint(f, anchor[0], anchor[2]);
    if (dist < clearance) out.push(`bag clearance: ${f.id} (top y ${f.y1.toFixed(2)}) is ${dist.toFixed(3)} m from the anchor, needs >= ${clearance}`);
  }
  const wallGap = Math.min(anchor[0] - ROOM.minX, ROOM.maxX - anchor[0], anchor[2] - ROOM.minZ, ROOM.maxZ - anchor[2]);
  if (wallGap < clearance) out.push(`bag clearance: nearest wall is ${wallGap.toFixed(3)} m from the anchor`);

  for (const p of PRESETS) {
    const d = [p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    const polar = Math.acos(d[1] / dist);
    const inBox = p.target.every((v, i) => v >= CAMERA.targetMin[i] && v <= CAMERA.targetMax[i]);
    if (!inBox) out.push(`preset ${p.id} (${p.name}): target outside the clamp box`);
    if (dist < CAMERA.minDistance || dist > CAMERA.maxDistance) out.push(`preset ${p.id} (${p.name}): distance ${dist.toFixed(2)} outside limits`);
    if (polar < CAMERA.minPolar || polar > CAMERA.maxPolar) out.push(`preset ${p.id} (${p.name}): polar angle ${((polar * 180) / PI).toFixed(1)}° outside limits`);
    if (p.id === START_PRESET) continue; // the overview floats above everything
    // a walk preset puts the player circle at (x, z): it must not start inside a wall or a solid footprint
    const [px, , pz] = p.pos;
    const R = WALK.radius;
    const inHouse = px > ROOM.minX + R && px < ROOM.maxX - R && pz > ROOM.minZ + R && pz < ROOM.maxZ - R;
    const inYard = px > gb.minX + R && px < gb.maxX - R && pz > gb.minZ + R && pz < gb.maxZ - R;
    if (!inHouse && !inYard) out.push(`preset ${p.id} (${p.name}): player circle at (${px}, ${pz}) crosses a wall or the fence`);
    for (const f of list) {
      if (f.id === "bag" || WALK.world.passIds.includes(f.id) || !(f.y1 > WALK.solidY[0] && f.y0 < WALK.solidY[1])) continue;
      const dist = distanceToFootprint(f, px, pz);
      if (dist < R) out.push(`preset ${p.id} (${p.name}): player circle overlaps ${f.id} (${dist.toFixed(3)} m from it)`);
    }
  }
  // ENGINE's walk height (WALK.world.genkan) must follow SHELL's sunken genkan rect
  const gk = LAYOUT.shell && LAYOUT.shell.genkan, wg = WALK.world.genkan;
  if (gk && (Math.abs(gk.x[0] - wg.minX) > 1e-6 || Math.abs(gk.x[1] - wg.maxX) > 1e-6 || Math.abs(gk.z[0] - wg.minZ) > 1e-6)) {
    out.push(`genkan: WALK.world.genkan (${wg.minX}, ${wg.maxX}, ${wg.minZ}) differs from shell.genkan (${gk.x}, ${gk.z[0]})`);
  }
  for (const z of ZONES) if (!PRESETS[ZONE_PRESET[z]]) out.push(`zone ${z}: no preset`);
  return out;
}
