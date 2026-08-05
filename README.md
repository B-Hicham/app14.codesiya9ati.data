# conduire.ma scrapers

Scrapes public "permis de conduire" content from https://conduire.ma for
reuse in the permis Maroc app:

- **Quizzes** (`/quiz/:id`, 1-91): question images, audio narration, correct
  answers, explanations.
- **Road signs / panneaux** (`/ar/panneaux`): every sign catalogued on the
  site (title, meaning in FR/AR, category, section, image(s)).
- **Glossary / lexique** (`/ar/lexique`): 361 driving terms in French, Arabic
  (Fusha) and Arabic (Darija).
- **Infractions** (`/ar/infractions`): the official violations/fines/points
  table - tiers (fine classes), categories, tags and 160 infractions, each in
  French and Arabic.
- **Situations** (`/ar/situations`): 36 illustrated driving scenarios
  ("mawaqif") - an image, a yes/no-style question and an explanation, each in
  French and Arabic.

## How it works

`/quiz/:id`, `/ar/panneaux`, `/ar/lexique`, `/ar/infractions` and
`/ar/situations` are all server-rendered and embed their full data payload
directly in the HTML as inline `<script>` tags (a TanStack Start/seroval
hydration blob), not via an XHR/API call. Each scraper fetches the plain
HTML, runs just those inline scripts in an isolated Node `vm` sandbox (no
fs/network access from inside it) to reconstruct the same data object the
browser builds, then reads it back out. No private/internal endpoints are
touched - `/_serverFn/` is explicitly disallowed by `robots.txt` and is never
used; only public pages are fetched.

Unlike the quizzes (91 separate pages, walked by id), `/ar/panneaux`,
`/ar/lexique`, `/ar/infractions` and `/ar/situations` are each a single page
that already embeds all of its data, so those scrapers just fetch once - no
id range to walk. There is no separate `/fr/infractions` or `/fr/situations`
page (both 404) - every record on those `/ar/...` pages already carries both
`*_fr` and `*_ar` fields, so the one Arabic-URL page yields both languages.

## Usage

```
npm run scrape                 # re-scrape all quiz JSON into data/quizzes
npm run download-media         # download every image/audio referenced by data/quizzes, into files/quizzes
npm run organize-audio         # split narration mp3s into their own files/audio folder + record "mp3" path in data/quizzes
npm run scrape-panneaux        # scrape data/panneaux/{sections,signs}.json + all sign images into files/panneaux
npm run scrape-lexique         # scrape data/lexique/terms.json
npm run scrape-infractions     # scrape data/infractions/{tiers,categories,tags,infractions}.json
npm run scrape-situations      # scrape data/situations/{categories,scenarios}.json + all scenario images into files/situations
```

All scripts are resumable - re-running skips quizzes/files already on disk.

## Layout

The project is organized by section - `quizzes`, `panneaux`, `lexique`,
`infractions`, `situations` - mirrored under `scripts/`, `data/` and `files/`.
`scripts/` holds the scraper source, `data/` holds pure JSON (no binaries),
and `files/` holds every downloaded media asset (images/audio), kept out of
`data/` so the JSON tree stays small and easy to diff/version:

```
scripts/
  quizzes/
    scrape-quizzes.mjs      # scrape quiz JSON from /quiz/:id
    download-media.mjs      # (re-)download media referenced by data/quizzes/quiz_*.json
    organize-audio.mjs      # split narration mp3s into files/audio + record "mp3" path in data/quizzes/quiz_*.json
  panneaux/
    scrape-panneaux.mjs     # scrape section/sign JSON + media from /ar/panneaux
  lexique/
    scrape-lexique.mjs      # scrape glossary terms from /ar/lexique
  infractions/
    scrape-infractions.mjs  # scrape tiers/categories/tags/infractions from /ar/infractions
  situations/
    scrape-situations.mjs   # scrape category/scenario JSON + media from /ar/situations

data/
  quizzes/
    quiz_1.json ... quiz_91.json   # one file per quiz
    all_quizzes.json               # all 91 quizzes combined
    all_questions.json             # flat list of all 3640 questions
  panneaux/
    sections.json                          # the 5 top-level sign sections (id, folder, title FR/AR, count)
    signs.json                             # all 253 signs, flat
  lexique/
    terms.json                             # all 361 glossary terms, flat
  infractions/
    tiers.json                             # the 4 fine classes (1ere/2eme/3eme classe, delits)
    categories.json                        # the 10 infraction categories
    tags.json                              # the 48 cross-cutting tags (vehicle/context/equipment/...)
    infractions.json                       # all 160 infractions, flat
  situations/
    categories.json                        # the 5 scenario categories (each with subcategories + counts)
    scenarios.json                         # all 36 scenarios, flat

files/
  quizzes/
    quiz_1/quiz_1_1.jpg, quiz_1_1_1.jpg, quiz_s_1_1.mp3, ...
    quiz_2/...
    ...
  audio/
    quiz_1/quiz_s_1_1.mp3, ...   # same mp3s as files/quizzes, split out audio-only (see organize-audio.mjs)
    quiz_2/...
    ...
  panneaux/
    khatar-asba9ia/sign_p1_1.png, ...    # one subfolder per section "folder" slug
    louihat/...
    alman3/...
    ijbar/...
    mawaqi3/...
  situations/
    maw_01.jpg, maw_02.jpg, ...          # one flat folder, all scenarios share the same assets path
```

