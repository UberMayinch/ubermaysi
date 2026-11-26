// main.js — renderer, scene, lights, camera, loop, input, hotspots, side panel, debug hooks.
//
// The 2D UI (HUD, zone index, side panel) is wired first and imports nothing from three.js, so it keeps
// working when WebGL or the CDN is unavailable. three.js, lib/textures.js and objects/*.js are loaded
// with dynamic import(); a module that fails to load or throws in build() is logged and skipped.
//
// ---- contracts -------------------------------------------------------------------------------------
//
// objects/<name>.js   export function build(scene, layout, ctx) -> { root, update?, colliders?, hotspots? }
//   scene    THREE.Scene. The module adds `root` itself and sets root.name = "<name>".
//   layout   LAYOUT from layout.js (read LAYOUT.<name>; positions come from nowhere else).
//   ctx      { content, rng, textures, audio, renderer, debug, reducedMotion, openZone, player, time, vantage }
//              content        parsed content.json (lib/content.js shape; zones always exist, maybe empty)
//              rng            seeded stream ALREADY forked for this module (rng.fork("x") for sub-streams)
//              textures       lib/textures.js namespace
//              audio          lib/audio.js namespace (silent until the first user gesture)
//              renderer       THREE.WebGLRenderer
//              debug          true with ?debug=1
//              reducedMotion  true if the visitor prefers reduced motion (skip idle sway etc.)
//              openZone(id)   opens that zone's panel and tweens to its preset
//              player         live { x, z, y, eye, yaw, radius, outside } (read-only). y = ground level under the
//                             player (0 on the timber floor, −0.12 in the genkan and outside), eye = camera height,
//                             outside = z > ROOM.maxZ (the S wall). Updated every fixed step.
//              time           live lib/sky.js time object (read-only): { hour, day, night, golden, sunDir, moonDir,
//                             sunColor, skyTop, skyHorizon, skyGround, sunElevation, pinned, onChange(fn) -> off }.
//                             onChange(fn) fires whenever the hour changes (clock tick, setTime, T key, tweens).
//              vantage({ pos, target, label })  tweens the camera to a seated / standing viewpoint as an
//                             interaction level; X returns to where the player stood. Call it from a hotspot's
//                             onActivate and return true.
//   update(dt, t)   called once per FIXED simulation step: dt = 1/120 s, t = simulated seconds. A frame
//                   runs 0..12 steps, so keep it cheap and allocation-free; throttle redraws on `t`.
//   colliders       Object3D[] that block picking (a tap on them does nothing) unless a hotspot owns them.
//   dynamicColliders  [{ x, z, w, d, rotY, y0, y1, push?(dx, dz, dt) }] live objects (moved by their module).
//                   The player circle is resolved against them every step; when the player presses into one
//                   that has push(), it is called first with the penetration vector (the direction the player
//                   presses, length = depth) and the object moves itself within its own limits; any overlap
//                   left is then resolved against the player.
//   hotspots        [{ zone, label, objects, resolve?, onActivate? }]
//                     objects                Object3D[]; raycast recursively
//                     resolve(hit)           -> { label, url } | null   per-item target (hit.instanceId, hit.faceIndex…)
//                     onActivate(hit)        -> true if fully handled (e.g. a drum pad that just plays)
//                   hover: pointer cursor + tooltip (resolve(hit).label, else label).
//                   tap:   resolve(hit).url -> open in a new tab; else onActivate(hit) === true -> stop;
//                          else open the side panel for `zone` and tween to its camera preset.
//
// objects/shell.js additionally returns  walls: { N, S, E, W, ceiling }  (Object3D each, Mesh or Group).
//   main.js toggles `.visible` on them every frame for the cutaway, and sets castShadow on their meshes (the
//   sun must not reach the room through the roof). Parent to a wall whatever must vanish with it (its
//   skirting, posts); keep wall-MOUNTED objects (door, scroll, bars, shelves) out of it.
//   It may also return  door: { toggle(), open(), close(), isOpen(), openness }  (openness 0..1, live). The S
//   wall is solid for the player except the doorway while openness > 0.8; without `door` the doorway is open.
//   lib/sky.js (called from here) owns every scene-level light: hemisphere, sun / moon DirectionalLight, the
//   shadow-casting ceiling SpotLight, the fill PointLight, the doorway daylight spill, the sky dome, fog and
//   exposure. main.js owns scene.environment. shell.js only builds the lamp fixture. projector.js owns its
//   own SpotLight + beam. Other modules: emissives, or at most one small non-shadow PointLight following
//   ctx.time.night.
//
// objects/bag.js additionally returns the hit API (it owns physics, squash, debounce AND sound):
//   hit(dirX, dirZ, strength = 1, hitPointWorld?) -> boolean
//       (dirX, dirZ) horizontal push direction in world space, normalised inside. strength scales
//       HIT = 0.40 rad/s. hitPointWorld (THREE.Vector3, optional) gives the lever arm h and the twist;
//       without it assume a centre hit (h = 1.2). Returns false when debounced (< 80 ms). Calls
//       ctx.audio.bagHit(gain) itself.
//   state() -> { angleDeg, omega: [ωx, ωz], theta: [θx, θz], yawDeg }
//   colliders: [bagMesh]   main.js turns these into the tap-to-punch target; bag.js needs no hotspot.
//
// ---- modes -----------------------------------------------------------------------------------------
//
// "walk" (default with a keyboard / fine pointer): first-person, eye WALK.eye above the ground (timber floor
//   y 0; genkan and garden y WALK.world.low, eased across the step edge). W/S move forward / back, A/D strafe,
//   Left/Right arrows turn, Up/Down arrows look up / down (eased, WALK.pitchSpeed, same clamp as drag), drag
//   looks (no pointer lock), Shift runs. The world is the room plus the garden, joined through the doorway.
//   The player is a circle (WALK.radius) kept inside the walls / fence and out of every footprint() that
//   intersects WALK.solidY; the bag is pushed, not blocked; dynamic colliders may be pushed.
//   Each frame (≤ 20 Hz) a look-ray from the camera (WALK.reach) picks the targeted hotspot, falling back
//   to the nearest one within WALK.nearby inside a forward cone, confirmed by a ray to that hotspot's own geometry
//   (its box follows it when it moves). Every pointer / look ray passes through meshes
//   (and their descendants) with userData.noPick === true: glass, curtain cloth. Z / E / Enter interacts, X / Esc /
//   Backspace goes back one level. Interacting with a zone tweens the camera to its preset vantage; the
//   player's pose is kept and restored when the panel closes. All walls stay visible (no cutaway).
// "overview" (default on touch-only devices): the orbit dollhouse with cutaway, unchanged. V toggles.
// While a panel is open, Up/Down (W/S) move the row selection, Z / Enter opens it, X closes.
// T (any mode) steps the time of day forward one hour; `?t=HH` (float) pins the hour at load.
//
// window.__room (SPEC §9): { ready, hitBag(dx, dz, strength = 1), bagState() -> { angleDeg, ω, omega, … },
//   objects: { [name]: Object3D }, view(n), openZone(id), closePanel(), info(), checkLayout(), modules,
//   layout, scene, camera, controls, renderer,
//   mode(), setMode("walk" | "overview"), player() -> { x, z, y, eye, yaw, outside }, teleport(x, z, yaw),
//   interact(), back(), target() -> label | null,
//   setTime(hour | null) (null = local clock), time() -> { hour, day, night, golden }, door() -> openness,
//   vantage({ pos, target, label }) }

import { LAYOUT, CAMERA, WALK, TIME, PRESETS, START_PRESET, ZONES, ZONE_PRESET, footprints, footprintCorners, checkLayout } from "./layout.js";
import { createRng, SEED } from "./lib/rng.js";
import { loadContent, emptyContent } from "./lib/content.js";
import * as audio from "./lib/audio.js";

const MODULES = ["shell", "projector", "loft", "training", "bag", "drums", "booth", "desk", "library", "garden", "gallery"]; // fixed build order
const GARDEN_PRESET = PRESETS.findIndex((p) => p.name === "garden");
const FIXED_DT = 1 / 120;
const MAX_ACCUMULATED = 0.1;
const TAP_PX = 6;
const HOVER_MS = 50; // hover raycast at most 20 Hz
const REAL_HIT_FY = [0.5, 0.7, 0.35, 0.85]; // heights (fraction of the box) tried by realHit()

const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const phoneLayout = matchMedia("(max-width: 600px)");
const touchOnly = matchMedia("(hover: none) and (pointer: coarse)");

const HINT = {
  walk: "WASD move · arrows look · drag look · Z interact · X back · V overview · T time",
  overview: "drag to look · click the bag · 1–6 views · T time · V walk",
  touch: "drag to look · click the bag · 1–6 views",
};

// ====================================================================================================
// 2D UI: works without WebGL
// ====================================================================================================

const $ = (id) => document.getElementById(id);
const dom = {
  canvas: $("scene"), more: $("more"), menu: $("menu"), mute: $("mute"), tip: $("tip"),
  panel: $("panel"), kicker: $("panel-kicker"), title: $("panel-title"), blurb: $("panel-blurb"), links: $("panel-links"),
  items: $("panel-items"), note: $("panel-note"), body: document.querySelector(".panel-body"), close: $("panel-close"),
  loading: $("loading"), fallback: $("fallback"),
  mode: $("mode"), hint: $("hint"), reticle: $("reticle"), prompt: $("prompt"), promptLabel: $("prompt-label"),
  primary: $("panel-primary"), keys: $("panel-keys"), toast: $("toast"),
};
const viewButtons = Array.from(document.querySelectorAll("[data-view]"));
const zoneButtons = Array.from(document.querySelectorAll("[data-zone]"));
const placeButtons = Array.from(document.querySelectorAll("[data-place]"));

