#!/usr/bin/env node
// Builds the static site into dist/: homepage, /feed/, /feed.xml (Atom), /feed.json (JSON Feed).
// Zero dependencies. Fetches every source's feed at build time (browsers can't: no CORS on these hosts).

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "dist";
const config = JSON.parse(await readFile("sources.json", "utf8"));
const { site, sources, elsewhere } = config;
// Where this build is served. CI sets PUBLIC_URL from GitHub Pages (e.g. https://user.github.io/repo while
// the custom domain is not live); defaults to site.url. BASE prefixes every internal link.
const SITE_URL = (process.env.PUBLIC_URL || site.url).replace(/\/+$/, "");
const BASE = new URL(SITE_URL).pathname.replace(/\/+$/, "");

// ---------- XML parsing (RSS 2.0 + Atom, regex-level: enough for well-formed feeds) ----------

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

const unwrap = (s) => {
  const cdata = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(s);
};

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? unwrap(m[1]).trim() : "";
};

const blocks = (xml, name) => xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, "gi")) ?? [];

const attr = (el, name) => {
  const m = el.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return m ? decode(m[2]) : "";
};

const atomLink = (entry) => {
  const links = entry.match(/<link\b[^>]*>/gi) ?? [];
  const alt = links.find((l) => !/\srel=/i.test(l) || /\srel=["']alternate["']/i.test(l));
  return alt ? attr(alt, "href") : "";
};

const toText = (html) =>
  decode(decode(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const excerpt = (html, n = 220) => {
  const t = toText(html);
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
};

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "");

function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  if (isAtom) {
    return blocks(xml, "entry").map((e) => ({
      title: toText(tag(e, "title")),
      url: atomLink(e),
      date: tag(e, "published") || tag(e, "updated"),
      summary: excerpt(tag(e, "media:description") || tag(e, "summary") || tag(e, "content")),
    }));
  }
  return blocks(xml, "item").map((i) => ({
    title: toText(tag(i, "title")),
    url: tag(i, "link"),
    date: tag(i, "pubDate") || tag(i, "dc:date"),
    summary: excerpt(tag(i, "description") || tag(i, "content:encoded")),
  }));
}

// ---------- fetching, with last-good fallback ----------

async function previousItems() {
  // Prefer local last build, else whatever is live. Keeps a flaky source from vanishing.
  try {
    if (existsSync(`${OUT}/feed.json`)) return JSON.parse(await readFile(`${OUT}/feed.json`, "utf8")).items ?? [];
    const res = await fetch(`${SITE_URL}/feed.json`, { signal: AbortSignal.timeout(10000) });
    return res.ok ? (await res.json()).items ?? [] : [];
  } catch {
    return [];
  }
}

// Feeds only expose their latest N items; keep everything ever seen so the archive grows, never shrinks.
async function fetchSource(src, prev) {
  if (!src.feed) return [];
  const kept = prev
    .filter((p) => p._source?.id === src.id)
    .map((p) => ({ title: p.title, url: p.url, date: new Date(p.date_published), summary: p.summary ?? "", source: src.id }));
  try {
    const res = await fetch(src.feed, {
      headers: { "user-agent": `${site.title}-feed-builder (+${site.url})`, accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text())
      .map((it) => ({ ...it, url: safeUrl(it.url), date: new Date(it.date) }))
      .filter((it) => it.url && it.title && !isNaN(it.date))
      .map((it) => ({ ...it, source: src.id }));
    if (!items.length) throw new Error("no items parsed");
    console.log(`ok   ${src.id}: ${items.length} fetched, ${kept.length} previously known`);
    return [...items, ...kept]; // fresh first, so dedupe-by-URL prefers fresh data
  } catch (err) {
    console.warn(`FAIL ${src.id}: ${err.message} — kept ${kept.length} previous items`);
    return kept;
  }
}

const prev = await previousItems();
const items = (await Promise.all(sources.map((s) => fetchSource(s, prev))))
  .flat()
  .sort((a, b) => b.date - a.date);

// dedupe by URL (e.g. cross-posts)
const seen = new Set();
const feed = items.filter((it) => (seen.has(it.url) ? false : seen.add(it.url)));

// ---------- rendering ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
const day = (d) => d.toISOString().slice(0, 10);

const layout = ({ title, body, path }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(site.tagline)}">
<link rel="canonical" href="${esc(SITE_URL + path)}">
<link rel="alternate" type="application/atom+xml" title="${esc(site.title)} — everything" href="${BASE}/feed.xml">
<link rel="alternate" type="application/feed+json" title="${esc(site.title)} — everything" href="${BASE}/feed.json">
<link rel="stylesheet" href="${BASE}/style.css">
</head>
<body>
<header class="top"><a href="${BASE}/" class="home">${esc(site.title)}</a><nav><a href="${BASE}/feed/">feed</a><a href="${BASE}/feed.xml">rss</a></nav></header>
<main>
${body}
</main>
<footer>© ${new Date().getFullYear()} ${esc(site.author)} · <a href="${BASE}/feed.xml">subscribe (rss/atom)</a> · updated ${esc(day(new Date()))}</footer>
</body>
</html>
`;

const entry = (it) => {
  const src = byId[it.source];
  return `<li class="item" data-source="${esc(it.source)}">
  <time datetime="${esc(it.date.toISOString())}">${esc(day(it.date))}</time>
  <div>
    <a class="title" href="${esc(it.url)}">${esc(it.title)}</a>
    <span class="src">${esc(src.label)}</span>
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
  </div>
</li>`;
};

const home = layout({
  title: `${site.author} — ${site.title}`,
  path: "/",
  body: `<section class="intro">
  <h1>${esc(site.author)}</h1>
  <p>${esc(site.tagline)}</p>
</section>

<section>
  <h2>latest <a class="more" href="${BASE}/feed/">all →</a></h2>
  <ul class="items">
${feed.slice(0, 6).map(entry).join("\n")}
  </ul>
</section>

<section>
  <h2>where i write</h2>
  <ul class="outlets">
${sources
  .map((s) => {
    const latest = feed.find((it) => it.source === s.id);
    return `    <li><a href="${esc(s.site)}">${esc(s.label)}</a> <span class="about">${esc(s.about)}</span>${latest ? ` <span class="latest">last: ${esc(day(latest.date))}</span>` : ""}</li>`;
  })
  .join("\n")}
  </ul>
</section>

<section>
  <h2>elsewhere</h2>
  <p class="elsewhere">${elsewhere.map((e) => `<a href="${esc(e.url)}">${esc(e.label)}</a>`).join(" · ")}</p>
</section>`,
});

const counts = Object.fromEntries(sources.map((s) => [s.id, feed.filter((it) => it.source === s.id).length]));
const feedPage = layout({
  title: `feed — ${site.title}`,
  path: "/feed/",
  body: `<section class="intro">
  <h1>feed</h1>
  <p>Everything I put out, everywhere, newest first. Subscribe: <a href="${BASE}/feed.xml">atom/rss</a> · <a href="${BASE}/feed.json">json</a></p>
</section>

<nav class="filters" aria-label="filter by source">
  <button data-filter="all" aria-pressed="true">all <span>${feed.length}</span></button>
${sources
  .filter((s) => counts[s.id])
  .map((s) => `  <button data-filter="${esc(s.id)}" aria-pressed="false">${esc(s.label)} <span>${counts[s.id]}</span></button>`)
  .join("\n")}
</nav>

<ul class="items">
${feed.map(entry).join("\n")}
</ul>

<script>
document.querySelector(".filters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const f = b.dataset.filter;
  document.querySelectorAll(".filters button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  document.querySelectorAll(".items .item").forEach((li) => { li.hidden = f !== "all" && li.dataset.source !== f; });
});
</script>`,
});

const updated = (feed[0]?.date ?? new Date()).toISOString();
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(site.title)} — everything by ${esc(site.author)}</title>
  <subtitle>${esc(site.tagline)}</subtitle>
  <id>${esc(site.url)}/</id>
  <link rel="self" href="${esc(SITE_URL)}/feed.xml"/>
  <link rel="alternate" href="${esc(SITE_URL)}/feed/"/>
  <updated>${updated}</updated>
  <author><name>${esc(site.author)}</name></author>
${feed
  .map(
    (it) => `  <entry>
    <title>${esc(it.title)}</title>
    <link rel="alternate" href="${esc(it.url)}"/>
    <id>${esc(it.url)}</id>
    <published>${it.date.toISOString()}</published>
    <updated>${it.date.toISOString()}</updated>
    <category term="${esc(it.source)}" label="${esc(byId[it.source].label)}"/>
    <summary>${esc(`[${byId[it.source].label}] ${it.summary}`.trim())}</summary>
  </entry>`,
  )
  .join("\n")}
</feed>
`;

const jsonFeed = {
  version: "https://jsonfeed.org/version/1.1",
  title: `${site.title} — everything by ${site.author}`,
  home_page_url: `${SITE_URL}/feed/`,
  feed_url: `${SITE_URL}/feed.json`,
  authors: [{ name: site.author }],
  items: feed.map((it) => ({
    id: it.url,
    url: it.url,
    title: it.title,
    summary: it.summary,
    date_published: it.date.toISOString(),
    tags: [byId[it.source].label],
    _source: { id: it.source, label: byId[it.source].label },
  })),
};

const notFound = layout({
  title: `not found — ${site.title}`,
  path: "/404.html",
  body: `<section class="intro"><h1>404</h1><p>Nothing here. Try the <a href="${BASE}/">homepage</a> or the <a href="${BASE}/feed/">feed</a>.</p></section>`,
});

await mkdir(`${OUT}/feed`, { recursive: true });
await Promise.all([
  writeFile(`${OUT}/index.html`, home),
  writeFile(`${OUT}/feed/index.html`, feedPage),
  writeFile(`${OUT}/feed.xml`, atom),
  writeFile(`${OUT}/feed.json`, JSON.stringify(jsonFeed, null, 2)),
  copyFile("static/style.css", `${OUT}/style.css`),
  writeFile(`${OUT}/404.html`, notFound),
]);
console.log(`built ${feed.length} items → ${OUT}/`);
