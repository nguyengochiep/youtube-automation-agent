# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # also fetches the bundled ffmpeg-static binary
npm start            # Express server + dashboard on http://localhost:3456
npm test             # ~45 system tests in test.js, no credentials needed
npm run lint         # eslint — CI runs lint + test on every push/PR to master
npm run walkthrough  # guided credential setup (npm run setup is the shorter classic flow)
npm run scheduler    # cron automation standalone
npm run agent:script # run a single agent directly (agent:strategy|script|thumbnail|seo|production|publishing|analytics)
```

Operator helpers in `scripts/` (not wired into npm scripts):

```bash
node scripts/scenes.js list                              # productions with ids and review status
node scripts/scenes.js prompts <productionId> --out f.txt # the image prompt the pipeline wrote per scene
node scripts/scenes.js upload  <productionId> <imageDir>  # hand-made stills in, rebuild out
node scripts/remix-audio.js <in.mp4> [out.mp4]            # re-normalise and re-bed audio on a locked production
node scripts/rebuild-video.js <productionId> [out.mp4]    # full rebuild: re-time to narration, level takes, reassemble
node scripts/description.js <productionId> [--out f.txt]  # YouTube description with chapters timed off the scene manifest
```

`description.js` exists because `SEOOptimizerAgent` lays chapters out on a fixed
grid before any narration is recorded, so both `seo.chapters` and the timestamps
it appends to `seo.description` run past the end of the finished file. It
accumulates chapter starts from scene `duration` instead, publishes only
`verified` provenance sources, and caps hashtags at the three YouTube actually
renders.

The last two exist because **scene repair is locked once content is approved or
scheduled** (`getEditableBundle`). That gate is deliberate — published output must
not change underneath its review — so correcting an already-published video means
rebuilding outside the pipeline, never deleting the schedule row to unlock it.

**Running one test:** `test.js` has no filter flag. Every check is a `SystemTest` method, so run one with:

```bash
node -e "const {SystemTest}=require('./test.js');new SystemTest().testSceneRepairStudio().then(()=>console.log('ok'),e=>{console.error(e);process.exit(1)})"
```

Tests open the **real** `data/youtube_automation.db` (each constructs `new Database()` with no override) and write rows into it. Test data is prefixed/cleaned by convention, not isolated — expect side effects on the local dev database.

New tests go in `test.js` as a `SystemTest` method plus an entry in the `tests` array in `runAllTests()`. CONTRIBUTING requires a regression test for every bug fix.

## Architecture

Node 18+ CommonJS. Single Express process (`index.js`, ~1800 lines) that owns the SQLite database, the seven agents, the long-running services, and every HTTP route. There is no build step and no framework on the client — `dashboard/` is vanilla JS served statically.

### The generation pipeline

`index.js#generateContent` runs six stages in fixed order, each wrapped by `runGenerationStage` → `GenerationRecoveryService.run`:

```
strategy → script → thumbnail → seo → production → quality_review
```

The stage list lives in `utils/generation-recovery-service.js` (`GENERATION_STAGES`) and is the source of truth. Each stage writes a `generation_checkpoints` row with its artifact; on resume, a completed checkpoint is revalidated against the filesystem and reused, and every *later* checkpoint is deleted. Adding or reordering a stage means updating that array, the resume UI, and the artifact validator together.

Jobs are tracked in `generation_jobs` and in the in-memory `this.activeJobs` map, capped by `MAX_CONCURRENT_JOBS` (default 1). Cancellation is cooperative: `updateJobStage` reads `cancelRequested` from the DB and throws `JOB_CANCELLED`.

### Agents and services

`agents/*.js` — one class per pipeline stage, each constructed with `(db, credentials)` and each instantiating its own `AITextService`. They are stateless between runs; all durable state goes through the database.

`utils/*-service.js` — the studios layered on top of a finished production: scene repair, shorts repurposing, provenance, discoverability, growth experiments, audience engagement, retention, readiness, recovery, channel learning. Each takes `(db, ...deps, { logger })` and is wired in `YouTubeAutomationAgent.initialize()`. `AutonomousChannelOperator` sits above the pipeline and is injected with callbacks (`researchAndPlan`, `startGenerationJob`, `resumeGenerationJob`, `notify`) rather than holding a reference to the agent — keep that inversion when extending it.

### Database

`database/db.js` is a single 2900-line class: schema (~40 `CREATE TABLE IF NOT EXISTS` statements in `createTables()`, applied on every boot — migrations are additive only) plus every query method. Generic helpers are `executeQuery`, `getRow`, `getAllRows`, and `generateId(prefix)`. JSON columns are stringified on write and parsed on read inside the accessor; callers see objects.

### Configuration precedence

Runtime settings resolve `process.env` → `settings` table → hardcoded default (see `MediaGenerationService.settings()` for the canonical pattern). Provider credentials live in `config/credentials.json` (gitignored) written by `CredentialManager`, with `.env` keys as fallback. `.env.example` documents every variable.