/** A small transient HUD line (time of day, "X back" at a vantage). */
let toastTimer = 0;
function toast(text, ms = 1400) {
  if (!dom.toast) return;
  dom.toast.textContent = text;
  dom.toast.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove("on"), ms);
}
const hhmm = (h) => {
  const m = Math.round(h * 60) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

let content = emptyContent();
let contentSettled = false;
let stage = null; // the 3D side, once it is up: { view, punch, panelChanged, focusZone, interact, setMode, mode }
// rows: the panel's selectable anchors in order (primary link, other links, items); sel indexes them
const panel = { zone: null, opener: null, rows: [], sel: 0 };
const ui = { mode: touchOnly.matches ? "overview" : "walk", live: false };

const isExternal = (url) => /^https?:\/\//i.test(url);
/** Only http(s) and relative ./ ../ links are ever put in the DOM or opened. */
const safeHref = (url) => (typeof url === "string" && (isExternal(url) || /^\.{1,2}\//.test(url)) ? url : null);

function anchor(label, url, className) {
  const href = safeHref(url);
  if (!href) return null;
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  if (className) a.className = className;
  if (isExternal(href)) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  return a;
}

function itemNode(it) {
  const title = anchor(it.title, it.url, "title");
  if (!title) return null;
  const li = document.createElement("li");
  const meta = document.createElement("div");
  meta.className = "meta";
  if (it.date) {
    const time = document.createElement("time");
    time.dateTime = it.date;
    time.textContent = it.date.slice(0, 10);
    meta.append(time);
  }
  if (it.sourceLabel) {
    const src = document.createElement("span");
    src.textContent = it.sourceLabel;
    meta.append(src);
  }
  li.append(meta, title);
  if (it.summary) {
    const p = document.createElement("p");
    p.textContent = it.summary;
    li.append(p);
  }
  return li;
}

/** "youtube.com/@ubermayinch" for the line under the primary link. */
function hostOf(url) {
  if (!isExternal(url)) return "on this site";
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** Fill the prominent "visit … →" link at the top of the panel. */
function setPrimary(link) {
  const a = dom.primary;
  const href = link && safeHref(link.url);
  if (!href) {
    a.hidden = true;
    a.removeAttribute("href");
    a.replaceChildren();
    return false;
  }
  a.href = href;
  if (isExternal(href)) {
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.removeAttribute("target");
    a.removeAttribute("rel");
  }
  const go = document.createElement("span");
  go.className = "go";
  const channel = /(^|\.)youtube\.com|youtu\.be/i.test(hostOf(href)) && !/channel/i.test(link.label);
  go.textContent = `visit ${link.label}${channel ? " channel" : ""} ${isExternal(href) ? "↗" : "→"}`;
  const host = document.createElement("span");
  host.className = "host";
  host.textContent = hostOf(href);
  a.replaceChildren(go, host);
  a.hidden = false;
  return true;
}

const rowBox = (a) => a.closest("li") || a;

/** Move the visible selection to row i (clamped). `focus` also moves keyboard focus there. */
function selectRow(i, focus = false, scroll = true) {
  const n = panel.rows.length;
  if (!n) return;
  i = Math.max(0, Math.min(n - 1, i));
  const prev = panel.rows[panel.sel];
  if (prev) rowBox(prev).classList.remove("sel");
  panel.sel = i;
  const a = panel.rows[i];
  const box = rowBox(a);
  box.classList.add("sel");
  if (scroll) box.scrollIntoView({ block: "nearest" });
  if (focus) a.focus({ preventScroll: true });
}

/** Open the selected row: a real anchor click (new tab for external links), inside the key handler. */
function activateRow() {
  const a = panel.rows[panel.sel];
  if (!a) return false;
  a.click();
  return true;
}

function renderPanel(zoneId) {
  const zone = content.zones[zoneId] || { title: zoneId, blurb: "", links: [], items: [] };
  const count = zone.items.length;
  dom.kicker.textContent = count ? `${zoneId} · ${count} ${count === 1 ? "item" : "items"}` : zoneId;
  dom.title.textContent = zone.title || zoneId;
  dom.blurb.textContent = zone.blurb;
  dom.blurb.hidden = !zone.blurb;

  const rows = [];
  const usable = zone.links.filter((l) => safeHref(l.url));
  if (setPrimary(usable[0])) rows.push(dom.primary);
  const links = [];
  for (const l of usable.slice(1)) {
    const a = anchor(l.label, l.url);
    if (!a) continue;
    const li = document.createElement("li");
    li.append(a);
    links.push(li);
    rows.push(a);
  }
  dom.links.replaceChildren(...links);
  dom.links.hidden = links.length === 0;
  const items = zone.items.map(itemNode).filter(Boolean);
  dom.items.replaceChildren(...items);
  for (const li of items) rows.push(li.querySelector("a.title"));
  rows.forEach((a, i) => (rowBox(a).dataset.row = String(i)));
  panel.rows = rows;
  panel.sel = 0;
  if (rows.length) rowBox(rows[0]).classList.add("sel");

  let note = "";
  if (!contentSettled) note = "Loading…";
  else if (!content.ok) note = "The list did not load. Everything is in the feed: ";
  else if (!count && !links.length) note = "Nothing here yet.";
  dom.note.textContent = note;
  if (contentSettled && !content.ok) dom.note.append(anchor("../feed/", "../feed/"));
  dom.note.hidden = !note;
  dom.body.scrollTop = 0;
}

function openPanel(zoneId, opener) {
  if (!ZONES.includes(zoneId)) return false;
  panel.zone = zoneId;
  if (opener) panel.opener = opener;
  renderPanel(zoneId);
  dom.panel.classList.add("open");
  dom.panel.removeAttribute("inert");
  dom.panel.setAttribute("aria-hidden", "false");
  for (const b of zoneButtons) b.setAttribute("aria-pressed", String(b.dataset.zone === zoneId));
  setMenu(false);
  if (opener) (panel.rows[0] || dom.close).focus({ preventScroll: true }); // keyboard users land on the first row
  if (stage) stage.panelChanged();
  return true;
}

function closePanel() {
  if (!panel.zone) return false;
  const hadFocus = dom.panel.contains(document.activeElement);
  panel.zone = null;
  dom.panel.classList.remove("open");
  dom.panel.setAttribute("inert", "");
  dom.panel.setAttribute("aria-hidden", "true");
  for (const b of zoneButtons) b.setAttribute("aria-pressed", "false");
  const opener = panel.opener;
  panel.opener = null;
  if (hadFocus && opener && document.contains(opener)) opener.focus({ preventScroll: true });
  if (stage) stage.panelChanged();
  return true;
}

/** Open a zone's panel and (when the 3D scene is up) tween to its camera preset. */
function openZone(zoneId, opener) {
  const already = panel.zone === zoneId && dom.panel.classList.contains("open");
  if (!openPanel(zoneId, opener)) return false;
  // already open (e.g. repeated drum hits): keep the player's current camera
  if (stage && !already) stage.focusZone(zoneId);
  return true;
}

/** X / Esc / Backspace: go back one level. Returns true if something closed. */
function back() {
  if (closePanel()) return true;
  if (dom.more.classList.contains("open")) {
    setMenu(false);
    return true;
  }
  return !!(stage && stage.leave()); // from a vantage back to where the player stood
}

function applyModeUI() {
  const walk = ui.mode === "walk";
  document.body.dataset.mode = ui.mode;
  dom.hint.textContent = walk ? HINT.walk : touchOnly.matches ? HINT.touch : HINT.overview;
  dom.mode.setAttribute("aria-label", walk ? "switch to overview (V)" : "switch to walk mode (V)");
  dom.mode.title = walk ? "overview (V)" : "walk (V)";
  dom.reticle.hidden = !(ui.live && walk);
  dom.prompt.hidden = !(ui.live && walk);
  dom.keys.hidden = touchOnly.matches;
}

function openUrl(url) {
  const href = safeHref(url);
  if (!href) return false;
  if (isExternal(href)) window.open(href, "_blank", "noopener");
  else location.href = href;
  return true;
}

function setMenu(open) {
  dom.more.classList.toggle("open", open);
  dom.menu.setAttribute("aria-expanded", String(open));
}

function syncMute(muted) {
  dom.mute.setAttribute("aria-pressed", String(muted));
  dom.mute.setAttribute("aria-label", muted ? "unmute sound" : "mute sound");
}

function markView(n) {
  for (const b of viewButtons) b.setAttribute("aria-pressed", String(Number(b.dataset.view) === n));
}

function showTip(text, x, y) {
  if (dom.tip.textContent !== text) dom.tip.textContent = text;
  const w = dom.tip.offsetWidth, h = dom.tip.offsetHeight;
  const tx = Math.max(6, Math.min(innerWidth - w - 6, x + 14));
  const ty = y + 20 + h > innerHeight ? y - h - 12 : y + 20;
  dom.tip.style.transform = `translate3d(${Math.round(tx)}px,${Math.round(ty)}px,0)`;
  dom.tip.classList.add("on");
}
const hideTip = () => dom.tip.classList.remove("on");

function showFallback() {
  dom.canvas.hidden = true;
  dom.fallback.hidden = false;
  dom.loading.classList.add("done");
}

dom.close.addEventListener("click", closePanel);
dom.menu.addEventListener("click", () => setMenu(!dom.more.classList.contains("open")));
dom.mute.addEventListener("click", () => {
  audio.unlock();
  audio.toggleMute();
});
audio.onMuteChange(syncMute);
syncMute(audio.isMuted());
for (const b of zoneButtons) b.addEventListener("click", () => (panel.zone === b.dataset.zone ? closePanel() : openZone(b.dataset.zone, b)));
for (const b of viewButtons) {
  b.addEventListener("click", () => {
    if (stage) stage.view(Number(b.dataset.view));
    setMenu(false);
  });
}
for (const b of placeButtons) {
  b.addEventListener("click", () => {
    if (stage) stage.place(b.dataset.place);
    setMenu(false);
  });
}

dom.mode.addEventListener("click", () => {
  if (stage) stage.setMode(ui.mode === "walk" ? "overview" : "walk");
});
// A mouse click leaves focus on the HUD button, and Enter would click it again instead of interacting:
// hand focus back to the scene after pointer clicks (keyboard activation has detail 0 and keeps it).
for (const b of [dom.mode, dom.mute, ...viewButtons, ...placeButtons]) {
  b.addEventListener("click", (e) => {
    if (e.detail > 0) dom.canvas.focus({ preventScroll: true });
  });
}

// panel rows: the whole item row is clickable; hovering or focusing a row selects it
dom.items.addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // the anchor handles itself
  const li = e.target.closest("li");
  const a = li && li.querySelector("a.title");
  if (a) a.click();
});
const rowIndex = (e) => {
  const box = e.target.closest && e.target.closest("[data-row]");
  return box && dom.panel.contains(box) ? Number(box.dataset.row) : -1;
};
dom.panel.addEventListener("pointerover", (e) => {
  const i = rowIndex(e);
  if (e.pointerType === "mouse" && i >= 0 && i !== panel.sel) selectRow(i, false, false);
});
dom.panel.addEventListener("focusin", (e) => {
  const i = rowIndex(e);
  if (i >= 0 && i !== panel.sel) selectRow(i, false, true);
});

// ---- keyboard: one handler for everything ----
// Movement keys are tracked by physical position (e.code); the 3D loop reads `held`.
const MOVE_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
const held = new Set();
const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (isTyping(t)) return;
  audio.unlock();
  const k = e.key, code = e.code;
  if (MOVE_CODES.has(code)) held.add(code);
  const onControl = t && (t.tagName === "A" || t.tagName === "BUTTON"); // Enter / Space click it natively
  const interactKey = k === "z" || k === "Z" || k === "e" || k === "E" || k === "Enter";
  const backKey = k === "x" || k === "X" || k === "Escape" || k === "Backspace";

  if (panel.zone) {
    // the open panel is a menu: Up/Down (W/S) select, Z/Enter open, X back
    if (code === "ArrowDown" || code === "KeyS" || code === "ArrowUp" || code === "KeyW") {
      e.preventDefault();
      selectRow(panel.sel + (code === "ArrowDown" || code === "KeyS" ? 1 : -1), dom.panel.contains(document.activeElement));
      return;
    }
    if (code === "ArrowLeft" || code === "ArrowRight") {
      e.preventDefault();
      return;
    }
    if (interactKey) {
      if (k === "Enter" && t && t.tagName === "A" && dom.panel.contains(t)) return; // native: opens the focused row
      e.preventDefault();
      if (!e.repeat) activateRow();
      return;
    }
    if (backKey) {
      e.preventDefault();
      if (!e.repeat) back();
      return;
    }
  } else {
    if (interactKey) {
      if (k === "Enter" && onControl) return;
      if (ui.mode !== "walk" || !stage) return;
      e.preventDefault();
      if (!e.repeat) stage.interact();
      return;
    }
    if (backKey) {
      if (k === "Backspace" || k === "x" || k === "X") e.preventDefault();
      if (!e.repeat) back();
      return;
    }
    if (code.startsWith("Arrow") && ui.mode === "walk") e.preventDefault();
  }

  if (e.repeat) return;
  if (k === "v" || k === "V") {
    if (stage) stage.setMode(ui.mode === "walk" ? "overview" : "walk");
  } else if (k >= "0" && k <= "9" && k.length === 1) {
    if (stage && PRESETS[Number(k)]) stage.view(Number(k));
  } else if (k === "m" || k === "M") {
    audio.toggleMute();
  } else if (k === "f" || k === "F") {
    if (stage) stage.punch();
  } else if (k === "t" || k === "T") {
    if (stage) toast(hhmm(stage.stepTime()));
  }
});
window.addEventListener("keyup", (e) => held.delete(e.code));
// a lost keyup (new tab, alt-tab) must not leave the player walking forever
window.addEventListener("blur", () => held.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) held.clear();
});
applyModeUI();

