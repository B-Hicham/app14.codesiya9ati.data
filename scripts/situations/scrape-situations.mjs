// Scraper for the public driving-scenarios ("mawaqif") page on
// https://conduire.ma/ar/situations
//
// Same TanStack Start hydration pattern as the other scrapers (see
// scripts/panneaux/scrape-panneaux.mjs, scripts/infractions/scrape-infractions.mjs):
// the full payload is embedded directly in the HTML as inline <script> tags,
// not fetched via XHR/API. We fetch the plain HTML once, run those inline
// scripts in a bare Node `vm` context (no fs/process/require exposed, no
// network access granted inside it) to reconstruct the same object the
// browser builds, then read it back out.
//
// There is no separate /fr/situations page (it 404s) - every category,
// subcategory and scenario on the single /ar/situations page already carries
// both French and Arabic fields (label_fr/label_ar, title_fr/title_ar,
// prompt_fr/prompt_ar, explanation_fr/explanation_ar), so one fetch gets
// both languages, same as /ar/infractions.
//
// Usage (from the repo root, e.g. via `npm run scrape-situations`):
//   node scripts/situations/scrape-situations.mjs                 download categories.json + scenarios.json
//   node scripts/situations/scrape-situations.mjs --media          also download every scenario image
//   node scripts/situations/scrape-situations.mjs --out=./data/situations  output directory (default ./data/situations)
//   node scripts/situations/scrape-situations.mjs --media-out=./files/situations  media output dir (default ./files/situations)

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const SITUATIONS_DIR = path.resolve(args.out ?? "./data/situations");
const MEDIA_DIR = path.resolve(args["media-out"] ?? "./files/situations");
const DOWNLOAD_MEDIA = Boolean(args.media);
const MEDIA_CONCURRENCY = 6;

const BASE = "https://conduire.ma";
const PAGE_URL = `${BASE}/ar/situations`;
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

// Same extraction strategy as the other scrapers, but the thing we're after
// has {categories, scenarios} instead of {questions} or {sections, signs}.
function extractSituationsFromHtml(html) {
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
    vm.runInContext(code, sandbox, { timeout: 5000, filename: "situations.js" });
  } catch (err) {
    console.warn(`  (non-fatal hydration error, continuing: ${err.message})`);
  }

  const table = sandbox.$R && sandbox.$R.tsr;
  if (!Array.isArray(table)) {
    throw new Error("hydration table ($R.tsr) not found after running scripts");
  }

  const data = table.find(
    (v) => v && typeof v === "object" && Array.isArray(v.categories) && Array.isArray(v.scenarios)
  );
  if (!data) {
    throw new Error("no object with categories[]/scenarios[] arrays found in hydration table");
  }

  return data;
}

async function downloadMedia(urls, mediaDir) {
  await fs.mkdir(mediaDir, { recursive: true });
  let i = 0;
  let done = 0,
    skipped = 0,
    failed = 0;

  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      const filename = decodeURIComponent(new URL(url).pathname.split("/").pop());
      const dest = path.join(mediaDir, filename);
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
  await fs.mkdir(SITUATIONS_DIR, { recursive: true });

  console.log(`Fetching ${PAGE_URL} ...`);
  const html = await fetchText(PAGE_URL);
  const { categories, scenarios } = extractSituationsFromHtml(html);

  await fs.writeFile(
    path.join(SITUATIONS_DIR, "categories.json"),
    JSON.stringify(categories, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(SITUATIONS_DIR, "scenarios.json"),
    JSON.stringify(scenarios, null, 2),
    "utf8"
  );

  console.log(`\n--- Summary ---`);
  console.log(`Categories: ${categories.length}`);
  console.log(`Scenarios: ${scenarios.length}`);
  console.log(`Output: ${SITUATIONS_DIR}`);

  if (DOWNLOAD_MEDIA) {
    const urls = [...new Set(scenarios.map((s) => s.image).filter(Boolean))];
    console.log(`\nDownloading ${urls.length} unique scenario images ...`);
    await downloadMedia(urls, MEDIA_DIR);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
