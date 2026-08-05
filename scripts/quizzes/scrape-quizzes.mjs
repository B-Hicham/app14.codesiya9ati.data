// Scraper for the public quiz data on https://conduire.ma/quiz/:id
//
// Each quiz page is server-rendered (TanStack Start) and embeds the FULL quiz
// payload (title, images, audio, correct answers, explanations) as inline
// <script> tags that hydrate a `$R` reference table in the browser. Rather than
// re-implementing that browser-only hydration (or trying to reach an internal
// /_serverFn/ endpoint, which robots.txt explicitly disallows), we fetch the
// plain HTML, pull out just those inline scripts, and run them in a bare
// Node `vm` context (no fs/process/require exposed) so the same object
// literals the browser would build are produced here, then we read the
// resulting quiz object back out. No network access or file access is
// granted inside that sandbox.
//
// Usage (from the repo root, e.g. via `npm run scrape`):
//   node scripts/quizzes/scrape-quizzes.mjs                 scrape all quizzes (auto-detect range)
//   node scripts/quizzes/scrape-quizzes.mjs --start=1 --end=91
//   node scripts/quizzes/scrape-quizzes.mjs --media         also download every image/audio file
//   node scripts/quizzes/scrape-quizzes.mjs --delay=400     ms delay between requests (default 300)
//   node scripts/quizzes/scrape-quizzes.mjs --out=./data/quizzes   output directory (default ./data/quizzes)
//   node scripts/quizzes/scrape-quizzes.mjs --media-out=./files/quizzes  media output dir (default ./files/quizzes)

import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const START = Number(args.start ?? 1);
const END = args.end ? Number(args.end) : null; // null => auto-detect via 404s
const QUIZZES_DIR = path.resolve(args.out ?? "./data/quizzes");
const MEDIA_DIR = path.resolve(args["media-out"] ?? "./files/quizzes");
const DELAY_MS = Number(args.delay ?? 300);
const DOWNLOAD_MEDIA = Boolean(args.media);
const MAX_CONSECUTIVE_MISSES = 5;
const MEDIA_CONCURRENCY = 5;

const BASE = "https://conduire.ma";
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConduireQuizScraper/1.0; personal/educational use; +mailto:hichamboubrahim4040@gmail.com)";

async function fetchText(url, { retries = 3 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.status === 404) return { status: 404, body: null };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, body: await res.text() };
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(400 * attempt);
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
      await sleep(400 * attempt);
    }
  }
}

// Pull out inline (non-module, no-src) scripts that actually touch the $R
// hydration table, run them in an isolated vm context, and return the quiz
// object (the one with a `.questions` array) that pops out.
function extractQuizFromHtml(html, quizId) {
  const scriptRe = /<script(?![^>]*\ssrc=)(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g;
  const chunks = [];
  let m;
  while ((m = scriptRe.exec(html))) {
    const body = m[1];
    if (body.includes("$R") || body.includes("$_TSR")) chunks.push(body);
  }
  if (chunks.length === 0) {
    throw new Error(`quiz ${quizId}: no hydration <script> blocks found (page structure may have changed)`);
  }

  const code = chunks.join("\n").replaceAll("document.currentScript.remove()", "");

  const sandbox = {};
  sandbox.self = sandbox; // scripts do `self.$R = ...`, `self.$_TSR = ...`
  // Pure, side-effect-free web API constructors some later (irrelevant to us)
  // hydration chunks reference, e.g. a React Query dehydration stream.
  sandbox.ReadableStream = ReadableStream;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  vm.createContext(sandbox);
  try {
    vm.runInContext(code, sandbox, { timeout: 5000, filename: `quiz-${quizId}.js` });
  } catch (err) {
    // A later, unrelated statement (e.g. query-stream plumbing) may throw;
    // the quiz object is usually already assigned by an earlier statement,
    // so keep going and only fail below if we truly can't find it.
    console.warn(`  (quiz ${quizId}: non-fatal hydration error, continuing: ${err.message})`);
  }

  const table = sandbox.$R && sandbox.$R.tsr;
  if (!Array.isArray(table)) {
    throw new Error(`quiz ${quizId}: hydration table ($R.tsr) not found after running scripts`);
  }

  const quiz = table.find((v) => v && typeof v === "object" && Array.isArray(v.questions));
  if (!quiz) {
    throw new Error(`quiz ${quizId}: no object with a questions[] array found in hydration table`);
  }

  return {
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questionCount,
    previewImage: quiz.previewImage,
    source: quiz.source,
    questions: quiz.questions,
  };
}

function collectMediaUrls(quiz) {
  const urls = new Set();
  for (const q of quiz.questions) {
    if (q.image) urls.add(q.image);
    if (q.image_1) urls.add(q.image_1);
    if (q.audio) urls.add(q.audio);
  }
  return [...urls];
}

async function downloadMedia(urls, mediaDir) {
  await fs.mkdir(mediaDir, { recursive: true });
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      const filename = decodeURIComponent(new URL(url).pathname.split("/").pop());
      const dest = path.join(mediaDir, filename);
      try {
        await fs.access(dest);
        continue; // already downloaded, resumable
      } catch {
        /* not present yet, fall through and fetch */
      }
      try {
        const buf = await fetchBuffer(url);
        await fs.writeFile(dest, buf);
      } catch (err) {
        console.error(`  ! media failed: ${url} (${err.message})`);
      }
    }
  }
  await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, worker));
}

async function main() {
  await fs.mkdir(QUIZZES_DIR, { recursive: true });

  const allQuizzes = [];
  const allQuestions = [];
  const failures = [];

  let id = START;
  let consecutiveMisses = 0;

  while (true) {
    if (END !== null && id > END) break;
    if (END === null && consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;

    process.stdout.write(`Quiz ${id}... `);
    try {
      const { status, body } = await fetchText(`${BASE}/quiz/${id}`);
      if (status === 404) {
        console.log("404 (missing)");
        consecutiveMisses++;
        id++;
        await sleep(DELAY_MS);
        continue;
      }
      consecutiveMisses = 0;

      const quiz = extractQuizFromHtml(body, id);
      await fs.writeFile(
        path.join(QUIZZES_DIR, `quiz_${id}.json`),
        JSON.stringify(quiz, null, 2),
        "utf8"
      );

      allQuizzes.push(quiz);
      for (const q of quiz.questions) {
        allQuestions.push({ quizId: quiz.id, quizTitle: quiz.title, ...q });
      }

      console.log(`OK - "${quiz.title}" (${quiz.questions.length} questions)`);

      if (DOWNLOAD_MEDIA) {
        const urls = collectMediaUrls(quiz);
        await downloadMedia(urls, path.join(MEDIA_DIR, `quiz_${id}`));
      }
    } catch (err) {
      console.log(`FAILED (${err.message})`);
      failures.push({ id, error: err.message });
    }

    id++;
    await sleep(DELAY_MS);
  }

  await fs.writeFile(
    path.join(QUIZZES_DIR, "all_quizzes.json"),
    JSON.stringify(allQuizzes, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(QUIZZES_DIR, "all_questions.json"),
    JSON.stringify(allQuestions, null, 2),
    "utf8"
  );

  console.log("\n--- Summary ---");
  console.log(`Quizzes scraped: ${allQuizzes.length}`);
  console.log(`Questions total: ${allQuestions.length}`);
  console.log(`Failures: ${failures.length}`);
  if (failures.length) console.log(failures);
  console.log(`Output: ${QUIZZES_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
