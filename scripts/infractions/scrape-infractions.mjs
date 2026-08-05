// Scraper for the public traffic-violations table on https://conduire.ma/ar/infractions
//
// Same TanStack Start hydration pattern as the other scrapers (see
// scripts/quizzes/scrape-quizzes.mjs, scripts/panneaux/scrape-panneaux.mjs,
// scripts/lexique/scrape-lexique.mjs): the full payload is embedded directly
// in the HTML as inline <script> tags, not fetched via XHR/API. We fetch the
// plain HTML once, run those inline scripts in a bare Node `vm` context (no
// fs/process/require exposed, no network access granted inside it) to
// reconstruct the same object the browser builds, then read it back out.
//
// There is no separate /fr/infractions page (it 404s) - every tier, category,
// tag and infraction on the single /ar/infractions page already carries both
// French and Arabic fields (label_fr/label_ar, title_fr/title_ar,
// description_fr/description_ar), so one fetch gets both languages.
//
// Usage (from the repo root, e.g. via `npm run scrape-infractions`):
//   node scripts/infractions/scrape-infractions.mjs                          download tiers/categories/tags/infractions.json
//   node scripts/infractions/scrape-infractions.mjs --out=./data/infractions output directory (default ./data/infractions)

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const INFRACTIONS_DIR = path.resolve(args.out ?? "./data/infractions");

const BASE = "https://conduire.ma";
const PAGE_URL = `${BASE}/ar/infractions`;
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

// Same extraction strategy as the other scrapers, but the thing we're after
// has {tiers, categories, tags, infractions} instead of {questions} or
// {sections, signs}.
function extractInfractionsFromHtml(html) {
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
    vm.runInContext(code, sandbox, { timeout: 5000, filename: "infractions.js" });
  } catch (err) {
    console.warn(`  (non-fatal hydration error, continuing: ${err.message})`);
  }

  const table = sandbox.$R && sandbox.$R.tsr;
  if (!Array.isArray(table)) {
    throw new Error("hydration table ($R.tsr) not found after running scripts");
  }

  const data = table.find(
    (v) =>
      v &&
      typeof v === "object" &&
      Array.isArray(v.tiers) &&
      Array.isArray(v.categories) &&
      Array.isArray(v.infractions)
  );
  if (!data) {
    throw new Error("no object with tiers[]/categories[]/infractions[] arrays found in hydration table");
  }

  return data;
}

async function main() {
  await fs.mkdir(INFRACTIONS_DIR, { recursive: true });

  console.log(`Fetching ${PAGE_URL} ...`);
  const html = await fetchText(PAGE_URL);
  const { tiers, categories, tags, infractions } = extractInfractionsFromHtml(html);

  for (const [name, value] of Object.entries({ tiers, categories, tags, infractions })) {
    await fs.writeFile(path.join(INFRACTIONS_DIR, `${name}.json`), JSON.stringify(value, null, 2), "utf8");
  }

  console.log(`\n--- Summary ---`);
  console.log(`Tiers: ${tiers.length}`);
  console.log(`Categories: ${categories.length}`);
  console.log(`Tags: ${tags.length}`);
  console.log(`Infractions: ${infractions.length}`);
  console.log(`Output: ${INFRACTIONS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
