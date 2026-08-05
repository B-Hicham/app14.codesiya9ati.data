// Scraper for the public driving-terms glossary on https://conduire.ma/ar/lexique
//
// Same TanStack Start hydration pattern as the quiz pages and /ar/panneaux
// (see scripts/quizzes/scrape-quizzes.mjs and scripts/panneaux/scrape-panneaux.mjs):
// the full glossary (361 terms) is embedded directly in the HTML as inline
// <script> tags, not fetched via XHR/API. We fetch the plain HTML once, run
// those inline scripts in a bare Node `vm` context (no fs/process/require
// exposed, no network access granted inside it) to reconstruct the same
// array the browser builds, then read it back out. There's no pagination and
// no media - just text - so this is a single fetch.
//
// Usage (from the repo root, e.g. via `npm run scrape-lexique`):
//   node scripts/lexique/scrape-lexique.mjs                       download terms.json
//   node scripts/lexique/scrape-lexique.mjs --out=./data/lexique  output directory (default ./data/lexique)

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const LEXIQUE_DIR = path.resolve(args.out ?? "./data/lexique");

const BASE = "https://conduire.ma";
const PAGE_URL = `${BASE}/ar/lexique`;
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

// Same extraction strategy as extractQuizFromHtml() / extractPanneauxFromHtml(),
// but the thing we're after is a flat array of {fr, ac, ad} terms rather than
// an object with named fields.
function extractLexiqueFromHtml(html) {
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
    vm.runInContext(code, sandbox, { timeout: 5000, filename: "lexique.js" });
  } catch (err) {
    console.warn(`  (non-fatal hydration error, continuing: ${err.message})`);
  }

  const table = sandbox.$R && sandbox.$R.tsr;
  if (!Array.isArray(table)) {
    throw new Error("hydration table ($R.tsr) not found after running scripts");
  }

  const terms = table.find(
    (v) => Array.isArray(v) && v.length > 0 && v.every((o) => o && typeof o === "object" && "fr" in o && "ac" in o && "ad" in o)
  );
  if (!terms) {
    throw new Error("no array of {fr, ac, ad} terms found in hydration table");
  }

  return terms;
}

async function main() {
  await fs.mkdir(LEXIQUE_DIR, { recursive: true });

  console.log(`Fetching ${PAGE_URL} ...`);
  const html = await fetchText(PAGE_URL);
  const terms = extractLexiqueFromHtml(html);

  await fs.writeFile(path.join(LEXIQUE_DIR, "terms.json"), JSON.stringify(terms, null, 2), "utf8");

  console.log(`\n--- Summary ---`);
  console.log(`Terms: ${terms.length}`);
  console.log(`Output: ${LEXIQUE_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
