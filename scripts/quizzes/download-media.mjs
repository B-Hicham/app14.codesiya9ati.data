// Downloads the image/audio files referenced by the already-scraped
// data/quizzes/quiz_*.json files (produced by scrape-quizzes.mjs).
//
// Kept separate from scrape-quizzes.mjs so that re-running media downloads
// (e.g. after an interrupted run) doesn't require re-fetching all 91 quiz
// pages from conduire.ma - we already have the media URLs on disk.
//
// Usage (from the repo root, e.g. via `npm run download-media`):
//   node scripts/quizzes/download-media.mjs                 download everything referenced under data/quizzes
//   node scripts/quizzes/download-media.mjs --concurrency=8
//   node scripts/quizzes/download-media.mjs --out=./files/quizzes

import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const QUIZ_DIR = path.resolve(args.quizzes ?? "./data/quizzes");
const MEDIA_DIR = path.resolve(args.out ?? "./files/quizzes");
const CONCURRENCY = Number(args.concurrency ?? 6);

const USER_AGENT =
  "Mozilla/5.0 (compatible; ConduireQuizScraper/1.0; personal/educational use; +mailto:hichamboubrahim4040@gmail.com)";

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

async function main() {
  const files = (await fs.readdir(QUIZ_DIR)).filter((f) => /^quiz_\d+\.json$/.test(f));
  if (files.length === 0) throw new Error(`No quiz_*.json files found in ${QUIZ_DIR}`);

  // url -> destination path (dedup across quizzes just in case)
  const jobs = new Map();
  for (const file of files) {
    const quiz = JSON.parse(await fs.readFile(path.join(QUIZ_DIR, file), "utf8"));
    const dir = path.join(MEDIA_DIR, `quiz_${quiz.id}`);
    for (const q of quiz.questions) {
      for (const url of [q.image, q.image_1, q.audio]) {
        if (!url) continue;
        const filename = decodeURIComponent(new URL(url).pathname.split("/").pop());
        jobs.set(url, path.join(dir, filename));
      }
    }
  }

  console.log(`Found ${jobs.size} unique media files across ${files.length} quizzes.`);

  const dirs = new Set([...jobs.values()].map((p) => path.dirname(p)));
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });

  const entries = [...jobs.entries()];
  let done = 0, skipped = 0, failed = 0;
  let i = 0;

  async function worker() {
    while (i < entries.length) {
      const idx = i++;
      const [url, dest] = entries[idx];
      try {
        await fs.access(dest);
        skipped++;
        continue;
      } catch {
        /* not present yet */
      }
      try {
        const buf = await fetchBuffer(url);
        await fs.writeFile(dest, buf);
        done++;
      } catch (err) {
        failed++;
        console.error(`  ! failed: ${url} (${err.message})`);
      }
      if ((done + skipped + failed) % 200 === 0) {
        console.log(`  progress: ${done + skipped + failed}/${entries.length} (downloaded ${done}, skipped ${skipped}, failed ${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("\n--- Media download summary ---");
  console.log(`Total unique files: ${entries.length}`);
  console.log(`Downloaded: ${done}`);
  console.log(`Already present (skipped): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Output: ${MEDIA_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
