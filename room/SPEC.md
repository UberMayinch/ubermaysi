# Room — 3D scene spec (Three.js)

Implementation spec for an interactive 3D render of a home studio / training room. You (the implementer) have not seen the conversation that produced this; everything you need is here. Where this spec gives a number, use it. Where it says "default", it is a decision already made; don't re-ask.

---

## 0. Assumptions and open questions (defaults chosen)

| # | Question | Default used in this spec |
|---|---|---|
| A1 | Room size | 6.0 m (W–E) × 5.0 m (N–S) × 2.8 m ceiling |
| A2 | "Projector on one wall" | Projector on a wall bracket high on the **south** wall, throwing a 16:9 image onto the **north** wall (painted-screen rectangle). |
| A3 | Visual style | Stylized-realistic. Everything is built **procedurally** from Three.js primitives and canvas textures. No downloaded GLTF models, no image files, no external textures. |
| A4 | Camera | Orbit "dollhouse" camera with automatic wall cutaway (§7). First-person is out of scope for v1. |
| A5 | URL | Page lives at `/room/` on the site. Whether the homepage links to it is **open**; v1 does not touch the homepage. |
| A6 | Drummer handedness | Right-handed kit (hi-hat on drummer's left, floor tom and ride on the right). |
| A7 | Projector content | Placeholder animated canvas (§5.1). Site-content tie-ins are v2 (§11). |
| A8 | Only hard interaction | The punching bag can be hit and swings realistically (§6). Everything else is static in v1. |

---

## 1. Repo constraints (read before writing code)

- The site is a **zero-dependency static site**. `build.mjs` builds into `dist/` with no bundler. Do not add npm dependencies, a bundler, or a `node_modules` requirement.
- Deploy is GitHub Pages via `.github/workflows/deploy.yml`, which runs `node build.mjs`. The site may be served **under a subpath** (see `PUBLIC_URL` / `BASE` in `build.mjs`). Therefore the room page must use **relative URLs only** (`./main.js`, `../`, never `/room/main.js`).
- `build.mjs` currently copies only `static/style.css`. Extend it to copy `room/` → `dist/room/` recursively, **excluding `*.md`**. Use `fs/promises` `cp` with `{ recursive: true, filter: (src) => !src.endsWith(".md") }`, added to the existing `Promise.all` near the end of the file.
- Load Three.js with an **import map** from `https://cdn.jsdelivr.net/npm/three@<VERSION>/...`. Pin one **exact** published version (check npm; choose a release at least two weeks old, r160 or newer). Map `three` → `build/three.module.js` and `three/addons/` → `examples/jsm/`, both at the same version.
- Match the site's look for any 2D UI: background `#fbfaf7` / dark `#141312`, foreground `#1d1c1a`, accent `#8a3b1e`, monospace UI text (`ui-monospace, Menlo, monospace`). Link back to the homepage with `href="../"`.

### File layout

```
room/
  SPEC.md            (this file; not deployed)
  index.html         canvas, import map, minimal HUD
  main.js            renderer, scene, loop, resize, input wiring
  layout.js          ALL world positions/rotations/sizes from §3 as exported constants (single source of truth)
  lib/rng.js         seeded PRNG (mulberry32), seed 42
  lib/textures.js    canvas-texture helpers (wood, ruled paper, book spines, screens)
  lib/audio.js       WebAudio thump synth (§6.4)
  objects/shell.js   floor, walls, ceiling, door, ceiling light
  objects/projector.js
  objects/training.js  rings, Swedish bar, mat, weights
  objects/bag.js       punching bag + pendulum sim
  objects/drums.js     kit + octopad + rug
  objects/desk.js      standing desk, laptop, journal
  objects/library.js
```

Each `objects/*.js` exports `build(scene, layout) → { root: Object3D, update?(dt), colliders?: Mesh[] }`.

---

## 2. Coordinate system and conventions

- Units: **meters**. Y-up. Origin at the **floor center**.
- `x ∈ [-3, 3]`: west (−) to east (+). `z ∈ [-2.5, 2.5]`: north (−) to south (+). Floor at `y = 0`, ceiling at `y = 2.8`.
- Walls: **N** at `z = -2.5`, **S** at `z = +2.5`, **W** at `x = -3`, **E** at `x = +3`.
- Each object's local **front faces +z** before rotation. `rotY` in the table rotates about +Y (Three.js convention: `rotY = -π/2` turns local +z to world −x; `rotY = π` turns it to world −z).
- Positions in the table are the object root's origin: floor-contact center unless stated (e.g. "anchor" means ceiling attachment point).

---

## 3. Layout

### 3.1 Floor plan (to scale: 1 char = 0.1 m across, 1 row = 0.2 m down; the table in §3.2 is authoritative)

```
        W x=-3.0                    x=0                     x=+3.0 E
        +------------------------------------------------------------+
 z=-2.5 |                   ======================                   |
        |                        SCREEN (N wall)     ~~~~~~~~~~~~8~~ |
        |                                            ~~~~~~~~~~~~~~~ |
        |                                            ~~~~~~~~~~~~~~~ |
        |#                                           ~~~~~~~~~~~~~~~ |
 z=-1.5 |#                                           ~~~~~~K~~~~~T~~ |
        |# SWEDISH                                   ~~~~~~~~~~~~~~~ |
        |#                                           ~~~~~~~~~~~~~~~ |
        |# BAR                                       ~DRUMS~~~~~~~~~ |
        |#                                           ~~~~~~~~~~~~~~~ |
 z=-0.5 |                   dd                                   LLL |
        |    ------------                                        LLL |
        |    ------o-----   DD                                   LLL |
        | k  -------RINGS                                        LLL |
        | k  ------------                                        LLL |
 z=+0.5 |    ------o-----    P                                   LLL |
        | k  ------------                                        LLIB|
        |     ...     ...                                        LLL |
        |   ..           ..                                      LLL |
        |  ..             ..                                     LLL |
 z=+1.5 |  .       B BAG   .                                     LLL |
        |  .               .                 DDDDDDDDDDDDDD      LLL |
        |  ..             ..                 DDDDDDDDDDDDDD      LLL |
        |   ..           ..                  DDDDDESKDDDDDD      LLL |
        |     ...     ...   _door____  P<-projDDDDDDDDDDDDD      LLL |
        +------------------------------------------------------------+
  ===  projection on N wall      #  Swedish bar (W wall)    ---  floor mat under rings
  o    ring positions            k  kettlebells   dd/DD dumbbell pairs   P (west) plate stack
  ...  bag swing clearance (r = 0.8 m around anchor)        B  bag anchor
  ~~~  drum rug   K kick   T throne   8 octopad             LLL library (E wall)
  DDD  standing desk             P (south) projector, mounted at y = 2.35 above the desk zone
```

Three zones: **Training** (west), **Music** (north-east), **Work/study** (south-east + east wall). Center of the room stays open; the projector beam crosses it above head height.

### 3.2 Layout table (put these values in `layout.js`)

| Object | Position (x, y, z) | rotY | Footprint W × D (m) | Height (m) | Notes |
|---|---|---|---|---|---|
| Projection image (N wall) | (0, 1.65, -2.495) | 0 | 2.20 × — | 1.2375 | 16:9 rect, bottom edge y 1.03, top 2.27 |
| Projector body | (0, 2.35, 2.25) | π | 0.30 × 0.24 | 0.10 | on bracket from S wall; lens points −z |
| Door (S wall, closed) | (-0.65, 0, 2.5) | π | 0.90 × 0.04 | 2.05 | slab + frame + handle; flush with wall |
| Ceiling light | (0, 2.78, 0) | 0 | Ø 0.40 | 0.06 | flush disc, emissive |
| Swedish bar | (-2.92, 0, -1.15) | π/2 | 0.90 × 0.15 | 2.40 | spans z −1.6…−0.7, back face touching W wall |
| Floor mat | (-2.0, 0, 0.2) | 0 | 1.20 × 1.00 | 0.01 | under rings |
| Rings anchor (ceiling) | (-2.0, 2.8, 0.2) | 0 | — | — | two straps at z −0.05 and z +0.45 |
| Ring centers | (-2.0, 2.0, -0.05), (-2.0, 2.0, 0.45) | 0 | Ø 0.236 outer | — | |
| Kettlebells ×3 | (-2.85, 0, 0.1), (-2.85, 0, 0.35), (-2.85, 0, 0.6) | random ±0.3 | Ø 0.17 / 0.20 / 0.22 | 0.23 / 0.27 / 0.30 | 8 / 16 / 24 kg sizes |
| Dumbbell pair A (10 kg) | (-1.1, 0, -0.55) | 0 | pair 0.35 × 0.28 | 0.12 | two dumbbells, handles along x, at z −0.63 and −0.47 |
| Dumbbell pair B (20 kg) | (-1.1, 0, -0.15) | 0 | pair 0.40 × 0.40 | 0.18 | two dumbbells, handles along x, at z −0.26 and −0.04 |
| Plate stack | (-1.05, 0, 0.5) | random | Ø 0.45 | 0.15 | 3 bumper plates, slightly offset |
| Bag anchor (ceiling) | (-2.0, 2.8, 1.6) | 0 | — | — | swing clearance radius 0.8 m (see §6.5) |
| Drum kit origin (throne) | (2.55, 0, -1.55) | -π/2 | rug 1.60 × 1.60 | — | drummer faces west; local pieces in §5.4 |
| Library | (2.825, 0, 0.9) | -π/2 | 3.00 × 0.35 | 2.50 | spans z −0.6…2.4 against E wall |
| Standing desk | (1.3, 0, 2.1) | π | 1.40 × 0.70 | top at 1.05 | user stands at z ≈ 1.5 facing S wall |

**No-overlap rule:** no two top-level objects' footprints may intersect, except the rug with the kit, and the mat with the rings. The desk and projector share an (x, z) footprint but are separated vertically (desk top 1.05 m vs projector bottom 2.30 m). This is allowed.

---

## 4. Shell, materials, lighting, renderer

### 4.1 Shell
- **Floor:** light oak planks. Canvas texture 1024², planks 0.18 m wide, random length 0.8–1.6 m, subtle tone variation (seeded), `repeat` set so planks run E–W. `MeshStandardMaterial`, roughness 0.75.
- **Walls:** warm off-white `#ece6dc`, roughness 0.95. The N-wall projection area is the same wall; the image is a separate mesh offset 5 mm (§5.1).
- **Ceiling:** `#f3efe8`. Skirting boards 0.08 m tall, `#d9d1c4`, on all walls.
- Walls are separate meshes (N, S, E, W, ceiling) so the cutaway can hide them individually (§7).

### 4.2 Lighting (mood: evening, projector on)
- `HemisphereLight(sky #fff4e6, ground #3a3430, 0.35)`.
- Ceiling light, two parts:
  - `SpotLight(#ffe2bf)` at (0, 2.75, 0) pointing straight down, `angle ≈ 1.2 rad`, `penumbra 0.6`, `decay 2`. This is the **only shadow-casting light**: `shadow.mapSize = 2048`, `shadow.bias = -0.0005`. Don't use a shadow-casting `PointLight`; it renders 6 shadow views per frame.
  - `PointLight(#ffe2bf)` at (0, 2.6, 0), **no shadows**, low intensity, to fill the walls and ceiling.
  - Tune intensities so the floor reads ~mid-grey.
- Projector: `SpotLight(#ffffff)` at the lens, target = projection center, `angle ≈ 0.26 rad` (covers the 2.2 × 1.24 m image at ≈ 4.6 m throw), `penumbra 0.2`, low intensity, `castShadow = false`. Also a faint beam: a cone mesh from lens to the image rectangle, additive blending, opacity 0.035, `depthWrite false`.
- Laptop screen and projection image use emissive/basic materials so they glow regardless of light.

### 4.3 Renderer
- `WebGLRenderer({ antialias: true })`, `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`, exposure ≈ 1.0, `shadowMap.type = PCFSoftShadowMap`.
- `setPixelRatio(Math.min(devicePixelRatio, 2))`. Resize on `resize` event.
- Fixed-step simulation (§6.3) inside a `requestAnimationFrame` loop.

---

## 5. Objects (dimensions and primitive breakdown)

Every `CanvasTexture` sets `texture.colorSpace = SRGBColorSpace` (otherwise screens and spines render washed out). Material defaults: `MeshStandardMaterial`; wood roughness 0.6, metal metalness 0.9 / roughness 0.35, rubber roughness 0.9, leather roughness 0.55. Use the seeded PRNG for every "random" value so the scene is identical on every load.

### 5.1 Projector + projection
- Wall bracket: arm 0.25 m from S wall (box 0.04 × 0.04), mount plate on wall 0.12 × 0.12.
- Body: rounded box 0.30 × 0.10 × 0.24, matte white `#e8e8e6`. Lens: cylinder r 0.032, length 0.04, dark glass, on the local front (+z) face (world −z after rotY π), offset 0.06 to one side. A small emissive status LED.
- Image: `PlaneGeometry(2.2, 1.2375)` at the position in §3.2, `MeshBasicMaterial` with a `CanvasTexture` (1280 × 720) and `toneMapped: false`. Content (v1 placeholder): dark background `#141312`, slowly drifting generative lines in the accent `#e08a5f` and off-white, plus the text `ubermayinch` bottom-left in monospace. Redraw at ≤ 30 Hz (`texture.needsUpdate = true` only on redraw frames).
- Thin dark border 0.02 m around the image (a painted-screen frame).

### 5.2 Calisthenics rings
- Ceiling mount: a short wooden beam 0.7 × 0.08 × 0.08 fixed under the ceiling at the anchor (bottom face at y 2.72), running along z, with two eye bolts at z −0.05 and +0.45.
- Straps: flat boxes 0.038 wide × 0.002 thick, black webbing, from the eye bolt (y 2.72) down to the ring top (y 2.0 + 0.118 = 2.118), plus a short loop around the ring. A cam buckle (box 0.05 × 0.07 × 0.02, metal) sits at y 2.25. The **strap tail** hangs freely from the buckle down to y 1.80, beside the strap; its last 0.12 m is a yellow band (the adjust-height marker).
- Rings: `TorusGeometry(R = 0.104, tube = 0.014, 16, 48)`, wood `#c49a6c`. Ring plane is the y–x plane (rings face the room's east–west axis).
- Idle sway (optional polish): each ring rotates ±0.6° about the strap top with a 2.2 s period, phase-offset.

### 5.3 Swedish bar (stall bars) and weights
- Two side rails: boxes 0.08 (deep) × 2.40 (tall) × 0.04 (wide), pine `#d8b98a`, at local x ±0.43.
- **14 rungs**: cylinders r 0.0175, length 0.86, spaced 0.16 m from y 0.18 up. Use **one `InstancedMesh`**. Top rung offset 0.10 m forward (away from wall) for pull-ups.
- 4 wall brackets (small metal boxes) at top and bottom of each rail.
- Draped dip belt: a thin flattened torus hanging on rung 9 with a 0.4 m chain (instanced small tori) and a carabiner.
- **Kettlebells:** sphere body (radius per §3.2) with flattened base, plus a handle from `TorusGeometry` half-arc (use `arc = π`) and two short cylinders joining it to the body. Cast iron `#2b2b2b`, metalness 0.6.
- **Dumbbells:** hex heads (`CylinderGeometry` with 6 radial segments) at each end, knurled-looking handle cylinder r 0.016. Black rubber heads, chrome handle. Lying on their side.
- **Plate stack:** 3 bumper plates (cylinders r 0.225, thickness 0.05) with a 0.025 m center hole (use `LatheGeometry` or a ring of a cylinder with an inner cylinder in dark), each offset ±0.02 m and rotated randomly; colors black with one thin colored stripe (canvas texture or a slim torus).
- **Mat:** 1.2 × 1.0 × 0.01, dark grey rubber `#3a3a3a`.

### 5.4 Drum kit + octopad
Generic five-piece kit; do not replicate a specific brand's look or logos. Shells: lacquer `#7a1f1f` (deep red) with chrome hardware; heads off-white `#efeee8`; cymbals gold-bronze `#c9a14a`, metalness 1.0, roughness 0.3, made with `LatheGeometry` (slight bell and taper).

Local coordinates relative to the kit origin (throne), drummer facing **local +z**. **Local +x is the drummer's LEFT; local −x is the drummer's RIGHT.** World = origin + R(−π/2)·local, i.e. `world = (2.55 − z_local, y, −1.55 + x_local)`.

| Piece | Local (x, y, z) | Size | Notes |
|---|---|---|---|
| Throne | (0, 0.50, 0) | seat Ø 0.36, 0.08 thick | tripod base |
| Kick | (0, 0.28, 0.60) | 22" → Ø 0.56, depth 0.45, axis along z | front head with a port hole Ø 0.12; pedal at z 0.30 |
| Snare | (0.20, 0.62, 0.30) | Ø 0.36, depth 0.14 | stand tripod; tilted 8° toward drummer |
| Hi-hat | (0.45, 0.85, 0.35) | Ø 0.36 pair, 0.01 gap | stand + pedal |
| Rack tom 1 | (0.15, 0.80, 0.55) | Ø 0.25, depth 0.20 | mounted on kick, tilted 12° |
| Rack tom 2 | (−0.15, 0.82, 0.55) | Ø 0.30, depth 0.23 | mounted on kick, tilted 12° |
| Floor tom | (−0.50, 0.50, 0.30) | Ø 0.41, depth 0.40 | three legs |
| Crash | (0.45, 1.45, 0.65) | Ø 0.41 | boom stand, tilted 15° |
| Ride | (−0.60, 1.25, 0.60) | Ø 0.51 | boom stand, tilted 10° |
| Octopad | (−0.65, 0.95, 0.00) | body 0.38 × 0.28 × 0.07 | on its own stand, tilted 20° toward drummer |
| Sticks | resting on snare head | 0.40 long, r 0.007 | pair, crossed |

- Octopad detail: dark grey body `#2a2a2c`; **8 pads in a 2 × 4 grid**, each 0.07 × 0.07 × 0.006, rubber `#1a1a1a`; a small LCD (emissive teal `#3fd0c0` at low intensity) and 4 tiny knobs on the rear edge. No brand marks.
- Rug: 1.6 × 1.6 × 0.008 at local (0, 0, 0.4), muted pattern canvas texture.

### 5.5 Standing desk, laptop, journal
Desk local coordinates: origin at floor center under the desktop, local +z is the side where the user stands (world −z after `rotY = π`).

- **Frame:** two T-legs at local x ±0.60. Feet: boxes 0.70 (z) × 0.05 (tall) × 0.06, at y 0–0.05. Lower column 0.08 × 0.06, spanning y 0.05–0.65. Upper column 0.07 × 0.05, spanning y 0.40–1.025, so it overlaps the lower column by 0.25 m (it telescopes out of it, reading as an electric sit-stand desk). Crossbar 1.10 long between the columns at y 0.95. Matte black `#1f1f1f`.
- **Top:** 1.40 × 0.025 × 0.70, walnut `#6b4a33` canvas wood grain, spanning y 1.025–1.05 (top surface at y = 1.05).
- **Control keypad:** 0.10 × 0.02 × 0.04 under the front-right edge with an emissive red 7-segment-style readout `105` (canvas texture).
- **Laptop** (14"), centered at local (−0.05, 1.05, 0.05): base 0.31 × 0.016 × 0.22 aluminium `#b9bcc0`; keyboard area slightly darker inset; trackpad inset. Lid 0.31 × 0.21 × 0.006, hinged at the back edge, **open 110°** from the base. Screen: plane inset 0.01, `MeshBasicMaterial` + canvas texture (1024 × 680) showing a dark code editor: gutter line numbers, ~25 lines of syntax-colored rectangles of varying length. `toneMapped: false`.
- **Journal** at local (0.42, 1.05, 0.08), rotated 12° about y: **open** A5 notebook. Two page blocks each 0.148 × 0.010 × 0.21, slight V (each page block rotated 3° about its spine edge), cover 0.002 thick extending 0.004 past the pages, cover color `#2f3b30` (dark green cloth). Pages: canvas texture with faint ruled lines (6 mm spacing) and a few lines of scribbled "handwriting" (random short dark-blue strokes). Ribbon bookmark (thin red strip) draping off the bottom edge.
- **Pen** across the right page: cylinder 0.14 long, r 0.0045, black with a metal clip.
- **Mug** (optional polish) at local (−0.50, 1.05, −0.15).

### 5.6 Library (E wall)
- Carcass: 5 bays × 0.60 m wide = 3.00 m long, depth 0.35, height 2.50; side panels and top 0.02 thick; 6 shelves per bay (including the base shelf at y 0.08), spacing ≈ 0.39 m; a back panel. Oak `#b88a5a`.
- **Books:** generated with the seeded PRNG, filled left to right on each shelf.
  - Width (thickness) 0.02–0.06 m; height 0.18–0.33 m (must fit under the next shelf with ≥ 0.03 m clearance); depth 0.13–0.24 m, flush to the shelf front − 0.02.
  - Fill 85–95 % of each shelf's length. Every ~12th book leans at 8–15° against its neighbour, filling the leftover gap. One shelf in bay 3 holds a horizontal stack of 4 books instead.
  - **One `InstancedMesh` for all books** (≈ 400). Per-instance color from a muted palette: `#7a2e22, #2f4858, #8c7a5b, #3d5a40, #c4b59a, #5a3e5d, #1f2a36, #a8642a`. Optional: second `InstancedMesh` for thin lighter spine bands (two per book).
- A small potted plant on top of bay 2 and a few objects (a bookend, a small box) in bay 5 for variety.

---

## 6. Punching bag (the interactive object)

### 6.1 Geometry
- From the ceiling anchor (−2.0, 2.8, 1.6): ceiling hook plate, a swivel (small cylinder) and a **0.45 m chain** (instanced small tori, alternating 90° orientation), then **4 straps/chains** (0.15 m) fanning out to the top cap of the bag.
- Bag: cylinder **height 1.20 m, diameter 0.35 m**, top at y 2.20, bottom at y 1.00; rounded edges (cylinder with small bevel or `LatheGeometry`). Leather `#5a1d12` (oxblood, close to the site accent), visible seam lines via canvas texture, a top cap ring in black.
- Everything below the swivel sits in a `pivot` group positioned at the anchor. The bag mesh (only) is in the raycast `colliders` list.

### 6.2 Model: damped spherical pendulum (no physics engine)
State: tilt vector `θ = (θx, θz)` in radians (direction = where the bag bottom is displaced on the xz plane; magnitude = swing angle) and angular velocity `ω = (ωx, ωz)`.

```
L      = 1.20        // anchor → bag center of mass (0.6 chain/straps + 0.6 half bag)
g      = 9.81
ω0²    = g / L       // ≈ 8.18  → natural period ≈ 2.2 s
c      = 1.8         // damping, s⁻¹
θ_max  = 0.35        // 20°, hard clamp

α = −ω0² · θ − c · ω          // small-angle linearised, per component
ω += α · dt ;  θ += ω · dt    // semi-implicit Euler
if |θ| > θ_max: θ = θ̂ · θ_max; remove the outward radial component of ω
```

Apply each frame: `pivot.quaternion.setFromAxisAngle(normalize(−θz, 0, θx), |θ|)` (identity when |θ| < 1e-6). This rotates "down" toward the displacement direction.

### 6.3 Time step
Fixed `dt = 1/120 s` with an accumulator; cap the accumulated time at 0.1 s per frame (avoids explosions after a tab switch).

### 6.4 Hitting it
- **Input:** a tap/click gesture (see the drag rule below) → `Raycaster` from the camera through the pointer → first intersection with the bag collider. Also **key `F`**: punch along the camera's forward direction if the bag is within 3.5 m of the camera and in view.
- Orbit drags must never count as hits. Do **not** use the `click` event (browsers fire it after a drag too). Record `pointerdown` (position + `pointerId`); on `pointerup` with the same `pointerId`, raycast and register a hit only if the pointer moved < 6 px in total.
- **Impulse:** `d̂` = horizontal component of the ray direction, normalised. `h` = distance from the anchor down to the hit point (clamped 0.6–1.8). `Δω = HIT · (h / 1.2) · d̂`, `HIT = 0.40 rad/s`. A single centre hit peaks at ≈ 8°. Rapid hits accumulate (up to the clamp).
- **Debounce:** ignore hits < 80 ms apart.
- **Twist (polish):** a separate damped spring on yaw `ψ` (ω0 = 1.5 rad/s, c = 1.2), impulse proportional to the horizontal offset of the hit point from the bag axis × 2.0, clamp ±25°.
- **Squash:** on hit, scale the bag mesh to (1.04, 0.97, 1.04) and ease back to 1 over 120 ms.
- **Sound** (`lib/audio.js`): create/resume the `AudioContext` on first user gesture. Thump = 0.12 s white-noise burst → lowpass 180 Hz, plus a sine starting at 70 Hz dropping to 45 Hz over 0.15 s with exponential gain decay. Then 2–3 quiet chain clinks (highpassed noise blips at 3–5 kHz, 30–90 ms after the hit). Gain ∝ impulse magnitude, master gain 0.5. Respect a mute toggle (key `M`, HUD icon).
- Cursor: `pointer` when hovering the bag (throttled raycast on `pointermove`, ≤ 20 Hz).

### 6.5 Clearance (must hold)
At θ_max = 20°, the bag bottom (1.8 m below the anchor) moves `1.8 · sin 20° ≈ 0.62 m` horizontally; plus the bag radius gives **0.80 m**. Nothing above y = 0.95 may be within 0.80 m (horizontal) of the anchor (−2.0, 1.6): the S wall is 0.90 m away, the W wall 1.00 m, the nearest ring edge 1.03 m, the door's west edge 1.27 m. Keep it that way if you move anything.

### 6.6 Settle
After the last hit the bag must return to |θ| < 0.5° within **5 s** (with c = 1.8, amplitude decays as e^(−0.9 t), so a 20° swing takes ≈ 4.1 s).

---

## 7. Camera and controls

- `PerspectiveCamera(fov 50, near 0.05, far 50)`. `OrbitControls` with damping (0.08).
- **Start view:** position (−5.5, 4.2, 5.0), target (0, 1.0, 0): a dollhouse view from the **south-west**, above the room. This hides the W and S walls and the ceiling. Don't use a south-east view: the 3 m library back would block the drums and desk.
- Limits: distance 0.8–10, polar angle 15°–95°. Each frame, clamp `controls.target` to the room box shrunk by 0.05 m (x ∈ [−2.95, 2.95], y ∈ [0.05, 2.75], z ∈ [−2.45, 2.45]). Every preset below satisfies these limits; keep it that way, or the camera snaps when a tween ends.
- **Cutaway:** each frame, hide a wall if the camera is **outside** its plane (`camera.x > 3` → hide E wall, `< -3` → W, `z > 2.5` → S, `z < -2.5` → N), and hide the ceiling if `camera.y > 2.8`. Wall-mounted objects (Swedish bar, library, projector, door, projection) stay visible. Hidden walls must not cast shadows or block raycasts.
- **Preset views** (keys `1`–`5`, plus HUD buttons), tweened over 0.8 s with ease-in-out on both position and target:
  1. Overview: the start view.
  2. Training: pos (0.3, 1.7, 1.2) → target (−2.2, 1.4, 0.3).
  3. Music: pos (0.3, 1.6, −0.2) → target (2.2, 0.9, −1.6).
  4. Desk: pos (1.2, 1.65, 1.1) → target (1.25, 1.08, 2.1).
  5. Library: pos (0.8, 1.5, 0.9) → target (2.8, 1.3, 0.9).
  `0`: Screen: pos (0, 1.6, 1.5) → target (0, 1.65, −2.45).
- Touch: one-finger orbit, pinch zoom (OrbitControls defaults); tap on the bag = hit.

### HUD (`index.html`)
Fixed top-left, monospace 12–13 px, site colors: `ubermayinch` link to `../`, title `room`, the view buttons 0–5, a mute toggle, and a one-line hint: `drag to look · click the bag · 1–5 views`. It must not cover the canvas center on a 360 px-wide phone: wrap or collapse to an icon.

---

## 8. Performance budget

- 60 fps on a 2020-era laptop integrated GPU at 1440 × 900; ≥ 30 fps on a mid-range phone.
- **Draw calls ≤ 200** and **triangles ≤ 400k**, as read from `renderer.info.render` after one full frame. These totals include the shadow pass. Budget roughly 150 calls / 300k triangles for the main pass. Use `InstancedMesh` for books, rungs, chain links, and plate stacks. Merge static same-material geometry (`BufferGeometryUtils.mergeGeometries`) where it helps.
- One shadow-casting light. Only large objects cast shadows (bag, desk, kit shells, library carcass, rings); small parts don't.
- Canvas textures ≤ 1024² except the projection (1280 × 720). Generate them once at startup; only the projection redraws.
- No per-frame allocations in the update loop (reuse vectors/quaternions).

---

## 9. Debug / test hooks

- `?debug=1` in the URL: draws footprint boxes from `layout.js`, the bag clearance circle (r 0.8 m at y 1.0), axes at the origin, and an FPS + draw-call readout (`renderer.info`).
- On startup in debug mode, run a **2D footprint check** over the `layout.js` entries (not mesh AABBs, and excluding the shell: floor, walls, ceiling). Treat footprints as rotated rectangles on the xz plane. Count a pair as overlapping only if it overlaps by > 0.01 m (touching a wall or a neighbour is fine). Allow-list: drum rug ⊃ kit pieces, mat ⊃ rings, desk ↔ projector (vertically separated). Also check that no object taller than 0.95 m lies within 0.80 m of the bag anchor. `console.warn` each violation.
- Expose `window.__room = { hitBag(dx, dz, strength = 1), bagState() → { angleDeg, ω }, objects: { [name]: Object3D }, view(n) }` for automated checks.

---

## 10. Acceptance checklist

- [ ] `node build.mjs && npm run serve` produces `dist/room/index.html`. The page loads at `http://localhost:8000/room/` with **no console errors or warnings** (except the intended debug warnings when `?debug=1` is set).
- [ ] It also works when served under a subpath (all URLs relative; no leading `/`).
- [ ] `room/SPEC.md` is **not** copied to `dist/`.
- [ ] All objects present: projector + projected image, rings (2, on straps), Swedish bar (14 rungs), kettlebells (3), dumbbells (2 pairs), plate stack, mat, punching bag on chain, drum kit (kick, snare, hi-hat, 2 rack toms, floor tom, crash, ride, throne), octopad (8 pads), standing desk, open laptop with a glowing screen, open journal with a pen, library (5 bays, ~400 books), door, ceiling light.
- [ ] Positions match §3.2 (±0.02 m); the `?debug=1` overlap check reports nothing.
- [ ] Clicking/tapping the bag swings it **away from the camera**, with sound and squash. Repeated hits build up the swing to at most 20°. It settles to < 0.5° within 5 s. `__room.hitBag(1, 0)` swings it toward +x.
- [ ] Orbit drags never register as hits.
- [ ] Walls between the camera and the room hide automatically. Preset views 0–5 tween smoothly.
- [ ] Draw calls ≤ 200 and triangles ≤ 400k, including the shadow pass (debug readout).
- [ ] Usable at 360 px wide: HUD doesn't block the scene, and tap-to-hit works.
- [ ] Loading the page twice gives an identical scene (seeded RNG).

---

## 11. v2 ideas (out of scope for v1; don't build unless asked)

- Projection shows the latest posts/videos from `../feed.json` (title cards cycling every ~8 s), or a YouTube thumbnail from the user's channel.
- Library books are clickable: spines labelled with archive titles from `feed.json`, click opens the post.
- Journal pages show the latest poem excerpt.
- Playable drums/octopad: click a pad → synthesized hit sound.
- First-person walk mode (PointerLockControls) with a punch key.
- Rings and bag share a physics-ish "hit" interaction for the rings too.
