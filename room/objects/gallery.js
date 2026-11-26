// objects/gallery.js — the portfolio painting: one framed oil-on-canvas on the E wall, split into painted
// vignettes, one per item of content.json zone "portfolio" (sources.json `projects`). Each vignette is its own
// mesh (sharing one canvas texture through remapped UVs), so a tap on it resolves to that project's url; the
// gutters, frame and brass plaque open the "portfolio" panel. A brass picture light glows over it by night.
//
// Layout: LAYOUT.gallery. The painting hangs ON the E wall: update() copies that wall's visibility (overview
// cutaway), like the ensō scroll. Nothing here casts shadows; one small non-shadow PointLight (night only).
//
// Motifs (item.motif): house, camera, swarm, lanes, rhizome; anything else gets an abstract colour field.
// Slots: item 0 takes a tall left panel, the rest fill two rows of columns to its right, so a sixth project
// needs only a sources.json entry.
import * as THREE from "three";

const TAU = Math.PI * 2;
const NO_TIME = { night: 0 };

// ---- slot layout (normalised canvas coords, y down) ----------------------------------------------------

function slots(n) {
  const m = 0.035, gut = 0.022; // outer margin, gutter between panels
  if (n <= 0) return [];
  if (n === 1) return [[m, m, 1 - m, 1 - m]];
  const firstW = n === 2 ? 0.5 : 0.36;
  const out = [[m, m, m + (1 - 2 * m) * firstW - gut / 2, 1 - m]];
  const rest = n - 1;
  const cols = Math.ceil(rest / 2);
  const x0 = out[0][2] + gut, colW = (1 - m - x0 - gut * (cols - 1)) / cols;
  for (let i = 0; i < rest; i++) {
    const c = Math.floor(i / 2), inCol = Math.min(2, rest - c * 2), r = i % 2;
    const cx = x0 + c * (colW + gut);
    const rowH = (1 - 2 * m - gut * (inCol - 1)) / inCol;
    const cy = m + r * (rowH + gut);
    out.push([cx, cy, cx + colW, cy + rowH]);
  }
  return out;
}

// ---- vignettes: each paints into (x, y, w, h) in canvas px ------------------------------------------

function grad(g, x, y, w, h, stops, vertical = true) {
  const gr = vertical ? g.createLinearGradient(x, y, x, y + h) : g.createLinearGradient(x, y, x + w, y);
  stops.forEach(([t, c]) => gr.addColorStop(t, c));
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
}

function blob(g, cx, cy, r, color, rng, lobes = 7) {
  g.fillStyle = color;
  g.beginPath();
  for (let i = 0; i <= lobes * 4; i++) {
    const a = (i / (lobes * 4)) * TAU;
    const rr = r * (0.82 + 0.3 * rng());
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.8;
    i ? g.lineTo(px, py) : g.moveTo(px, py);
  }
  g.closePath();
  g.fill();
}

