// lib/content.js — loads ./content.json (written by build.mjs). Never throws: on any failure it returns
// a well-formed empty structure, so the room still renders and every panel still opens.
//
// Shape:
//   { ok: boolean,
//     site:   { title, author, tagline },
//     zones:  { [zoneId]: { title, blurb, links: [{ label, url }], items: [Item] } },
//     latest: [Item] }                                   newest 12 across everything
//   Item = { title, url, date (ISO string), summary, source, sourceLabel, motif }   motif: portfolio items only
//   zoneIds: music, library, journal, laptop, training, screen, book, portfolio, door

export const ZONE_IDS = ["music", "library", "journal", "laptop", "training", "screen", "book", "portfolio", "door"];

/** A well-formed content object with nothing in it (`ok: false`). */
export function emptyContent() {
  const zones = {};
  for (const id of ZONE_IDS) zones[id] = { title: id, blurb: "", links: [], items: [] };
  return { ok: false, site: { title: "ubermayinch", author: "", tagline: "" }, zones, latest: [] };
}

const str = (v) => (typeof v === "string" ? v : "");

const cleanItem = (it) =>
  it && typeof it === "object" && str(it.title) && str(it.url)
    ? { title: it.title, url: it.url, date: str(it.date), summary: str(it.summary), source: str(it.source), sourceLabel: str(it.sourceLabel), motif: str(it.motif) }
    : null;

const cleanLink = (l) => (l && typeof l === "object" && str(l.label) && str(l.url) ? { label: l.label, url: l.url } : null);

const list = (v, clean) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);

/** Coerce anything into the documented shape (missing zones become empty ones). */
export function normalizeContent(raw) {
  const out = emptyContent();
  if (!raw || typeof raw !== "object") return out;
  out.ok = true;
  if (raw.site && typeof raw.site === "object") {
    out.site = { title: str(raw.site.title) || out.site.title, author: str(raw.site.author), tagline: str(raw.site.tagline) };
  }
  const zones = raw.zones && typeof raw.zones === "object" ? raw.zones : {};
  for (const id of Object.keys(zones)) {
    const z = zones[id];
    if (!z || typeof z !== "object") continue;
    out.zones[id] = { title: str(z.title) || id, blurb: str(z.blurb), links: list(z.links, cleanLink), items: list(z.items, cleanItem) };
  }
  out.latest = list(raw.latest, cleanItem);
  return out;
}

/**
 * Fetch and normalise content.json. Resolves (never rejects) within `timeout` ms.
 * @param {{ url?: string, timeout?: number }} [opts]
 * @returns {Promise<ReturnType<typeof emptyContent>>}
 */
export async function loadContent(opts = {}) {
  const { url = "./content.json", timeout = 5000 } = opts;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetch(url, { signal: controller ? controller.signal : undefined, cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeContent(await res.json());
  } catch {
    return emptyContent();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
