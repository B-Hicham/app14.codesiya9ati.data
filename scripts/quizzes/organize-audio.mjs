// Consolidates all quiz narration audio into its own folder (files/audio/),
// separate from the mixed image+audio files/quizzes/quiz_N/ folder, and
// records each question's local mp3 path back into data/quizzes/quiz_*.json
// (plus the all_quizzes.json / all_questions.json aggregates) as a new "mp3"
// field, right after "audio".
//
// Reuses files already downloaded under files/quizzes/quiz_N/ when present
// (plain copy, no network hit); falls back to fetching from the question's
// "audio" URL otherwise. Questions with no narration (audio: "") get mp3: "".
//
// Usage (from the repo root, e.g. via `npm run organize-audio`):
//   node scripts/quizzes/organize-audio.mjs
//   node scripts/quizzes/organize-audio.mjs --concurrency=8
//   node scripts/quizzes/organize-audio.mjs --out=./files/audio

import fs from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const QUIZ_DIR = path.resolve(args.quizzes ?? "./data/quizzes");
const EXISTING_MEDIA_DIR = path.resolve(args.existing ?? "./files/quizzes");
const AUDIO_DIR = path.resolve(args.out ?? "./files/audio");
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

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// Rebuilds a question object with "mp3" inserted right after "audio"
// (falls back to appending it if the question has no "audio" key).
function withMp3(q, mp3) {
  const out = {};
  for (const [k, v] of Object.entries(q)) {
    out[k] = v;
    if (k === "audio") out.mp3 = mp3;
  }
  if (!("mp3" in out)) out.mp3 = mp3;
  return out;
}

async function main() {
  const files = (await fs.readdir(QUIZ_DIR))
    .filter((f) => /^quiz_\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (files.length === 0) throw new Error(`No quiz_*.json files found in ${QUIZ_DIR}`);

  const jobs = []; // { url, existing, dest }
  const quizzesById = new Map(); // id -> { file, quiz }

  for (const file of files) {
    const quiz = JSON.parse(await fs.readFile(path.join(QUIZ_DIR, file), "utf8"));
    const quizAudioDir = path.join(AUDIO_DIR, `quiz_${quiz.id}`);

    quiz.questions = quiz.questions.map((q) => {
      if (!q.audio) return withMp3(q, "");
      const filename = decodeURIComponent(new URL(q.audio).pathname.split("/").pop());
      const dest = path.join(quizAudioDir, filename);
      const existing = path.join(EXISTING_MEDIA_DIR, `quiz_${quiz.id}`, filename);
      const mp3Path = toPosix(path.relative(process.cwd(), dest));
      jobs.push({ url: q.audio, existing, dest });
      return withMp3(q, mp3Path);
    });

    quizzesById.set(quiz.id, { file, quiz });
  }

  console.log(`Found ${jobs.length} audio files to place across ${files.length} quizzes.`);

  const dirs = new Set(jobs.map((j) => path.dirname(j.dest)));
  for (const dir of dirs) await fs.mkdir(dir, { recursive: true });

  let copied = 0, downloaded = 0, skipped = 0, failed = 0;
  let i = 0;

  async function worker() {
    while (i < jobs.length) {
      const idx = i++;
      const { url, existing, dest } = jobs[idx];
      try {
        await fs.access(dest);
        skipped++;
        continue;
      } catch {
        /* not present yet */
      }
      try {
        await fs.copyFile(existing, dest);
        copied++;
        continue;
      } catch {
        /* not present locally, fall through to network fetch */
      }
      try {
        const buf = await fetchBuffer(url);
        await fs.writeFile(dest, buf);
        downloaded++;
      } catch (err) {
        failed++;
        console.error(`  ! failed: ${url} (${err.message})`);
      }
      const done = copied + downloaded + skipped + failed;
      if (done % 200 === 0) {
        console.log(`  progress: ${done}/${jobs.length} (copied ${copied}, downloaded ${downloaded}, skipped ${skipped}, failed ${failed})`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const { file, quiz } of quizzesById.values()) {
    await fs.writeFile(path.join(QUIZ_DIR, file), JSON.stringify(quiz, null, 2), "utf8");
  }

  const allQuizzes = [...quizzesById.values()].map((v) => v.quiz).sort((a, b) => a.id - b.id);
  const allQuestions = [];
  for (const quiz of allQuizzes) {
    for (const q of quiz.questions) {
      allQuestions.push({ quizId: quiz.id, quizTitle: quiz.title, ...q });
    }
  }
  await fs.writeFile(path.join(QUIZ_DIR, "all_quizzes.json"), JSON.stringify(allQuizzes, null, 2), "utf8");
  await fs.writeFile(path.join(QUIZ_DIR, "all_questions.json"), JSON.stringify(allQuestions, null, 2), "utf8");

  console.log("\n--- Audio organize summary ---");
  console.log(`Total audio files: ${jobs.length}`);
  console.log(`Copied from files/quizzes: ${copied}`);
  console.log(`Downloaded from network: ${downloaded}`);
  console.log(`Already present (skipped): ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Output: ${AUDIO_DIR}`);
  console.log(`Updated ${files.length} quiz_*.json files + all_quizzes.json + all_questions.json with an "mp3" field.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