### Provider abstraction

Text: `utils/ai-text-service.js` — a `PROVIDERS` table of OpenAI-compatible endpoints (openai, openrouter, kimi, mimo, glm) plus a separate Gemini SDK path. Adding a provider is a table entry. `generateText` retries transient failures (429/5xx, "high demand", network) and drops `temperature` when a reasoning model rejects it; both exist because every agent turns a thrown error into silent boilerplate that still passes the checkpoint validator and the quality checks.

Provider placement matters and is easy to get wrong:

- `credentials.aiProvider` selects the **text** provider only. `AIVideoGenerator` reads `credentials.openai` and `process.env.OPENAI_API_KEY` separately, so putting an OpenAI key there — or in `.env` — silently moves TTS and images off Gemini onto paid OpenAI.
- Reasoning models (the `gpt-5` family) return an empty response at the `max_completion_tokens: 1800` hard-coded in `agents/script-writer-agent.js`, because the budget is spent on hidden reasoning.
- **`npm run walkthrough` rewrites `config/credentials.json` from what it holds in memory and drops `aiProvider`.** Re-add it afterwards.

Video: `utils/video-providers.js` — `VideoProviderRegistry` with `DEFAULT_PROVIDER_ORDER` falling back through remote providers to the local FFmpeg `slideshow`, which is always available. `MediaGenerationService` polls remote tasks and persists them in `media_generation_tasks`.

## Invariants

These are enforced in many places and are the point of the product — do not weaken them to make a test or a flow pass.

- **Simulated output can never publish.** Any placeholder asset carries `simulated: true`. `OperatorService.runQualityChecks` fails the blocking `video` check on it, `PublishingSchedulingAgent` refuses to schedule it, and analytics/learning/experiments discard simulated samples so they never form a baseline. Grep `simulated` before touching asset or publishing code.
- **Approval-first.** Nothing schedules until quality checks pass, provenance claims are resolved, media rights are attested, and a human approves. Quality checks distinguish blocking from advisory (`check(id, passed, message, blocking = true)`).
- **Fail-closed narration and publishing.** Missing/stale/failed narration blocks approval; intentional silence requires an explicit confirmation plus a ≥10-character stored reason. If an upload may have reached YouTube without returning a video ID, reconciliation is required before retrying.
- **Missing evidence is never zero.** Unavailable revenue, cost, or analytics data is surfaced as unavailable, not defaulted.
- **Learnings and recommendations stay pending** until an operator approves them; only then do they influence planning.
- **Automated generation goes through the readiness gate** — `readiness.assertReady()` throws a 409 for `scheduler` and `autonomous_operator` sources when the last check recorded a blocking failure. Manual work stays available.
- **Assembled audio is levelled, not raw.** Scene takes are normalised to `SCENE_TARGET_LUFS` before they are joined (`buildNarrationFilters`) and the finished mix is normalised to `AUDIO_TARGET_LUFS` at the mux (`buildLoudnormFilter`). YouTube only attenuates loud uploads, so anything quieter than -14 LUFS simply plays quieter than the rest of a viewer's feed, and takes recorded at different times drift far enough apart to be audible mid-video.
- **Scene timings follow the narration, not a word count.** `initializeAudioSegments` scales the estimated durations so they sum to the recording that exists. Without it the later slices start past the end of the audio and come back empty, and the video holds stills over silence.
- **Every rendered MP4 is streamable.** Video chains carry `setsar=1` before `concat` (stills of differing pixel dimensions otherwise refuse to configure and nothing is written) and every output carries `-movflags +faststart` (otherwise the review player cannot show a frame until the whole file has downloaded).

## API surface

All routes are registered in `index.js#setupAPI`. Mutating routes are wrapped in `requireAPIKey()`, which is a **no-op when `API_KEY` is unset** (logged as a warning at boot); the dashboard stores the key in `localStorage` and sends `x-api-key`. Read routes are unprotected. Route shape is `/api/<resource>/:id/<action>` returning `{ success, ... }`.

## Conventions

- User-facing strings — errors, log lines, dashboard copy — are full sentences that say what to do next. Match that tone; it is a product surface, not debug output.
- `new Logger('ComponentName')` per class; winston writes `logs/combined.log`, `logs/error.log`, and a per-component log.
- Commits are conventional (`feat:`, `fix:`, `docs:`, `test:`). CONTRIBUTING: one concern per PR, never regenerate `package-lock.json` unless the PR is about dependencies, rebase on `master`.
- The optional DarkzSEO discoverability adapter (`utils/discoverability-adapters/darkzseo.js`) spawns Python shell-free with JSON over stdin/stdout and no inherited API secrets. Missing Python, timeouts, and schema drift must stay explicit and non-blocking.