// ====================================================================================================
// boot
// ====================================================================================================

function hasWebGL2() {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

async function boot() {
  const contentPromise = loadContent().then((c) => {
    content = c;
    contentSettled = true;
    if (panel.zone) renderPanel(panel.zone);
    return c;
  });

  if (!hasWebGL2()) {
    showFallback();
    return;
  }

  let THREE, OrbitControls, textures, createSky;
  try {
    const [three, orbit, tex, sky] = await Promise.all([
      import("three"), import("three/addons/controls/OrbitControls.js"), import("./lib/textures.js"), import("./lib/sky.js"),
    ]);
    THREE = three;
    OrbitControls = orbit.OrbitControls;
    textures = tex;
    createSky = sky.createSky;
  } catch (err) {
    console.error("[room] could not load three.js", err);
    showFallback();
    return;
  }

  const loaded = await Promise.all(
    MODULES.map((name) =>
      import(`./objects/${name}.js`).then(
        (m) => ({ name, build: m.build }),
        (err) => {
          console.error(`[room] objects/${name}.js failed to load`, err);
          return { name, build: null };
        },
      ),
    ),
  );
  await contentPromise;

  try {
    stage = start(THREE, OrbitControls, textures, createSky, loaded);
  } catch (err) {
    console.error("[room] could not start the 3D scene", err);
    showFallback();
  }
}

// ====================================================================================================
// 3D stage
// ====================================================================================================

function start(THREE, OrbitControls, textures, createSky, loaded) {
  // ---- renderer (SPEC §4.3) ----
  const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.84; // lib/sky.js drives it from here on
  renderer.shadowMap.enabled = true;
  // The spec asks for PCFSoftShadowMap; r186 removed it (it warns and falls back). PCFShadowMap is the
  // soft, filtered type now; softness comes from light.shadow.radius.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  textures.setDefaults({ anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });

  const scene = new THREE.Scene(); // background: lib/sky.js's dome

  // ---- environment: a tiny warm box, prefiltered once, so metal and polished wood have something to reflect ----
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = new THREE.Scene();
    const rig = new THREE.Group();
    rig.position.y = -1.3; // the probe sits at the origin = 1.3 m above the floor
    env.add(rig);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mats = [];
    const slab = (color, gain, sx, sy, sz, x, y, z, side) => {
      const m = new THREE.MeshBasicMaterial({ color, side: side || THREE.FrontSide });
      m.color.multiplyScalar(gain);
      mats.push(m);
      const mesh = new THREE.Mesh(box, m);
      mesh.scale.set(sx, sy, sz);
      mesh.position.set(x, y, z);
      rig.add(mesh);
    };
    const R = LAYOUT.room, cx = (R.minX + R.maxX) / 2, cz = (R.minZ + R.maxZ) / 2;
    slab(0x4a3b2e, 0.55, R.width, R.height, R.depth, cx, R.height / 2, cz, THREE.BackSide); // dim walls
    slab(0xb89a72, 1.5, R.width - 0.1, 0.02, R.depth - 0.1, cx, 0.03, cz); // the lit floor: warm bounce onto the ceiling and undersides
    slab(0xffe2bf, 16, 0.9, 0.02, 0.9, cx, R.height - 0.04, cz); // ceiling lamp
    const img = LAYOUT.projector && LAYOUT.projector.screen; // projected image (dimmed: half its size)
    if (img && img.pos) slab(0xc8d4ff, 1.4, img.width / 2, img.height / 2, 0.02, img.pos[0], img.pos[1], img.pos[2] + 0.03);
    scene.environment = pmrem.fromScene(env, 0.035, 0.1, 20).texture;
    scene.environmentIntensity = 0.32;
    box.dispose();
    for (const m of mats) m.dispose();
    pmrem.dispose();
  }

  // ---- lighting, sky, fog, exposure: lib/sky.js (time of day) ----
  const sky = createSky(THREE, scene, renderer, LAYOUT, createRng(SEED).fork("sky"), TIME);
  const W = WALK.world;

  // ---- camera + controls (SPEC §7) ----
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
  camera.rotation.order = "YXZ"; // walk mode: yaw about +Y, then pitch
  let mode = ui.mode;
  let fovTarget = CAMERA.fov;
  const controls = new OrbitControls(camera, dom.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = CAMERA.damping;
  controls.minDistance = CAMERA.minDistance;
  controls.maxDistance = CAMERA.maxDistance;
  controls.minPolarAngle = CAMERA.minPolar;
  controls.maxPolarAngle = CAMERA.maxPolar;
  controls.rotateSpeed = 0.75;
  const targetMin = new THREE.Vector3().fromArray(CAMERA.targetMin);
  const targetMax = new THREE.Vector3().fromArray(CAMERA.targetMax);

  const size = { w: 1, h: 1 };
  const overview = PRESETS[START_PRESET];
  const overviewOffset = new THREE.Vector3().fromArray(overview.pos).sub(new THREE.Vector3().fromArray(overview.target));
  const overviewDistance = overviewOffset.length();
  let overviewScale = 1;

  // Keep the overview's direction, but pull it (only) back along its own axis until the house box and the
  // garden box are inside the frame; on portrait screens also widen the lens a little. maxDistance grows to match.
  const fitProbe = new THREE.PerspectiveCamera();
  const fitCorner = new THREE.Vector3();
  const fitTarget = new THREE.Vector3().fromArray(overview.target);
  const fitBoxes = [
    [LAYOUT.room.minX, 0, LAYOUT.room.minZ, LAYOUT.room.maxX, LAYOUT.room.height, LAYOUT.room.maxZ],
    [W.garden.minX, W.low, W.garden.minZ, W.garden.maxX, W.fenceHeight, W.garden.maxZ],
  ];
  function roomFits(scale) {
    fitProbe.position.copy(fitTarget).addScaledVector(overviewOffset, scale);
    fitProbe.lookAt(fitTarget);
    fitProbe.updateMatrixWorld();
    for (const b of fitBoxes) {
      for (let i = 0; i < 8; i++) {
        fitCorner.set(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]).project(fitProbe);
        if (Math.abs(fitCorner.x) > 0.95 || fitCorner.y > 0.9 || fitCorner.y < -0.95) return false;
      }
    }
    return true;
  }
  const overviewFov = (aspect) => (aspect < 0.8 ? 60 : CAMERA.fov);
  function fitCamera() {
    const aspect = size.w / size.h;
    camera.aspect = aspect;
    fovTarget = mode === "walk" ? WALK.fov : overviewFov(aspect); // eased toward in frame()
    camera.updateProjectionMatrix();
    fitProbe.fov = overviewFov(aspect);
    fitProbe.aspect = aspect;
    fitProbe.near = camera.near;
    fitProbe.far = camera.far;
    fitProbe.updateProjectionMatrix();
    let lo = 0.6, hi = (CAMERA.maxDistance * 1.6) / overviewDistance;
    if (roomFits(lo)) hi = lo;
    else for (let i = 0; i < 14 && roomFits(hi); i++) {
      const mid = (lo + hi) / 2;
      if (roomFits(mid)) hi = mid;
      else lo = mid;
    }
    overviewScale = hi;
    controls.maxDistance = Math.max(CAMERA.maxDistance, overviewDistance * overviewScale + 0.25);
  }

  const tween = { active: false, t: 0, p0: new THREE.Vector3(), p1: new THREE.Vector3(), t0: new THREE.Vector3(), t1: new THREE.Vector3() };
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  function presetPosition(p, out) {
    out.fromArray(p.pos);
    if (p.id === START_PRESET) out.fromArray(p.target).addScaledVector(overviewOffset, overviewScale);
    return out;
  }

  // ---- walk mode state (all preallocated; the loop never allocates) ----
  const walk = {
    x: WALK.spawnTo[0], z: WALK.spawnTo[1], yaw: WALK.spawnYaw, pitch: 0,
    ground: 0, // eased ground level under the player (see groundAt)
    vx: 0, vz: 0, turn: 0, pitchVel: 0,
    bobPhase: 0, bobAmt: 0,
    state: "free", // "free": camera = player; "inspect": camera at a zone vantage (player pose kept)
    lookYaw: 0, lookPitch: 0, // camera look while inspecting (drag still looks around)
    intro: { active: false, t: 0 },
    markedView: false,
  };
  const player = { x: walk.x, z: walk.z, y: 0, eye: WALK.eye, yaw: walk.yaw, radius: WALK.radius, outside: false }; // ctx.player
  // look tween: position lerp + quaternion slerp (+ fov via fovTarget). cut: the overview -> walk return,
  // the only walk tween that keeps the dollhouse cutaway on.
  const wt = { active: false, cut: false, t: 0, dur: 1, p0: new THREE.Vector3(), p1: new THREE.Vector3(), q0: new THREE.Quaternion(), q1: new THREE.Quaternion() };

  /**
   * Ground level at (x, z): 0 on the timber floor, W.low in the genkan and outside, eased across the step
   * edge over W.stepEase m (smoothstep on the signed distance to the low region).
   */
  const G = W.genkan;
  function groundAt(x, z) {
    // low region = genkan rect extended south ∪ everything south of the S wall plane
    const dx = Math.max(G.minX - x, x - G.maxX, 0), dz = Math.max(G.minZ - z, 0);
    const sdRect = dx > 0 || dz > 0 ? Math.hypot(dx, dz) : -Math.min(x - G.minX, G.maxX - x, z - G.minZ);
    const sd = Math.min(sdRect, LAYOUT.room.maxZ - z);
    const h = W.stepEase / 2;
    const k = sd <= -h ? 1 : sd >= h ? 0 : 0.5 - (0.5 * sd) / h;
    return W.low * k * k * (3 - 2 * k);
  }
  const eyeAt = (x, z) => groundAt(x, z) + WALK.eye;
  const euler = new THREE.Euler(0, 0, 0, "YXZ");
  const aimOut = { yaw: 0, pitch: 0 };
  const wrapAngle = (a) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

  /** yaw / pitch that look from p toward t (yaw 0 = north, −z; +yaw turns left). */
  function aimAt(px, py, pz, tx, ty, tz) {
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    aimOut.yaw = Math.atan2(-dx, -dz);
    aimOut.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return aimOut;
  }

  function startLook(x, y, z, yaw, pitch, seconds) {
    wt.cut = false;
    wt.p1.set(x, y, z);
    euler.set(pitch, yaw, 0, "YXZ");
    wt.q1.setFromEuler(euler);
    if (!(seconds > 0) || reducedMotion.matches) {
      wt.active = false;
      camera.position.copy(wt.p1);
      camera.quaternion.copy(wt.q1);
      return;
    }
    wt.p0.copy(camera.position);
    wt.q0.copy(camera.quaternion);
    wt.t = 0;
    wt.dur = seconds;
    wt.active = true;
  }

  const stopPlayer = () => {
    walk.vx = walk.vz = walk.turn = walk.pitchVel = 0;
    walk.intro.active = false;
  };

  /** Back from a zone vantage to where the player stood. */
  function returnToPlayer() {
    walk.state = "free";
    startLook(walk.x, eyeAt(walk.x, walk.z), walk.z, walk.yaw, walk.pitch, WALK.returnSeconds);
  }

  /** ctx.vantage: tween to a viewpoint as an interaction level; X (back) returns to the player. */
  function vantage(v) {
    if (!v || !Array.isArray(v.pos) || !Array.isArray(v.target)) return false;
    const [px, py, pz] = v.pos, [tx, ty, tz] = v.target;
    if (![px, py, pz, tx, ty, tz].every(Number.isFinite)) return false;
    if (panel.zone) closePanel();
    if (mode !== "walk") {
      tween.p0.copy(camera.position);
      tween.t0.copy(controls.target);
      tween.p1.set(px, py, pz);
      tween.t1.set(tx, ty, tz);
      tween.t = reducedMotion.matches ? 1 : 0;
      tween.active = true;
      markView(-1);
      return true;
    }
    stopPlayer();
    walk.state = "inspect";
    const a = aimAt(px, py, pz, tx, ty, tz);
    walk.lookYaw = a.yaw;
    walk.lookPitch = a.pitch;
    startLook(px, py, pz, a.yaw, a.pitch, WALK.tweenSeconds);
    toast(v.label ? `${v.label} · X back` : "X back", 2200);
    return true;
  }

  /** X with nothing else open: leave a vantage. */
  function leave() {
    if (mode !== "walk" || walk.state !== "inspect" || panel.zone) return false;
    returnToPlayer();
    return true;
  }

  /** Opening a zone: overview tweens to its preset; walk keeps the player's pose and visits the vantage. */
  function focusZone(zoneId) {
    const n = ZONE_PRESET[zoneId];
    if (mode !== "walk") return view(n);
    const p = PRESETS[n];
    if (!p) return false;
    stopPlayer();
    walk.state = "inspect";
    const a = aimAt(p.pos[0], p.pos[1], p.pos[2], p.target[0], p.target[1], p.target[2]);
    walk.lookYaw = a.yaw;
    walk.lookPitch = a.pitch;
    startLook(p.pos[0], p.pos[1], p.pos[2], a.yaw, a.pitch, WALK.tweenSeconds);
    return true;
  }

  // ---- collision: static solids from footprints(), precomputed once ----
  // The world is one box (house + garden: N wall, garden fence on W / E / S) minus solid wall boxes: the S
  // wall either side of the doorway, the door leaf while it is closed, and the blocks beside the house.
  const solids = [];
  const box = (id, x0, z0, x1, z1, extra) => {
    const m = WALK.wallInset;
    solids.push({ id, x: (x0 + x1) / 2, z: (z0 + z1) / 2, c: 1, s: 0, hw: (x1 - x0) / 2 + m, hd: (z1 - z0) / 2 + m, round: false, ...extra });
  };
  {
    const { minX, maxX, minZ, maxZ } = LAYOUT.room;
    const outZ = maxZ + W.wallT;
    box("wall.S.west", minX - 3, maxZ, W.doorway.minX, outZ);
    box("wall.S.east", W.doorway.maxX, maxZ, maxX + 3, outZ);
    box("wall.W.block", minX - 3, minZ - 1, minX, outZ);
    box("wall.E.block", maxX, minZ - 1, maxX + 3, outZ);
    box("door.leaf", W.doorway.minX, maxZ, W.doorway.maxX, outZ, { door: true });
  }
  try {
    for (const f of footprints()) {
      if (f.id === "bag") continue; // pushed, not blocking (see stepPlayer)
      if (W.passIds.includes(f.id)) continue; // the door: handled by door.leaf above
      if (!(f.y1 > WALK.solidY[0] && f.y0 < WALK.solidY[1])) continue; // floor-flat or overhead
      solids.push({ id: f.id, x: f.x, z: f.z, c: Math.cos(f.rotY), s: Math.sin(f.rotY), hw: f.w / 2, hd: f.d / 2, round: !!f.round });
    }
  } catch (err) {
    console.error("[room] footprints() failed; walking with walls only", err);
  }
  const bounds = {
    minX: W.garden.minX + WALK.radius + WALK.wallInset, maxX: W.garden.maxX - WALK.radius - WALK.wallInset,
    minZ: LAYOUT.room.minZ + WALK.radius + WALK.wallInset, maxZ: W.garden.maxZ - WALK.radius - WALK.wallInset,
  };
  // modules' dynamic colliders ({ x, z, w, d, rotY, y0, y1, push? }), filled after build
  const dynamics = [];
  let doorApi = null; // shell's door, if it has one
  const doorOpenness = () => {
    if (!doorApi) return 1; // no door API: the doorway is always open
    const v = Number(doorApi.openness);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  };
  let doorPass = true; // this step: may the player pass the doorway?
  const hitOut = { nx: 0, nz: 0, pen: 0 };

  /** Circle (walk.x, walk.z, R) vs rotated rect: fills hitOut (normal from rect to circle, depth); false if apart. */
  function circleRect(x, z, c, s, hw, hd, round, R) {
    const dx = walk.x - x, dz = walk.z - z;
    if (round) {
      const min = hw + R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) return false;
      const d = Math.sqrt(d2);
      if (d < 1e-6) {
        hitOut.nx = 1;
        hitOut.nz = 0;
      } else {
        hitOut.nx = dx / d;
        hitOut.nz = dz / d;
      }
      hitOut.pen = min - d;
      return true;
    }
    const lx = dx * c - dz * s, lz = dx * s + dz * c; // world -> footprint local
    const cx = Math.max(-hw, Math.min(hw, lx)), cz = Math.max(-hd, Math.min(hd, lz));
    const ex = lx - cx, ez = lz - cz;
    const d2 = ex * ex + ez * ez;
    if (d2 >= R * R) return false;
    let nx, nz, pen;
    if (d2 > 1e-12) {
      const d = Math.sqrt(d2);
      nx = ex / d;
      nz = ez / d;
      pen = R - d;
    } else {
      const px = hw - Math.abs(lx), pz = hd - Math.abs(lz); // centre inside: leave by the nearest side
      if (px < pz) {
        nx = lx < 0 ? -1 : 1;
        nz = 0;
        pen = px + R;
      } else {
        nx = 0;
        nz = lz < 0 ? -1 : 1;
        pen = pz + R;
      }
    }
    hitOut.nx = nx * c + nz * s; // footprint local -> world
    hitOut.nz = -nx * s + nz * c;
    hitOut.pen = pen;
    return true;
  }

  /** Is a dynamic collider in the walking band at its spot? */
  const dynSolid = (o) => o.y1 > WALK.solidY[0] + Math.min(0, groundAt(o.x, o.z)) && o.y0 < WALK.solidY[1];

  /** Pressing into a pushable dynamic collider: let it move itself first (once per step). */
  function pushDynamics(dt) {
    const R = WALK.radius;
    for (let i = 0; i < dynamics.length; i++) {
      const o = dynamics[i];
      if (typeof o.push !== "function" || !dynSolid(o)) continue;
      const r = o.rotY || 0;
      if (!circleRect(o.x, o.z, Math.cos(r), Math.sin(r), o.w / 2, o.d / 2, false, R)) continue;
      try {
        o.push(-hitOut.nx * hitOut.pen, -hitOut.nz * hitOut.pen, dt);
      } catch (err) {
        console.error("[room] dynamic collider push() failed; it is now fixed", err);
        o.push = null;
      }
    }
  }
  const bagNow = { x: LAYOUT.bag.anchor[0], z: LAYOUT.bag.anchor[2] }; // bag centre at eye height, this step
  let bagPivot = null;

  /** Push the player circle out of the walls, the solids and the bag core. Slides: only the normal is removed. */
  function collide() {
    const R = WALK.radius;
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (let i = 0; i < solids.length; i++) {
        const s = solids[i];
        if (s.door && doorPass) continue;
        if (!circleRect(s.x, s.z, s.c, s.s, s.hw, s.hd, s.round, R)) continue;
        walk.x += hitOut.nx * hitOut.pen;
        walk.z += hitOut.nz * hitOut.pen;
        moved = true;
      }
      for (let i = 0; i < dynamics.length; i++) {
        const o = dynamics[i];
        if (!dynSolid(o)) continue;
        const r = o.rotY || 0;
        if (!circleRect(o.x, o.z, Math.cos(r), Math.sin(r), o.w / 2, o.d / 2, false, R)) continue;
        walk.x += hitOut.nx * hitOut.pen;
        walk.z += hitOut.nz * hitOut.pen;
        moved = true;
      }
      // the bag only blocks at its core, so the eye never ends up inside it
      const bx = walk.x - bagNow.x, bz = walk.z - bagNow.z;
      const bd2 = bx * bx + bz * bz;
      if (bag && bd2 < WALK.bagBlock * WALK.bagBlock) {
        const d = Math.sqrt(bd2) || 1e-6;
        walk.x = bagNow.x + (bx / d) * WALK.bagBlock;
        walk.z = bagNow.z + (bz / d) * WALK.bagBlock;
        moved = true;
      }
      const cx = Math.max(bounds.minX, Math.min(bounds.maxX, walk.x));
      const cz = Math.max(bounds.minZ, Math.min(bounds.maxZ, walk.z));
      if (cx !== walk.x || cz !== walk.z) {
        walk.x = cx;
        walk.z = cz;
        moved = true;
      }
      if (!moved) break;
    }
  }

  let lastBagPush = -Infinity;
  const pushPoint = new THREE.Vector3();
  const bagOffset = new THREE.Vector3();
  const isDown = (a, b) => held.has(a) || held.has(b);

  /** One fixed step of the player: input -> eased velocity -> move -> collide -> bag push -> head bob. */
  function stepPlayer(dt, t) {
    doorPass = doorOpenness() > W.doorPass;
    if (mode !== "walk") return;
    if (bagPivot) {
      bagOffset.set(0, -LAYOUT.bag.L, 0).applyQuaternion(bagPivot.quaternion);
      bagNow.x = LAYOUT.bag.anchor[0] + bagOffset.x;
      bagNow.z = LAYOUT.bag.anchor[2] + bagOffset.z;
    }
    const free = walk.state === "free" && !wt.active && !panel.zone;
    let fwd = 0, side = 0, turn = 0, tilt = 0;
    if (free) {
      if (held.has("KeyW")) fwd += 1;
      if (held.has("KeyS")) fwd -= 1;
      if (held.has("KeyD")) side += 1;
      if (held.has("KeyA")) side -= 1;
      if (held.has("ArrowLeft")) turn += 1;
      if (held.has("ArrowRight")) turn -= 1;
    }
    // Up/Down look up / down: free walking, and at a vantage with no panel open (the panel uses them as a menu)
    if (!wt.active && !panel.zone) {
      if (held.has("ArrowUp")) tilt += 1;
      if (held.has("ArrowDown")) tilt -= 1;
    }
    walk.pitchVel += (tilt * WALK.pitchSpeed - walk.pitchVel) * (1 - Math.exp(-WALK.pitchAccel * dt));
    if (Math.abs(walk.pitchVel) < 1e-4 && !tilt) walk.pitchVel = 0;
    if (walk.pitchVel !== 0) {
      const lim = WALK.maxPitch;
      if (walk.state === "inspect") walk.lookPitch = Math.max(-lim, Math.min(lim, walk.lookPitch + walk.pitchVel * dt));
      else walk.pitch = Math.max(-lim, Math.min(lim, walk.pitch + walk.pitchVel * dt));
    }
    const x0 = walk.x, z0 = walk.z;

    if (walk.intro.active) {
      if (fwd || side || turn) walk.intro.active = false; // any input takes over where the step-in is
      else {
        const it = walk.intro;
        it.t = Math.min(1, it.t + dt / WALK.introSeconds);
        const k = 1 - Math.pow(1 - it.t, 3) * (1 - it.t * 0.4); // eased, still moving a little at the end
        walk.x = WALK.spawn[0] + (WALK.spawnTo[0] - WALK.spawn[0]) * Math.min(1, k);
        walk.z = WALK.spawn[1] + (WALK.spawnTo[1] - WALK.spawn[1]) * Math.min(1, k);
        if (it.t >= 1) it.active = false;
      }
    }

    if (!walk.intro.active) {
      walk.turn += (turn * WALK.turnSpeed - walk.turn) * (1 - Math.exp(-WALK.turnAccel * dt));
      if (Math.abs(walk.turn) < 1e-4 && !turn) walk.turn = 0;
      walk.yaw = wrapAngle(walk.yaw + walk.turn * dt);

      let tvx = 0, tvz = 0;
      const len = Math.hypot(fwd, side);
      if (len > 0) {
        const speed = (isDown("ShiftLeft", "ShiftRight") ? WALK.run : WALK.speed) / len;
        const sn = Math.sin(walk.yaw), cs = Math.cos(walk.yaw);
        // forward = (−sin yaw, −cos yaw), right = (cos yaw, −sin yaw)
        tvx = (-sn * fwd + cs * side) * speed;
        tvz = (-cs * fwd - sn * side) * speed;
      }
      const k = 1 - Math.exp(-(len > 0 ? WALK.accel : WALK.decel) * dt);
      walk.vx += (tvx - walk.vx) * k;
      walk.vz += (tvz - walk.vz) * k;
      if (!len && walk.vx * walk.vx + walk.vz * walk.vz < 1e-6) walk.vx = walk.vz = 0;
      walk.x += walk.vx * dt;
      walk.z += walk.vz * dt;
      if (dynamics.length && len > 0) pushDynamics(dt);
      collide();
      // keep only what actually happened: pushing into a wall leaves the tangential part (slide, no stick)
      walk.vx = (walk.x - x0) / dt;
      walk.vz = (walk.z - z0) / dt;
      if ((fwd || side || turn || tilt) && walk.markedView) {
        walk.markedView = false;
        markView(-1);
      }
    }

    // walking into the bag gives it a gentle push (rate-limited: every accepted hit also thumps)
    if (bag && free) {
      const dx = bagNow.x - walk.x, dz = bagNow.z - walk.z;
      const d = Math.hypot(dx, dz);
      if (d < WALK.bagPush && d > 1e-6 && t - lastBagPush > WALK.bagPushMs / 1000) {
        const toward = (walk.vx * dx + walk.vz * dz) / d; // m/s toward the bag (before the core block)
        const intent = fwd || side ? 1 : 0;
        if (intent && toward > -0.05) {
          const ux = dx / d, uz = dz / d;
          const strength = WALK.bagPushStrength * Math.max(0.5, Math.min(1.2, (Math.hypot(walk.vx, walk.vz) + 0.4) / WALK.speed));
          pushPoint.set(bagNow.x - ux * LAYOUT.bag.diameter * 0.5, walk.ground + WALK.eye - 0.25, bagNow.z - uz * LAYOUT.bag.diameter * 0.5);
          if (bag.hit(ux, uz, strength, pushPoint) !== false) lastBagPush = t;
        }
      }
    }

    // head bob: two dips per stride, scaled by how fast we actually move
    const moved = Math.hypot(walk.x - x0, walk.z - z0);
    const speedNow = moved / dt;
    walk.bobPhase = (walk.bobPhase + (moved / WALK.bob.stride) * Math.PI * 2) % (Math.PI * 2);
    walk.bobAmt += (Math.min(1, speedNow / WALK.speed) - walk.bobAmt) * (1 - Math.exp(-8 * dt));

    // the step: spatially eased in groundAt, plus a short lag so a fast crossing still reads as a step
    const g = groundAt(walk.x, walk.z);
    walk.ground += (g - walk.ground) * (1 - Math.exp(-W.stepRate * dt));
    if (Math.abs(g - walk.ground) < 1e-6) walk.ground = g; // no endless denormal tail
    syncPlayer();
  }

  /** ctx.player, mutated in place. */
  function syncPlayer() {
    player.x = walk.x;
    player.z = walk.z;
    player.y = walk.ground;
    player.eye = walk.ground + WALK.eye;
    player.yaw = walk.yaw;
    player.outside = walk.z > LAYOUT.room.maxZ;
  }

  /** Place the player (x, z, yaw) and collide once. */
  function placePlayer(x, z, yaw, pitch) {
    walk.x = x;
    walk.z = z;
    walk.yaw = wrapAngle(yaw);
    walk.pitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, pitch));
    stopPlayer();
    doorPass = doorOpenness() > W.doorPass;
    collide();
    walk.ground = groundAt(walk.x, walk.z);
    syncPlayer();
  }

  /** Tween to preset n (0–6). `instant` skips the tween; reduced motion always does. */
  function view(n, instant = false) {
    const p = PRESETS[n];
    if (!p) return false;
    if (mode === "walk") {
      // the overview is outside the room: switch modes. Other presets are vantage points to walk away from.
      if (p.id === START_PRESET) return setMode("overview", instant);
      if (panel.zone) closePanel();
      const outside = p.pos[2] > LAYOUT.room.maxZ;
      if (outside !== player.outside && doorApi && typeof doorApi.open === "function") doorApi.open(); // a way back
      const a = aimAt(p.pos[0], eyeAt(p.pos[0], p.pos[2]), p.pos[2], p.target[0], p.target[1], p.target[2]);
      placePlayer(p.pos[0], p.pos[2], a.yaw, a.pitch);
      walk.state = "free";
      markView(p.id);
      walk.markedView = true;
      startLook(walk.x, eyeAt(walk.x, walk.z), walk.z, walk.yaw, walk.pitch, instant ? 0 : WALK.tweenSeconds);
      return true;
    }
    presetPosition(p, tween.p1);
    tween.t1.fromArray(p.target);
    markView(p.id);
    if (instant || reducedMotion.matches) {
      tween.active = false;
      camera.position.copy(tween.p1);
      controls.target.copy(tween.t1);
      controls.update();
      return true;
    }
    tween.p0.copy(camera.position);
    tween.t0.copy(controls.target);
    tween.t = 0;
    tween.active = true;
    return true;
  }
  controls.addEventListener("start", () => {
    tween.active = false; // a drag always wins over a running tween
    markView(-1);
  });

  // The open panel covers part of the canvas: slide the projection so the scene stays centred in what is left.
  const shift = { x: 0, y: 0, tx: 0, ty: 0 };
  function applyShift() {
    if (shift.x === 0 && shift.y === 0) camera.clearViewOffset();
    else camera.setViewOffset(size.w, size.h, shift.x, shift.y, size.w, size.h);
  }
  function panelChanged() {
    const open = !!panel.zone;
    const sheet = phoneLayout.matches;
    shift.tx = open && !sheet ? Math.min(dom.panel.offsetWidth, size.w * 0.6) / 2 : 0;
    shift.ty = open && sheet ? Math.min(dom.panel.offsetHeight, size.h * 0.7) / 2 : 0;
  }

  function resize() {
    size.w = Math.max(1, window.innerWidth);
    size.h = Math.max(1, window.innerHeight);
    renderer.setSize(size.w, size.h, false);
    fitCamera();
    panelChanged();
    shift.x = shift.tx;
    shift.y = shift.ty;
    applyShift();
  }
  window.addEventListener("resize", resize);
  let bag = null; // objects/bag.js hit API, once built

  /** Switch between first-person walking and the orbit overview. */
  function setMode(next, instant = false) {
    if (next !== "walk" && next !== "overview") return false;
    if (next === mode) return true;
    const seconds = instant ? 0 : WALK.tweenSeconds;
    if (panel.zone) closePanel(); // in walk this starts the return; the mode tween below replaces it
    mode = ui.mode = next;
    applyModeUI();
    clearAim();
    hideTip();
    fitCamera();
    if (next === "overview") {
      wt.active = false;
      walk.state = "free";
      stopPlayer();
      controls.enabled = true;
      // start the orbit from what the player sees, so the first controls.update() doesn't snap
      camera.getWorldDirection(dir);
      controls.target.copy(camera.position).addScaledVector(dir, 2).clamp(targetMin, targetMax);
      view(START_PRESET, instant);
    } else {
      tween.active = false;
      controls.enabled = false;
      walk.state = "free";
      markView(-1);
      startLook(walk.x, eyeAt(walk.x, walk.z), walk.z, walk.yaw, walk.pitch, seconds);
      wt.cut = wt.active; // coming down from the dollhouse: keep the cutaway until we are back at eye level
    }
    return true;
  }

  resize();
  camera.fov = fovTarget;
  camera.updateProjectionMatrix();
  if (mode === "walk") {
    controls.enabled = false;
    markView(-1);
    if (reducedMotion.matches) placePlayer(WALK.spawnTo[0], WALK.spawnTo[1], WALK.spawnYaw, 0);
    else {
      placePlayer(WALK.spawn[0], WALK.spawn[1], WALK.spawnYaw, 0);
      walk.intro.active = true; // a short eased step up out of the genkan onto the timber floor
      walk.intro.t = 0;
    }
    startLook(walk.x, eyeAt(walk.x, walk.z), walk.z, walk.yaw, walk.pitch, 0);
  } else {
    view(START_PRESET, true);
    markView(START_PRESET);
  }

  // ---- build the objects ----
  const rootRng = createRng(SEED);
  const built = {};
  const updaters = [];
  const pickables = []; // everything the pointer ray is tested against
  const owners = new Map(); // Object3D -> hotspot, or null for plain colliders (they only block)
  const baseCtx = {
    content, textures, audio, renderer, debug: DEBUG, reducedMotion: reducedMotion.matches, openZone: (id) => openZone(id),
    player, time: sky.time, vantage: (v) => vantage(v),
  };

  const spots = []; // [{ hotspot, box, sig, rejected }] for the walk-mode proximity fallback
  const register = (objects, hotspot) => {
    if (hotspot && !spots.some((s) => s.hotspot === hotspot)) spots.push({ hotspot, box: new THREE.Box3(), sig: NaN, rejected: -1 });
    for (const o of objects || []) {
      if (!o || !o.isObject3D) continue;
      if (!owners.has(o)) pickables.push(o);
      if (hotspot || !owners.has(o)) owners.set(o, hotspot);
    }
  };

  for (const { name, build } of loaded) {
    if (typeof build !== "function") continue;
    try {
      const res = build(scene, LAYOUT, { ...baseCtx, rng: rootRng.fork(name) }) || {};
      built[name] = res;
      if (typeof res.update === "function") updaters.push({ name, update: res.update.bind(res) });
      if (name !== "bag") register(res.colliders, null);
      for (const h of res.hotspots || []) register(h.objects, h);
      for (const o of Array.isArray(res.dynamicColliders) ? res.dynamicColliders : []) {
        if (o && typeof o === "object" && [o.x, o.z, o.w, o.d].every(Number.isFinite)) dynamics.push(o);
      }
    } catch (err) {
      console.error(`[room] objects/${name}.js build() failed`, err);
    }
  }

  const walls = (built.shell && built.shell.walls) || {};
  // the sun / moon must not shine through the roof or the walls: they cast (both shadow maps see them)
  for (const k of ["N", "S", "E", "W", "ceiling"]) {
    if (walls[k] && walls[k].isObject3D) walls[k].traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
  }
  {
    // …nor through the closed shoji (lighting policy: the leaf casts for both maps)
    const leaf = built.shell && built.shell.root && built.shell.root.getObjectByName("door");
    if (leaf) leaf.traverse((o) => {
      if (o.isMesh && o.material && o.material.visible !== false) o.castShadow = true;
    });
    const d = built.shell && built.shell.door;
    doorApi = d && typeof d === "object" ? d : null;
    if (player.outside && doorApi && typeof doorApi.open === "function") doorApi.open(); // spawned outside: a way in
  }
  // shadow policy: see-through pass-through surfaces (glass: noPick + transparent / transmissive) never cast,
  // or the one ceiling spot would black out the booth behind its glass walls
  const seeThrough = (o) => {
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    return mats.some((m) => m && ((m.transparent && m.opacity < 0.6) || m.transmission > 0));
  };
  // The proximity fallback must not offer what the player cannot see: its confirming ray stops at the walls and
  // at opaque pass-through surfaces (curtain cloth: noPick so the look-ray passes, but it hides what is behind).
  // Also hotspot meshes that pick from one side only (a custom raycast, e.g. the projection on the curtain):
  // from their back they still hide what is behind them. Meshes only; tested with the plain Mesh raycast.
  const occluders = [];
  const opaque = (o) => o.material && o.material.visible !== false && !seeThrough(o);
  for (const k of ["N", "S", "E", "W"]) {
    if (walls[k] && walls[k].isObject3D) walls[k].traverse((o) => o.isMesh && opaque(o) && occluders.push(o));
  }
  scene.traverse((o) => {
    if (!o.isMesh || !(o.userData && o.userData.noPick === true)) return;
    if (seeThrough(o)) o.castShadow = false;
    else if (opaque(o)) occluders.push(o);
  });
  for (const { hotspots } of Object.values(built)) {
    for (const h of Array.isArray(hotspots) ? hotspots : []) {
      for (const root of h.objects || []) {
        if (root && root.isObject3D) root.traverse((o) => {
          if (o.isMesh && o.raycast !== THREE.Mesh.prototype.raycast && opaque(o) && !occluders.includes(o)) occluders.push(o);
        });
      }
    }
  }
  sky.refresh(); // modules subscribed to ctx.time.onChange during build: give them the current state once
  bag = built.bag && typeof built.bag.hit === "function" ? built.bag : null;
  if (bag) bagPivot = scene.getObjectByName("bagPivot") || null;

  // ---- picking ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hits = [];
  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  let bagSpot = null;
  if (bag) {
    register(bag.colliders, (bagSpot = {
      zone: null,
      label: "",
      objects: bag.colliders,
      onActivate(hit) {
        // push along the horizontal part of the pointer ray: the bag swings away from the camera
        dir.copy(raycaster.ray.direction).setY(0);
        if (dir.lengthSq() < 1e-8) camera.getWorldDirection(dir).setY(0);
        dir.normalize();
        bag.hit(dir.x, dir.z, 1, hit.point);
        return true;
      },
    }));
  }
  scene.updateMatrixWorld(true);
  /** Pose checksum of a hotspot's objects: its fallback box is rebuilt when they move (sled, booth door). */
  function spotSig(s) {
    let sum = 0;
    const objs = s.hotspot.objects || [];
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (!o || !o.isObject3D) continue;
      const e = o.matrixWorld.elements;
      sum += e[12] * 1.31 + e[13] * 2.17 + e[14] * 3.07 + e[0] * 0.71 + e[8] * 0.37 + (o.visible ? 0.5 : 0) + i * 0.013;
    }
    return sum;
  }
  function refreshSpotBoxes() {
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      const sig = spotSig(s);
      if (Math.abs(sig - s.sig) < 1e-6) continue;
      s.sig = sig;
      s.box.makeEmpty();
      const objs = s.hotspot.objects || [];
      for (let j = 0; j < objs.length; j++) if (objs[j] && objs[j].isObject3D) s.box.expandByObject(objs[j]);
    }
  }
  refreshSpotBoxes();

  const shown = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };
  /** Glass, curtain cloth: rays pass through a mesh flagged userData.noPick (or any of its ancestors). */
  const noPick = (o) => {
    for (let n = o; n; n = n.parent) if (n.userData && n.userData.noPick === true) return true;
    return false;
  };
  const ownerOf = (o) => {
    for (let n = o; n; n = n.parent) if (owners.has(n)) return owners.get(n);
    return undefined;
  };
  const picked = { hotspot: null, hit: null };

  /** Nearest visible pickable under a client-space point. Returns `picked` or null. */
  function pick(clientX, clientY) {
    ndc.set((clientX / size.w) * 2 - 1, -(clientY / size.h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    hits.length = 0;
    raycaster.intersectObjects(pickables, true, hits);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!shown(h.object) || noPick(h.object)) continue; // cut-away walls, glass and cloth never block
      const owner = ownerOf(h.object);
      if (owner === undefined) continue;
      if (owner === null) return null; // a plain collider is in the way
      picked.hotspot = owner;
      picked.hit = h;
      return picked;
    }
    return null;
  }

  const resolveOf = (hotspot, hit) => {
    if (typeof hotspot.resolve !== "function") return null;
    try {
      return hotspot.resolve(hit) || null;
    } catch (err) {
      console.error("[room] hotspot resolve() failed", err);
      return null;
    }
  };

  /** Tap or Z on a hotspot: a per-item url opens; else onActivate (true = handled); else the zone opens. */
  function activate(hotspot, hit, fromKey) {
    if (hotspot === bagSpot && fromKey) return punch();
    const target = resolveOf(hotspot, hit);
    if (target && target.url && openUrl(target.url)) return true;
    if (typeof hotspot.onActivate === "function") {
      let handled = false;
      try {
        handled = hotspot.onActivate(hit) === true;
      } catch (err) {
        console.error("[room] hotspot onActivate() failed", err);
      }
      if (handled) return true;
    }
    if (hotspot.zone) return openZone(hotspot.zone);
    return false;
  }

  function tap(clientX, clientY) {
    const p = pick(clientX, clientY);
    if (p) activate(p.hotspot, p.hit, false);
  }

  // ---- walk mode: what the player is looking at ----
  const aim = { hotspot: null, hit: null, label: "", clock: -Infinity, idle: false };
  const synth = { object: null, point: new THREE.Vector3(), distance: 0, instanceId: undefined, faceIndex: undefined }; // fallback "hit"
  const fwd = new THREE.Vector3();
  const coneCos = Math.cos(((WALK.coneDeg / 2) * Math.PI) / 180);

  function clearAim() {
    aim.hotspot = null;
    aim.hit = null;
    if (aim.label !== "") {
      aim.label = "";
      dom.prompt.classList.remove("on");
      dom.reticle.classList.remove("on");
    }
  }

  function labelOf(hotspot, hit) {
    if (hotspot === bagSpot) return "punch";
    const r = resolveOf(hotspot, hit);
    return (r && r.label) || hotspot.label || hotspot.zone || "";
  }

  /** Look-ray from the eye (WALK.reach), else the nearest hotspot within WALK.nearby in the forward cone. */
  function updateAim(now) {
    const idle = mode !== "walk" || walk.state !== "free" || wt.active || !!panel.zone;
    if (idle !== aim.idle) {
      aim.idle = idle;
      dom.reticle.classList.toggle("off", idle); // no dot while a tween or a panel has the camera
    }
    if (idle || walk.intro.active) {
      clearAim();
      return;
    }
    if (now - aim.clock < HOVER_MS) return;
    aim.clock = now;
    camera.getWorldDirection(fwd);
    raycaster.set(camera.position, fwd); // not setFromCamera: the panel shift moves the projection centre
    raycaster.far = WALK.reach;
    hits.length = 0;
    raycaster.intersectObjects(pickables, true, hits);
    raycaster.far = Infinity;
    let hotspot = null, hit = null;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!shown(h.object) || noPick(h.object)) continue;
      const owner = ownerOf(h.object);
      if (owner === undefined) continue;
      if (owner !== null) {
        hotspot = owner;
        hit = h;
      }
      break; // the first thing in the way decides
    }
    if (!hotspot) {
      const fl = Math.hypot(fwd.x, fwd.z) || 1;
      const fx = fwd.x / fl, fz = fwd.z / fl;
      refreshSpotBoxes();
      // nearest box in the forward cone, confirmed by a real ray to the hotspot's own geometry (a one-sided
      // screen seen from behind, or a box corner poking through a wall, is not offered); up to 3 candidates
      for (let pass = 0; pass < 3 && !hotspot; pass++) {
        let best = WALK.nearby, bestSpot = null;
        for (let i = 0; i < spots.length; i++) {
          const box = spots[i].box;
          if (box.isEmpty() || spots[i].rejected === now) continue;
          const cx = Math.max(box.min.x, Math.min(box.max.x, walk.x));
          const cz = Math.max(box.min.z, Math.min(box.max.z, walk.z));
          let dx = cx - walk.x, dz = cz - walk.z;
          const d = Math.hypot(dx, dz);
          if (d >= best) continue;
          if (d < 0.05) {
            dx = (box.min.x + box.max.x) / 2 - walk.x; // standing over its box: use the direction to its middle
            dz = (box.min.z + box.max.z) / 2 - walk.z;
          }
          const dl = Math.hypot(dx, dz) || 1;
          if ((dx * fx + dz * fz) / dl < coneCos) continue;
          best = d;
          bestSpot = spots[i];
        }
        if (!bestSpot) break;
        const real = realHit(bestSpot.hotspot, bestSpot);
        if (real) {
          hotspot = bestSpot.hotspot;
          hit = real;
        } else bestSpot.rejected = now;
      }
    }
    if (!hotspot) {
      clearAim();
      return;
    }
    aim.hotspot = hotspot;
    aim.hit = hit;
    const label = labelOf(hotspot, hit);
    if (label !== aim.label) {
      aim.label = label;
      dom.promptLabel.textContent = label;
      dom.prompt.classList.toggle("on", !!label);
      dom.reticle.classList.toggle("on", !!label);
    }
  }

  /** Z / E / Enter in walk mode with no panel open. */
  function interact() {
    if (panel.zone) return activateRow();
    if (mode !== "walk") return false;
    if (!aim.hotspot) {
      aim.clock = -Infinity; // nothing cached yet (e.g. right after a tween): look now
      updateAim(performance.now());
    }
    if (!aim.hotspot) return false;
    return activate(aim.hotspot, aim.hit === synth ? realHit(aim.hotspot) || synth : aim.hit, true);
  }

  /**
   * The proximity fallback only has a box point; onActivate (e.g. which drum to play) wants a real hit.
   * Cast from the eye toward a few points of the hotspot's box and keep the first hit it owns.
   */
  function realHit(hotspot, spot) {
    if (!spot) for (let i = 0; i < spots.length && !spot; i++) if (spots[i].hotspot === hotspot) spot = spots[i];
    if (!spot || spot.box.isEmpty()) return null;
    const { min, max } = spot.box;
    // aim at the box middle, then at the box point nearest the player (sparse objects: a kit, a rack)
    for (let k = 0; k < 2; k++) {
      const cx = k === 0 ? (min.x + max.x) / 2 : Math.max(min.x, Math.min(max.x, walk.x));
      const cz = k === 0 ? (min.z + max.z) / 2 : Math.max(min.z, Math.min(max.z, walk.z));
      for (let j = 0; j < REAL_HIT_FY.length; j++) {
        tmp.set(cx, min.y + (max.y - min.y) * REAL_HIT_FY[j], cz);
        dir.subVectors(tmp, camera.position);
        if (dir.lengthSq() < 1e-8) continue;
        dir.normalize();
        raycaster.set(camera.position, dir);
        raycaster.far = WALK.reach + 1.5;
        hits.length = 0;
        raycaster.intersectObjects(hotspot.objects || [], true, hits);
        raycaster.far = Infinity;
        let found = null;
        for (let i = 0; i < hits.length && !found; i++) {
          if (shown(hits[i].object) && !noPick(hits[i].object) && ownerOf(hits[i].object) === hotspot && hits[i].point.y > 0.05) found = hits[i]; // not a floor rug
        }
        if (found && !occluded(found.distance)) return found;
      }
    }
    return null;
  }

  /** Does a wall or an opaque pass-through surface (curtain cloth) cross the current raycaster ray before `dist`? */
  const occHits = [];
  const meshRaycast = THREE.Mesh.prototype.raycast;
  function occluded(dist) {
    if (!occluders.length) return false;
    raycaster.far = dist - 0.01;
    let hit = false;
    for (let i = 0; i < occluders.length && !hit; i++) {
      const o = occluders[i];
      if (!shown(o)) continue;
      occHits.length = 0;
      meshRaycast.call(o, raycaster, occHits); // the plain test: ignores one-sided pick overrides
      hit = occHits.length > 0;
    }
    raycaster.far = Infinity;
    return hit;
  }

  /** Key F: punch along the camera's forward direction if the bag is within 3.5 m and in view. */
  function punch() {
    if (!bag) return false;
    const a = LAYOUT.bag.anchor;
    tmp.set(a[0], a[1] - LAYOUT.bag.L, a[2]);
    if (tmp.distanceTo(camera.position) > 3.5) return false;
    tmp.project(camera);
    if (Math.abs(tmp.x) > 1 || Math.abs(tmp.y) > 1 || tmp.z < -1 || tmp.z > 1) return false;
    camera.getWorldDirection(dir).setY(0);
    if (dir.lengthSq() < 1e-8) return false;
    dir.normalize();
    return bag.hit(dir.x, dir.z, 1) !== false;
  }

  // ---- pointer: tap vs drag (never the `click` event, SPEC §6.4), throttled hover ----
  const press = { active: false, id: -1, x: 0, y: 0, moved: 0, cancelled: false };
  const hover = { x: 0, y: 0, dirty: false, last: 0, inside: false };

  dom.canvas.addEventListener("pointerdown", (e) => {
    audio.unlock();
    if (press.active) {
      press.cancelled = true; // second finger: this is a pinch, not a tap
      return;
    }
    press.active = true;
    press.id = e.pointerId;
    press.x = e.clientX;
    press.y = e.clientY;
    press.moved = 0;
    press.cancelled = e.pointerType === "mouse" && e.button !== 0;
    dom.canvas.classList.add("dragging");
    hideTip();
  });
  dom.canvas.addEventListener("pointermove", (e) => {
    if (press.active && e.pointerId === press.id) {
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      press.moved += Math.hypot(dx, dy);
      press.x = e.clientX;
      press.y = e.clientY;
      if (mode === "walk" && !wt.active && !press.cancelled) {
        // drag look, "grab the scene" like the orbit view: drag right turns left, drag down looks up
        const k = WALK.lookSpeed;
        if (walk.state === "inspect") {
          walk.lookYaw = wrapAngle(walk.lookYaw + dx * k);
          walk.lookPitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, walk.lookPitch + dy * k));
        } else {
          walk.yaw = wrapAngle(walk.yaw + dx * k);
          walk.pitch = Math.max(-WALK.maxPitch, Math.min(WALK.maxPitch, walk.pitch + dy * k));
        }
      }
    }
    if (e.pointerType === "touch") return;
    hover.x = e.clientX;
    hover.y = e.clientY;
    hover.inside = true;
    hover.dirty = true;
  });
  const release = (e, cancelled) => {
    if (!press.active || e.pointerId !== press.id) return;
    press.active = false;
    dom.canvas.classList.remove("dragging");
    if (!cancelled && !press.cancelled && press.moved < TAP_PX) tap(e.clientX, e.clientY);
    hover.dirty = hover.inside;
  };
  dom.canvas.addEventListener("pointerup", (e) => release(e, false));
  dom.canvas.addEventListener("pointercancel", (e) => release(e, true));
  dom.canvas.addEventListener("pointerleave", () => {
    hover.inside = false;
    hover.dirty = false;
    hideTip();
    dom.canvas.style.cursor = "";
  });

  function updateHover(now) {
    if (!hover.dirty || press.active || now - hover.last < HOVER_MS) return;
    hover.dirty = false;
    hover.last = now;
    const p = pick(hover.x, hover.y);
    if (!p) {
      dom.canvas.style.cursor = "";
      hideTip();
      return;
    }
    dom.canvas.style.cursor = "pointer";
    const target = resolveOf(p.hotspot, p.hit);
    const label = (target && target.label) || p.hotspot.label;
    if (label) showTip(label, hover.x, hover.y);
    else hideTip();
  }

  // ---- debug (SPEC §9) ----
  let readout = null;
  if (DEBUG) {
    const dbg = new THREE.Group();
    dbg.name = "debug";
    const pts = [];
    for (const f of footprints()) {
      const y = 0.012;
      if (f.round) {
        for (let i = 0; i < 32; i++) {
          const a0 = (i / 32) * Math.PI * 2, a1 = ((i + 1) / 32) * Math.PI * 2;
          pts.push(f.x + (Math.cos(a0) * f.w) / 2, y, f.z + (Math.sin(a0) * f.w) / 2, f.x + (Math.cos(a1) * f.w) / 2, y, f.z + (Math.sin(a1) * f.w) / 2);
        }
      } else {
        const c = footprintCorners(f);
        for (let i = 0; i < 4; i++) pts.push(c[i][0], y, c[i][1], c[(i + 1) % 4][0], y, c[(i + 1) % 4][1]);
      }
    }
    const { anchor: a, clearance: r, clearanceAboveY } = LAYOUT.bag;
    const ring = [];
    for (let i = 0; i < 64; i++) {
      const a0 = (i / 64) * Math.PI * 2, a1 = ((i + 1) / 64) * Math.PI * 2;
      ring.push(a[0] + Math.cos(a0) * r, 1.0, a[2] + Math.sin(a0) * r, a[0] + Math.cos(a1) * r, 1.0, a[2] + Math.sin(a1) * r);
    }
    const lines = (arr, color) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, toneMapped: false }));
      l.renderOrder = 10;
      return l;
    };
    dbg.add(lines(pts, 0x3fd0c0), lines(ring, 0xff5a3c), new THREE.AxesHelper(1));
    scene.add(dbg);

    const problems = checkLayout();
    for (const p of problems) console.warn(`[room] layout: ${p}`);
    if (!problems.length) console.info(`[room] layout check passed (${footprints().length} footprints, bag clearance ${r} m above y ${clearanceAboveY})`);

    readout = document.createElement("pre");
    readout.style.cssText = "position:fixed;z-index:7;left:.75rem;bottom:.75rem;margin:0;padding:.35rem .6rem;font:11px/1.45 ui-monospace,Menlo,monospace;color:#e9e6e0;background:rgba(20,19,18,.78);border-radius:6px;pointer-events:none";
    document.body.append(readout);
  }

  // ---- window.__room ----
  const objects = {};
  scene.traverse((o) => {
    if (o.name && !(o.name in objects)) objects[o.name] = o;
  });
  for (const name of Object.keys(built)) if (built[name].root) objects[name] = built[name].root;
  const lastInfo = { calls: 0, triangles: 0, fps: 0 };
  const room = {
    ready: false,
    hitBag: (dx, dz, strength = 1) => (bag ? bag.hit(dx, dz, strength) !== false : false),
    bagState: () => {
      const s = bag && typeof bag.state === "function" ? bag.state() : { angleDeg: 0, omega: [0, 0], theta: [0, 0], yawDeg: 0 };
      return { ...s, ω: s.omega };
    },
    objects,
    view,
    openZone: (id) => openZone(id),
    closePanel,
    info: () => ({ ...lastInfo, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    checkLayout,
    modules: built,
    layout: LAYOUT,
    scene, camera, controls, renderer,
    mode: () => mode,
    setMode: (m, instant = false) => setMode(m, instant),
    player: () => ({ x: walk.x, z: walk.z, y: walk.ground, eye: walk.ground + WALK.eye, yaw: walk.yaw, outside: player.outside }),
    teleport(x, z, yaw = walk.yaw) {
      if (panel.zone) closePanel();
      placePlayer(Number(x), Number(z), Number(yaw), 0);
      walk.state = "free";
      if (mode === "walk") startLook(walk.x, walk.ground + WALK.eye, walk.z, walk.yaw, walk.pitch, 0);
      return room.player();
    },
    interact,
    back,
    target: () => (mode === "walk" && aim.hotspot ? aim.label || null : null),
    setTime: (h) => sky.setHour(h === undefined ? null : h),
    time: () => ({ hour: sky.time.hour, day: sky.time.day, night: sky.time.night, golden: sky.time.golden, pinned: sky.time.pinned }),
    door: () => doorOpenness(),
    vantage: (v) => vantage(v),
    sky,
  };
  window.__room = room;

  // ---- loop: fixed-step simulation inside requestAnimationFrame (SPEC §6.3) ----
  let last = performance.now();
  let acc = 0;
  let simTime = 0;
  let frames = 0;
  let fpsClock = last;
  let outsideness = mode === "walk" ? 0 : 1;
  const smoothstep = (a, b, v) => {
    const k = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_ACCUMULATED);
    last = now;

    acc = Math.min(acc + dt, MAX_ACCUMULATED);
    while (acc >= FIXED_DT) {
      acc -= FIXED_DT;
      simTime += FIXED_DT;
      stepPlayer(FIXED_DT, simTime);
      for (let i = 0; i < updaters.length; i++) {
        try {
          updaters[i].update(FIXED_DT, simTime);
        } catch (err) {
          console.error(`[room] objects/${updaters[i].name}.js update() failed; disabling it`, err);
          updaters.splice(i--, 1);
        }
      }
    }

    if (mode === "walk") {
      if (wt.active) {
        wt.t = Math.min(1, wt.t + dt / wt.dur);
        const k = ease(wt.t);
        camera.position.lerpVectors(wt.p0, wt.p1, k);
        camera.quaternion.slerpQuaternions(wt.q0, wt.q1, k);
        if (wt.t >= 1) wt.active = false;
      } else if (walk.state === "inspect") {
        camera.position.copy(wt.p1);
        euler.set(walk.lookPitch, walk.lookYaw, 0, "YXZ");
        camera.quaternion.setFromEuler(euler);
      } else {
        const bob = reducedMotion.matches ? 0 : WALK.bob.amp * walk.bobAmt * 0.5 * (Math.cos(2 * walk.bobPhase) - 1);
        camera.position.set(walk.x, walk.ground + WALK.eye + bob, walk.z);
        euler.set(walk.pitch, walk.yaw, 0, "YXZ");
        camera.quaternion.setFromEuler(euler);
      }
    } else {
      if (tween.active) {
        tween.t = Math.min(1, tween.t + dt / CAMERA.tweenSeconds);
        const k = ease(tween.t);
        camera.position.lerpVectors(tween.p0, tween.p1, k);
        controls.target.lerpVectors(tween.t0, tween.t1, k);
        if (tween.t >= 1) tween.active = false;
      }
      controls.target.clamp(targetMin, targetMax);
      controls.update();
    }

    if (camera.fov !== fovTarget) {
      const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 6);
      camera.fov += (fovTarget - camera.fov) * k;
      if (Math.abs(fovTarget - camera.fov) < 0.05) camera.fov = fovTarget;
      camera.updateProjectionMatrix();
    }

    // cutaway: hide whatever stands between the camera and the room. Walking: everything stays up.
    const p = camera.position;
    const cut = mode !== "walk" || (wt.active && wt.cut);
    let wallSig = 0;
    if (walls.E) wallSig |= (walls.E.visible = !cut || p.x <= LAYOUT.room.maxX) ? 1 : 0;
    if (walls.W) wallSig |= (walls.W.visible = !cut || p.x >= LAYOUT.room.minX) ? 2 : 0;
    if (walls.S) wallSig |= (walls.S.visible = !cut || p.z <= LAYOUT.room.maxZ) ? 4 : 0;
    if (walls.N) wallSig |= (walls.N.visible = !cut || p.z >= LAYOUT.room.minZ) ? 8 : 0;
    if (walls.ceiling) wallSig |= (walls.ceiling.visible = !cut || p.y <= LAYOUT.room.height) ? 16 : 0;

    // time of day + where the camera is: 0 indoors … 1 outdoors (walk: eased across the doorway; overview: out)
    const oTarget = mode !== "walk" ? 1 : smoothstep(W.outsideBlend[0], W.outsideBlend[1], p.z);
    outsideness += (oTarget - outsideness) * (reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 4));
    if (Math.abs(oTarget - outsideness) < 1e-3) outsideness = oTarget;
    sky.update(dt, now, outsideness, doorOpenness());
    // one shadow map re-renders per frame: the sun / moon outside and in a daytime overview, else the lamp
    const sunActive = mode === "walk" ? p.z > LAYOUT.room.maxZ : sky.time.night < 0.5;
    let dynSum = 0;
    for (let i = 0; i < dynamics.length; i++) dynSum += dynamics[i].x * 1.37 + dynamics[i].z * 2.11 + (dynamics[i].rotY || 0) * 3.07;
    sky.shadowTick(sunActive ? "sun" : "spot", wallSig, dynSum);
    sky.dome.position.copy(p);
    if (scene.fog) {
      const away = mode === "walk" ? 0 : p.distanceTo(controls.target); // the dollhouse never hazes over
      scene.fog.near = sky.fogRange[0] + away;
      scene.fog.far = sky.fogRange[1] + away;
    }

    if (shift.x !== shift.tx || shift.y !== shift.ty) {
      const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 7);
      shift.x += (shift.tx - shift.x) * k;
      shift.y += (shift.ty - shift.y) * k;
      if (Math.abs(shift.tx - shift.x) < 0.5) shift.x = shift.tx;
      if (Math.abs(shift.ty - shift.y) < 0.5) shift.y = shift.ty;
      applyShift();
    }

    if (mode === "walk" && hover.inside && !press.active) hover.dirty = true; // the view moves under a still cursor
    updateHover(now);
    updateAim(now);
    renderer.render(scene, camera);

    lastInfo.calls = renderer.info.render.calls;
    lastInfo.triangles = renderer.info.render.triangles;
    frames++;
    if (now - fpsClock >= 500) {
      lastInfo.fps = Math.round((frames * 1000) / (now - fpsClock));
      frames = 0;
      fpsClock = now;
      if (readout) readout.textContent = `${lastInfo.fps} fps\n${lastInfo.calls} calls / 200\n${lastInfo.triangles} tris / 400000`;
    }
    if (!room.ready) {
      room.ready = true;
      dom.loading.classList.add("done");
    }
  }
  requestAnimationFrame(frame);

  ui.live = true;
  applyModeUI();
  /** HUD places that are not content zones: the garden (preset), the bed (the nook's vantage, if LOFT defines one). */
  function place(id) {
    if (id === "garden") return view(GARDEN_PRESET);
    const v = id === "bed" && LAYOUT.loft && LAYOUT.loft.vantage;
    if (!v) return false;
    if (mode !== "walk") setMode("walk", true);
    return vantage({ ...v, label: v.label && v.label !== "loft" ? v.label : "bed" });
  }
  for (const b of placeButtons) {
    if (b.dataset.place === "bed") b.hidden = !(LAYOUT.loft && LAYOUT.loft.vantage);
  }

  return {
    view, punch, focusZone, interact, setMode, leave, place,
    stepTime: () => sky.stepHour(),
    panelChanged() {
      panelChanged();
      if (!panel.zone && mode === "walk" && walk.state === "inspect") returnToPlayer();
    },
  };
}

boot();
