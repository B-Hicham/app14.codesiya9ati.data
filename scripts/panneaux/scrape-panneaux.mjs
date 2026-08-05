// Scraper for the public road-sign catalogue on https://conduire.ma/ar/panneaux
//
// Just like the quiz pages (see scrape-quizzes.mjs), /ar/panneaux is
// server-rendered (TanStack Start) and embeds its FULL payload - every
// section (danger signs, obligation signs, ...) and every sign (title,
// meaning FR/AR, image URLs) - as inline <script> tags that hydrate a `$R`
// reference table in the browser. Unlike the quizzes, this is a single page
// (no pagination, no id range to walk): we fetch the plain HTML once, run
// those inline scripts in a bare Node `vm` context (no fs/process/require
// exposed, no network access granted inside it) to reconstruct the same
// object the browser builds, then read the {sections, signs} object back out.
//
// Usage (from the repo root, e.g. via `npm run scrape-panneaux`):
//   node scripts/panneaux/scrape-panneaux.mjs                       download sections.json + signs.json
//   node scripts/panneaux/scrape-panneaux.mjs --media                also download every sign image
//   node scripts/panneaux/scrape-panneaux.mjs --out=./data/panneaux  output directory (default ./data/panneaux)
//   node scripts/panneaux/scrape-panneaux.mjs --media-out=./files/panneaux  media output dir (default ./files/panneaux)

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const PANNEAUX_DIR = path.resolve(args.out ?? "./data/panneaux");
const MEDIA_DIR = path.resolve(args["media-out"] ?? "./files/panneaux");
const DOWNLOAD_MEDIA = Boolean(args.media);
const MEDIA_CONCURRENCY = 6;

const BASE = "https://conduire.ma";
const PAGE_URL = `${BASE}/ar/panneaux`;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConduireScraper/1.0; personal/educational use; +mailto:hichamboubrahim4040@gmail.com)";

async function fetchText(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function fetchBuffer(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

// Same extraction strategy as extractQuizFromHtml() in scrape-quizzes.mjs,
// but the object we're after has {sections, signs} instead of {questions}.
function extractPanneauxFromHtml(html) {
  const scriptRe = /<script(?![^>]*\ssrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g;
  const chunks = [];
  let m;
  while ((m = scriptRe.exec(html))) {
    const body = m[1];
    if (body.includes("$R") || body.includes("$_TSR")) chunks.push(body);
  }
  if (chunks.length === 0) {
    throw new Error("no hydration <script> blocks found (page structure may have changed)");
  }

  const code = chunks.join("\n").replaceAll("document.currentScript.remove()", "");

  const sandbox = {};
  sandbox.self = sandbox;
  sandbox.ReadableStream = ReadableStream;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { timeout: 5000, filename: "panneaux.js" });
  } catch (err) {
    console.warn(`  (non-fatal hydration error, continuing: ${err.message})`);
  }

  const table = sandbox.$R && sandbox.$R.tsr;
  if (!Array.isArray(table)) {
    throw new Error("hydration table ($R.tsr) not found after running scripts");
  }

  const data = table.find(
    (v) => v && typeof v === "object" && Array.isArray(v.sections) && Array.isArray(v.signs)
  );
  if (!data) {
    throw new Error("no object with sections[]/signs[] arrays found in hydration table");
  }

  return data;
}

function collectMediaUrls(signs) {
  const urls = new Set();
  for (const s of signs) {
    for (const img of s.images ?? []) urls.add(img);
  }
  return [...urls];
}

async function downloadMedia(urls) {
  const dirs = new Set(urls.map((u) => path.dirname(new URL(u).pathname)));
  for (const dir of dirs) {
    await fs.mkdir(path.join(MEDIA_DIR, ...dir.split("/").filter(Boolean).slice(1)), {
      recursive: true,
    });
  }

  let i = 0;
  let done = 0,
    skipped = 0,
    failed = 0;

  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      const u = new URL(url);
      // pathname is /signs/<folder>/<file>; keep the <folder>/<file> part
      const relParts = u.pathname.split("/").filter(Boolean).slice(1);
      const dest = path.join(MEDIA_DIR, ...relParts.map(decodeURIComponent));
      try {
        await fs.access(dest);
        skipped++;
        continue;
      } catch {
        /* not present yet, fall through and fetch */
      }
      try {
        const buf = await fetchBuffer(url);
        await fs.writeFile(dest, buf);
        done++;
      } catch (err) {
        failed++;
        console.error(`  ! media failed: ${url} (${err.message})`);
      }
    }
  }

  await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, worker));
  console.log(`\n--- Media download summary ---`);
  console.log(`Downloaded: ${done}, already present: ${skipped}, failed: ${failed}`);
}

async function main() {
  await fs.mkdir(PANNEAUX_DIR, { recursive: true });

  console.log(`Fetching ${PAGE_URL} ...`);
  const html = await fetchText(PAGE_URL);
  const { sections, signs } = extractPanneauxFromHtml(html);

  await fs.writeFile(
    path.join(PANNEAUX_DIR, "sections.json"),
    JSON.stringify(sections, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(PANNEAUX_DIR, "signs.json"), JSON.stringify(signs, null, 2), "utf8");

  console.log(`\n--- Summary ---`);
  console.log(`Sections: ${sections.length}`);
  console.log(`Signs: ${signs.length}`);
  console.log(`Output: ${PANNEAUX_DIR}`);

  if (DOWNLOAD_MEDIA) {
    const urls = collectMediaUrls(signs);
    console.log(`\nDownloading ${urls.length} unique sign images ...`);
    await downloadMedia(urls);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