const MOTIFS = {
  // the house and garden at dusk: this site and the room you stand in
  house(g, x, y, w, h, rng) {
    grad(g, x, y, w, h, [[0, "#243457"], [0.45, "#6b5a86"], [0.72, "#e39a6a"], [0.78, "#f1c27f"]]);
    g.fillStyle = "rgba(255,236,190,0.95)";
    g.beginPath(); g.arc(x + w * 0.7, y + h * 0.7, w * 0.11, 0, TAU); g.fill();
    for (let i = 0; i < 26; i++) { // first stars
      g.fillStyle = `rgba(255,248,230,${0.4 + 0.5 * rng()})`;
      g.fillRect(x + rng() * w, y + rng() * h * 0.35, 2, 2);
    }
    const gy = y + h * 0.76;
    grad(g, x, gy, w, h * 0.24, [[0, "#3d4a2c"], [1, "#1f2619"]]);
    g.strokeStyle = "rgba(220,210,185,0.35)"; g.lineWidth = 2; // raked gravel
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(x, gy + i * h * 0.04); g.lineTo(x + w, gy + i * h * 0.04 + 4); g.stroke(); }
    const hx = x + w * 0.18, hw = w * 0.6, hy = gy - h * 0.2; // house body
    g.fillStyle = "#e9e1d2"; g.fillRect(hx, hy, hw, h * 0.2);
    g.fillStyle = "#3a2a20";
    for (let i = 0; i <= 5; i++) g.fillRect(hx + (hw - 8) * (i / 5), hy, 8, h * 0.2);
    g.fillStyle = "#2f2e2c"; // roof
    g.beginPath(); g.moveTo(hx - w * 0.07, hy + 4); g.lineTo(hx + hw * 0.5, hy - h * 0.1); g.lineTo(hx + hw + w * 0.07, hy + 4); g.closePath(); g.fill();
    g.fillStyle = "#ffcf8a"; g.fillRect(hx + hw * 0.38, hy + h * 0.05, hw * 0.22, h * 0.15); // lit doorway
    g.fillStyle = "rgba(255,207,138,0.25)"; g.fillRect(hx + hw * 0.3, hy + h * 0.2, hw * 0.38, h * 0.05);
    g.strokeStyle = "#4a2f20"; g.lineWidth = 7; // maple
    g.beginPath(); g.moveTo(x + w * 0.1, gy + h * 0.02); g.quadraticCurveTo(x + w * 0.06, gy - h * 0.18, x + w * 0.16, gy - h * 0.3); g.stroke();
    for (let i = 0; i < 6; i++) blob(g, x + w * (0.06 + 0.12 * rng()), gy - h * (0.28 + 0.12 * rng()), w * (0.06 + 0.04 * rng()), ["#a63c26", "#c2532f", "#8e2f1f"][i % 3], rng);
  },

  // a retro camera booth: viewfinder brackets, REC dot, a scatter of instant prints
  camera(g, x, y, w, h, rng) {
    grad(g, x, y, w, h, [[0, "#1a1714"], [1, "#0b0b0c"]]);
    const v = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, w * 0.7);
    v.addColorStop(0, "rgba(120,70,40,0.35)"); v.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = v; g.fillRect(x, y, w, h);
    const warm = [["#f2b56b", "#c4513b"], ["#9ec3c7", "#3c5f78"], ["#f4d9a6", "#d9825b"], ["#c7a3c9", "#5c3d6b"]];
    for (let i = 0; i < 4; i++) {
      const pw = w * 0.32, ph = pw * 1.18;
      const cx = x + w * (0.28 + 0.15 * i + 0.05 * rng()), cy = y + h * (0.48 + 0.12 * (rng() - 0.5));
      g.save(); g.translate(cx, cy); g.rotate((rng() - 0.5) * 0.6);
      g.fillStyle = "#efe9de"; g.fillRect(-pw / 2, -ph / 2, pw, ph);
      const [a, b] = warm[i % warm.length];
      grad(g, -pw / 2 + pw * 0.08, -ph / 2 + pw * 0.08, pw * 0.84, pw * 0.84, [[0, a], [1, b]]);
      g.fillStyle = "rgba(255,245,220,0.6)"; g.beginPath(); g.arc(pw * 0.12, -ph * 0.12, pw * 0.11, 0, TAU); g.fill();
      g.restore();
    }
    g.strokeStyle = "rgba(240,235,225,0.85)"; g.lineWidth = 3;
    const ix = w * 0.08, iy = h * 0.1, L = Math.min(w, h) * 0.12;
    for (const [px, py, sx, sy] of [[x + ix, y + iy, 1, 1], [x + w - ix, y + iy, -1, 1], [x + ix, y + h - iy, 1, -1], [x + w - ix, y + h - iy, -1, -1]]) {
      g.beginPath(); g.moveTo(px, py + sy * L); g.lineTo(px, py); g.lineTo(px + sx * L, py); g.stroke();
    }
    g.fillStyle = "#e0372c"; g.beginPath(); g.arc(x + ix + 14, y + iy + 22, 7, 0, TAU); g.fill();
    g.font = `${Math.round(h * 0.075)}px "VT323", ui-monospace, monospace`; g.fillStyle = "rgba(240,235,225,0.9)";
    g.fillText("REC", x + ix + 28, y + iy + 22 + h * 0.025);
  },

  // a survivors-style arena: the graduate, orbiting pencils, the swarm closing in, the clock
  swarm(g, x, y, w, h, rng) {
    grad(g, x, y, w, h, [[0, "#35543f"], [1, "#24392c"]]);
    for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(20,35,25,${0.3 + 0.4 * rng()})`; g.fillRect(x + rng() * w, y + rng() * h, 3, 2); }
    const cx = x + w * 0.5, cy = y + h * 0.56;
    const cols = ["#F783AC", "#74C0FC", "#C92A2A", "#ADB5BD", "#E0A526"];
    for (let i = 0; i < 70; i++) {
      const a = rng() * TAU, r = Math.min(w, h) * (0.3 + 0.22 * rng());
      g.fillStyle = cols[i % cols.length];
      g.beginPath(); g.arc(cx + Math.cos(a) * r * 1.3, cy + Math.sin(a) * r, 3 + 4 * rng(), 0, TAU); g.fill();
    }
    g.strokeStyle = "rgba(252,196,25,0.35)"; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, Math.min(w, h) * 0.16, 0, TAU); g.stroke();
    g.fillStyle = "#FCC419";
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; g.beginPath(); g.arc(cx + Math.cos(a) * Math.min(w, h) * 0.16, cy + Math.sin(a) * Math.min(w, h) * 0.16, 5, 0, TAU); g.fill(); }
    const s = Math.min(w, h) * 0.05; // the graduate: body + mortarboard
    g.fillStyle = "#f1ece0"; g.fillRect(cx - s * 0.5, cy - s * 0.4, s, s * 1.3);
    g.fillStyle = "#1a1a1a"; g.fillRect(cx - s * 0.9, cy - s * 0.75, s * 1.8, s * 0.3);
    g.fillStyle = "#FCC419"; g.fillRect(x + w * 0.06, y + h * 0.08, w * 0.88 * 0.62, 6);
    g.strokeStyle = "rgba(241,236,224,0.6)"; g.lineWidth = 1.5; g.strokeRect(x + w * 0.06, y + h * 0.08, w * 0.88, 6);
    g.font = `600 ${Math.round(h * 0.09)}px "IBM Plex Mono", ui-monospace, monospace`; g.fillStyle = "#f1ece0"; g.textAlign = "center";
    g.fillText("14:59", x + w / 2, y + h * 0.23); g.textAlign = "left";
  },

  // a note highway under stage light: four lanes, falling gems, the strike line
  lanes(g, x, y, w, h, rng) {
    grad(g, x, y, w, h, [[0, "#1a0b2a"], [1, "#07030c"]]);
    const lanes = ["#22d3ee", "#facc15", "#f97316", "#ef4444"];
    const top = y + h * 0.08, bot = y + h * 0.86, cx = x + w / 2, tw = w * 0.16, bw = w * 0.78;
    g.fillStyle = "rgba(10,6,16,0.9)";
    g.beginPath(); g.moveTo(cx - tw / 2, top); g.lineTo(cx + tw / 2, top); g.lineTo(cx + bw / 2, bot); g.lineTo(cx - bw / 2, bot); g.closePath(); g.fill();
    const laneX = (i, t) => cx + ((i + 0.5) / 4 - 0.5) * (tw + (bw - tw) * t);
    g.strokeStyle = "rgba(168,162,158,0.5)"; g.lineWidth = 1.5;
    for (let i = 0; i <= 4; i++) { const xt = cx + (i / 4 - 0.5) * tw, xb = cx + (i / 4 - 0.5) * bw; g.beginPath(); g.moveTo(xt, top); g.lineTo(xb, bot); g.stroke(); }
    for (let k = 0; k < 9; k++) {
      const i = Math.floor(rng() * 4), t = 0.1 + 0.8 * rng(), py = top + (bot - top) * t, r = 4 + 12 * t;
      g.fillStyle = lanes[i]; g.beginPath(); g.ellipse(laneX(i, t), py, r * 1.3, r * 0.6, 0, 0, TAU); g.fill();
    }
    for (let i = 0; i < 4; i++) {
      g.strokeStyle = lanes[i]; g.lineWidth = 4;
      g.beginPath(); g.ellipse(laneX(i, 1), bot, bw * 0.08, bw * 0.03, 0, 0, TAU); g.stroke();
    }
    const sp = g.createRadialGradient(cx, y, 0, cx, y, h * 0.7);
    sp.addColorStop(0, "rgba(250,204,21,0.25)"); sp.addColorStop(1, "rgba(250,204,21,0)");
    g.fillStyle = sp; g.fillRect(x, y, w, h);
    g.fillStyle = "rgba(0,0,0,0.18)"; // scanlines
    for (let yy = y; yy < y + h; yy += 4) g.fillRect(x, yy, w, 1.5);
  },

  // a graph of linked notes on a dark editor ground, a notebook cell marker in the corner
  rhizome(g, x, y, w, h, rng) {
    grad(g, x, y, w, h, [[0, "#161b22"], [1, "#0d1117"]]);
    const pts = [];
    for (let i = 0; i < 29; i++) pts.push([x + w * (0.1 + 0.8 * rng()), y + h * (0.2 + 0.7 * rng()), rng()]);
    g.lineWidth = 1.6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > Math.min(w, h) * 0.3 || rng() < 0.45) continue;
        g.strokeStyle = `rgba(${rng() < 0.5 ? "88,166,255" : "163,113,247"},0.55)`;
        const mx = (pts[i][0] + pts[j][0]) / 2 + (rng() - 0.5) * 30, my = (pts[i][1] + pts[j][1]) / 2 + (rng() - 0.5) * 30;
        g.beginPath(); g.moveTo(pts[i][0], pts[i][1]); g.quadraticCurveTo(mx, my, pts[j][0], pts[j][1]); g.stroke();
      }
    }
    for (const [px, py, s] of pts) {
      const r = 3 + 6 * s;
      const gl = g.createRadialGradient(px, py, 0, px, py, r * 3);
      gl.addColorStop(0, "rgba(121,192,255,0.5)"); gl.addColorStop(1, "rgba(121,192,255,0)");
      g.fillStyle = gl; g.fillRect(px - r * 3, py - r * 3, r * 6, r * 6);
      g.fillStyle = s > 0.75 ? "#d2a8ff" : "#79c0ff"; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
    }
    g.font = `${Math.round(h * 0.08)}px ui-monospace, monospace`; g.fillStyle = "rgba(139,148,158,0.9)";
    g.fillText("[1]:", x + w * 0.06, y + h * 0.13);
  },

  // fallback: soft-edged colour fields
  abstract(g, x, y, w, h, rng) {
    const pal = [["#c9b48a", "#7a2e22", "#2f4858"], ["#d8cfc0", "#3d5a40", "#a8642a"], ["#e3d5b8", "#5a3e5d", "#1f2a36"]][Math.floor(rng() * 3)];
    g.fillStyle = pal[0]; g.fillRect(x, y, w, h);
    blob(g, x + w * 0.5, y + h * 0.35, Math.min(w, h) * 0.3, pal[1], rng);
    blob(g, x + w * 0.45, y + h * 0.72, Math.min(w, h) * 0.22, pal[2], rng);
  },
};

// ---- the painting ------------------------------------------------------------------------------------

function paint(T, W, H, items, rects, rng) {
  const { canvas, ctx: g } = T.makeCanvas(W, H);
  // ground: warm umber priming, shows in the gutters and margins
  grad(g, 0, 0, W, H, [[0, "#3a2c22"], [1, "#2a1f18"]]);
  const flows = [];
  rects.forEach(([u0, v0, u1, v1], i) => {
    const x = u0 * W, y = v0 * H, w = (u1 - u0) * W, h = (v1 - v0) * H;
    const it = items[i];
    const draw = (it && MOTIFS[it.motif]) || MOTIFS.abstract;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    try { draw(g, x, y, w, h, rng.fork(`slot${i}`)); } catch (err) { console.error("[room] gallery vignette failed", err); MOTIFS.abstract(g, x, y, w, h, rng.fork(`fb${i}`)); }
    g.restore();
    flows.push(rng.float(-0.6, 0.6) + (rng() < 0.3 ? Math.PI / 2 : 0));
  });

  // painterly pass: short strokes, each in the colour already under it, oriented per panel
  const data = g.getImageData(0, 0, W, H).data;
  const slotAt = (px, py) => rects.findIndex(([u0, v0, u1, v1]) => px >= u0 * W && px < u1 * W && py >= v0 * H && py < v1 * H);
  g.lineCap = "round";
  for (let k = 0; k < 11000; k++) {
    const px = rng() * W, py = rng() * H;
    const o = ((py | 0) * W + (px | 0)) * 4;
    const s = slotAt(px, py);
    const a = (s >= 0 ? flows[s] : 0.2) + rng.gauss(0, 0.25);
    const len = 4 + rng() * 12, j = 1 + rng.gauss(0, 0.06);
    g.strokeStyle = `rgba(${Math.min(255, data[o] * j) | 0},${Math.min(255, data[o + 1] * j) | 0},${Math.min(255, data[o + 2] * j) | 0},0.5)`;
    g.lineWidth = 1.5 + rng() * 3;
    g.beginPath(); g.moveTo(px - Math.cos(a) * len / 2, py - Math.sin(a) * len / 2); g.lineTo(px + Math.cos(a) * len / 2, py + Math.sin(a) * len / 2); g.stroke();
  }

  // titles, lettered on after the paint dried
  rects.forEach(([u0, v0, u1, v1], i) => {
    const it = items[i];
    if (!it || !it.title) return;
    const x = u0 * W, y = v0 * H, w = (u1 - u0) * W, h = (v1 - v0) * H;
    const fs = Math.round(Math.max(15, Math.min(26, h * 0.075)));
    g.font = `italic 600 ${fs}px "Instrument Serif", Georgia, serif`;
    const text = T.fitText(g, it.title, w - fs * 1.4);
    g.fillStyle = "rgba(0,0,0,0.45)"; g.fillText(text, x + fs * 0.7 + 1.5, y + h - fs * 0.7 + 1.5);
    g.fillStyle = "rgba(246,238,222,0.95)"; g.fillText(text, x + fs * 0.7, y + h - fs * 0.7);
  });
  // canvas weave + signature
  T.grainOverlay(g, W, H, { amount: 0.06, rng: rng.fork("grain") });
  g.globalAlpha = 0.7; g.strokeStyle = "rgba(0,0,0,0.05)"; g.lineWidth = 1;
  for (let yy = 0; yy < H; yy += 3) { g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke(); }
  for (let xx = 0; xx < W; xx += 3) { g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, H); g.stroke(); }
  g.globalAlpha = 1;
  return canvas;
}

function plaqueCanvas(T, title, author) {
  const { canvas, ctx: g } = T.makeCanvas(512, 116);
  grad(g, 0, 0, 512, 116, [[0, "#d8b878"], [0.5, "#b99556"], [1, "#8f6f3a"]]);
  g.strokeStyle = "rgba(60,40,15,0.6)"; g.lineWidth = 4; g.strokeRect(6, 6, 500, 104);
  g.fillStyle = "#2e2210"; g.textAlign = "center";
  g.font = 'italic 600 44px "Instrument Serif", Georgia, serif';
  g.fillText(T.fitText(g, title, 470), 256, 56);
  g.font = "500 24px ui-monospace, monospace";
  g.fillText(T.fitText(g, author, 470), 256, 92);
  return canvas;
}

// a plane covering [u0, u1] × [v0, v1] of the canvas (v down), in painting-local metres, UVs into the atlas
function slotPlane(rect, pw, ph, z) {
  const [u0, v0, u1, v1] = rect;
  const geo = new THREE.PlaneGeometry((u1 - u0) * pw, (v1 - v0) * ph);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), 1 - v1 + uv.getY(i) * (v1 - v0));
  geo.translate(((u0 + u1) / 2 - 0.5) * pw, (0.5 - (v0 + v1) / 2) * ph, z);
  return geo;
}

export function build(scene, layout, ctx) {
  const G = layout.gallery;
  const T = ctx.textures;
  const rng = ctx.rng;
  const zone = ctx.content?.zones?.portfolio;
  const items = (Array.isArray(zone?.items) ? zone.items : []).filter((it) => it && it.url);

  const root = new THREE.Group();
  root.name = "gallery";
  root.position.set(G.pos[0], G.pos[1], G.pos[2]);
  root.rotation.y = G.rotY;

  const pw = G.width, ph = G.height, fr = G.frame, dp = G.depth;
  const zFace = dp - 0.012; // canvas face, recessed behind the moulding's front
  const rects = slots(Math.max(1, items.length));
  const W = Math.min(T.MAX_SIZE, G.canvas || 1024), H = Math.round((W * ph) / pw);
  const tex = T.toTexture(paint(T, W, H, items, rects, rng.fork("paint")), { srgb: true });
  const faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 });

  // stretched canvas (its edges carry the gutters / margins), then one mesh per vignette just in front
  const canvasBox = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, zFace - 0.004), [
    ...Array(4).fill(new THREE.MeshStandardMaterial({ color: "#2a1f18", roughness: 0.9 })), faceMat, faceMat,
  ]);
  canvasBox.position.z = (zFace - 0.004) / 2 + 0.002;
  canvasBox.receiveShadow = true;
  canvasBox.name = "galleryCanvas";
  root.add(canvasBox);

  const vignettes = rects.map((r, i) => {
    const m = new THREE.Mesh(slotPlane(r, pw, ph, zFace + 0.0006), faceMat);
    m.name = `galleryPanel${i}`;
    m.receiveShadow = true;
    m.userData.item = items[i] || null;
    root.add(m);
    return m;
  });

  // moulding: dark walnut with a gilt inner lip
  const frameMat = new THREE.MeshStandardMaterial({ color: G.frameColor, roughness: 0.45, metalness: 0.05 });
  const lipMat = new THREE.MeshStandardMaterial({ color: G.lip, roughness: 0.35, metalness: 0.7 });
  const frame = new THREE.Group();
  frame.name = "galleryFrame";
  const ow = pw + 2 * fr, oh = ph + 2 * fr, lip = 0.012;
  for (const [w, h, x, y] of [[ow, fr, 0, (ph + fr) / 2], [ow, fr, 0, -(ph + fr) / 2], [fr, ph, -(pw + fr) / 2, 0], [fr, ph, (pw + fr) / 2, 0]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), frameMat);
    bar.position.set(x, y, dp / 2);
    frame.add(bar);
  }
  for (const [w, h, x, y] of [[pw + 2 * lip, lip, 0, (ph + lip) / 2], [pw + 2 * lip, lip, 0, -(ph + lip) / 2], [lip, ph, -(pw + lip) / 2, 0], [lip, ph, (pw + lip) / 2, 0]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp * 0.5), lipMat);
    bar.position.set(x, y, zFace - dp * 0.15);
    frame.add(bar);
  }
  frame.traverse((o) => o.isMesh && (o.receiveShadow = true));
  root.add(frame);

  // brass plaque under the frame
  const pq = G.plaque;
  const plaque = new THREE.Mesh(
    new THREE.BoxGeometry(pq.size[0], pq.size[1], 0.006),
    [...Array(4).fill(new THREE.MeshStandardMaterial({ color: pq.color, roughness: 0.35, metalness: 0.8 })),
      new THREE.MeshStandardMaterial({ map: T.toTexture(plaqueCanvas(T, (zone?.title || "works").toLowerCase(), ctx.content?.site?.author || ""), { srgb: true }), roughness: 0.4, metalness: 0.55 }),
      new THREE.MeshStandardMaterial({ color: pq.color })],
  );
  plaque.position.set(0, -ph / 2 - fr - pq.gap - pq.size[1] / 2, 0.003);
  plaque.name = "galleryPlaque";
  root.add(plaque);

  // picture light: wall plate, arm out, brass hood with an emissive slot facing down onto the canvas
  const L = G.light;
  const brass = new THREE.MeshStandardMaterial({ color: "#a8834a", roughness: 0.3, metalness: 0.85 });
  const glowMat = new THREE.MeshStandardMaterial({ color: "#2a2520", emissive: new THREE.Color(L.color), emissiveIntensity: 0, roughness: 0.6 });
  const topY = ph / 2 + fr + L.up;
  const lamp = new THREE.Group();
  lamp.name = "galleryLight";
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.008), brass);
  plate.position.set(0, topY, 0.004);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, L.arm, 10), brass);
  arm.rotation.x = Math.PI / 2;
  arm.position.set(0, topY, L.arm / 2);
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, L.bar, 16, 1, false, 0, Math.PI), brass);
  hood.rotation.z = Math.PI / 2;
  hood.position.set(0, topY, L.arm);
  const slot = new THREE.Mesh(new THREE.BoxGeometry(L.bar * 0.94, 0.004, 0.03), glowMat);
  slot.position.set(0, topY - 0.004, L.arm);
  lamp.add(plate, arm, hood, slot);
  root.add(lamp);
  const light = new THREE.PointLight(L.color, 0, L.distance, L.decay);
  light.position.set(0, topY - 0.04, L.arm + 0.02);
  light.castShadow = false;
  root.add(light);

  scene.add(root);

  // ---- hotspot: a vignette opens its project; frame, gutters, plaque and lamp open the panel ----------
  const resolve = (hit) => {
    const it = hit && hit.object && hit.object.userData.item;
    if (!it || !it.url) return null;
    let host = "";
    try { host = new URL(it.url).host; } catch { /* keep empty */ }
    return { label: host && host !== it.title ? `${it.title} — ${host}` : it.title, url: it.url };
  };
  const label = `${(zone?.title || "works").toLowerCase()} — things I have built`;

  // hangs ON the E wall: follow its cutaway visibility (shell.js was built first)
  const wall = scene.getObjectByName(`wall${G.wall || "E"}`) || null;
  let lastNight = -1;
  function update() {
    if (wall) root.visible = wall.visible;
    const tm = ctx.time || NO_TIME;
    const n = typeof tm.night === "number" ? tm.night : tm.night ? 1 : 0;
    if (Math.abs(n - lastNight) < 0.01) return;
    lastNight = n;
    light.intensity = L.intensity * n;
    glowMat.emissiveIntensity = 1.6 * n;
  }
  update();

  return {
    root,
    update,
    hotspots: [{ zone: "portfolio", label, objects: [...vignettes, canvasBox, frame, plaque, lamp], resolve }],
  };
}