Every scraper's default output directories can be overridden with
`--out=<data dir>` and `--media-out=<files dir>` (see each script's header
comment for exact flag names).

Each question object:

```jsonc
{
  "id": 1,
  "image": "https://assets.conduire.ma/quizzes/quiz_1/quiz_1_1.jpg",
  "image_1": null,                // second frame for blinking-signal questions, else null
  "audio": "https://assets.conduire.ma/quizzes/quiz_1/quiz_s_1_1.mp3", // "" if quiz has no narration
  "mp3": "files/audio/quiz_1/quiz_s_1_1.mp3", // local copy of "audio", relative to repo root; "" if no narration
  "description": "...",           // Arabic (Darija) scenario text
  "answer": [2],                  // correct option number(s), 1-indexed across all optionGroups
  "explanation": "...",
  "optionGroups": [{ "options": ["نعم", "لا"] }]
}
```

Each sign object:

```jsonc
{
  "key": "1.1.1",                  // "<section_id>.<category_id>.<item_id>"
  "section_id": 1,
  "category_id": 1,
  "item_id": 1,
  "slug": "warning-sharp-turn-right",
  "title_fr": "Virage à droite",
  "title_ar": "خطر منعرج لليمين",
  "meaning_fr": "Réduisez votre vitesse et serrez à droite car un virage à droite se trouve devant vous.",
  "meaning_ar": "نقص من السرعة وشد اليمين ديالك حيت كاين فيراج داير لليمين قدامك",
  "images": ["https://assets.conduire.ma/signs/khatar-asba9ia/sign_p1_1.png"], // some signs have 2 (e.g. panonceau + main sign)
  "category_title_fr": "Signaux de danger",
  "category_title_ar": "عالمات الخطر",
  "section_title_fr": "Signaux de danger et de priorité",
  "section_title_ar": "علامات الخطر والأسبقية"
}
```

Each glossary term:

```jsonc
{
  "fr": "Adhérence",              // French term
  "ac": "التحام العجالت على الطريق", // Arabic - Fusha/standard
  "ad": "التحام العجالت بالطريق"     // Arabic - Darija (Moroccan dialect)
}
```

Each infraction object:

```jsonc
{
  "id": "inf_c1_002",
  "tier_id": "classe_1",                    // links to tiers.json (fine amount/points)
  "narsa_original_id": 2,                   // id in the official NARSA violations table
  "points": 4,                              // points deducted from the license
  "title_fr": "Non respect de l'arrêt imposé par un panneau de stop",
  "title_ar": "عدم احترام الوقوف المفروض بعلامة قف",
  "description_fr": "Le non respect par un conducteur d'un véhicule de l'arrêt imposé par un panneau de stop.",
  "description_ar": "عدم احترام الوقوف المفروض بعلامة قف من طرف سائق مركبة",
  "category": "priority",                   // links to categories.json
  "subcategory": "priority.signs",
  "tags": ["intersection"],                 // links to tags.json
  "consumer_relevance": "high",
  "related_signs": ["stop", "stop-arabic"]  // slugs matching panneaux signs.json
}
```

Each situation/scenario object:

```jsonc
{
  "id": "maw_02",
  "order": 2,
  "image": "https://assets.conduire.ma/mawaqif/images/maw_02.jpg",
  "title_fr": "Dépassement sur ligne discontinue",
  "title_ar": "التجاوز في خط متقطع",
  "prompt_fr": "La voiture bleue est-elle autorisée à dépasser la voiture rouge ?",
  "prompt_ar": "واش السيارة الزرقاء مسموح ليها تتجاوز السيارة الحمراء؟",
  "explanation_fr": "Oui, la voiture bleue est autorisée à dépasser car la ligne au milieu de la chaussée est discontinue et non continue.",
  "explanation_ar": "نعم، مسموح للسيارة الزرقاء تتجاوز حيت الخط لي فوسط الطريق متقطع وماشي متصل.",
  "category": "overtaking",              // links to categories.json
  "subcategory": "overtaking.procedure", // links to categories[].subcategories[]
  "tags": ["dashed-line"]
}
```

## Known gaps in the source data (not scraper bugs, verified against the live site)

- Quizzes 33-42 (400 questions) have `audio: ""` for every question - conduire.ma
  simply has no narration recorded for that batch.
- 28 media files are `.gif` rather than `.jpg` (still fetched fine, filenames
  taken as-is from the URL).

## Current stats

- 91 quizzes, 3640 questions
- 6993 unique media files downloaded, ~479 MB total (3725 jpg, 3240 mp3, 28 gif)
- files/audio/ holds a second copy of all 3240 mp3s (~216 MB), split out from files/quizzes/ for standalone audio-only access
- 5 sign sections, 253 signs, 272 unique sign images, ~11 MB total
- 361 glossary terms
- 4 fine tiers, 10 categories, 48 tags, 160 infractions
- 5 situation categories, 36 scenarios, 36 unique scenario images, ~1 MB total
