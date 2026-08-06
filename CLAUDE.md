# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev                  # tsx watch, loads .env
pnpm test                 # vitest run — no network access required
pnpm typecheck            # tsc --noEmit over src, scripts and tests
pnpm lint                 # eslint
pnpm build && pnpm start  # compile to dist/, then run it

pnpm vitest run tests/engine.test.ts             # one file
pnpm vitest run -t 'copies hidden inputs'        # one test by name
pnpm extract-schema --url <url|local.html> --out <path>
```

`pnpm start` has no `--env-file` on purpose: production gets its configuration from the platform, and pointing at a missing `.env` would abort startup. `pnpm build` emits JavaScript only — the `schema.json` files are copied into `dist/` separately by the Dockerfile.

## Design constraints

These are decisions from `docs/IMPLEMENTATION.md` §2, not defaults to improve on:

- **No browser automation.** The forms are plain HTML; submission is one `fetch` POST.
- **No database, queue, Redis or worker.** Storage is one encrypted JSON file; submission completes inside Slack's 3s ack window, synchronously, inside the `view_submission` handler.
- **No separate cache layer.** The module-level object in `store/profiles.ts` *is* the cache.
- **No slash commands.** The entry point is the App Home tab; there is no `commands` scope.
- **Single process.** Two instances would diverge — the in-memory store is authoritative.
- **No workspace allowlist.** Deliberately dropped from `IMPLEMENTATION.md` §7.5: the bot token already scopes the app to one workspace and the app is not distributed. Reinstate a Bolt global middleware only if the app is ever distributed or org-deployed.
- **All code, identifiers, Slack UI strings, log messages, comments and commit messages in English.** `docs/PLAN.md` is the only Korean file.

## Architecture

Everything form-specific lives behind `FormDefinition` (`src/forms/types.ts`). The engine, the profile store, the Home tab and the handlers are written against that interface and never name a form.

```
slack/handlers.ts ──> formstack/engine.ts ──> the form
        │                     │
        │                     └── forms/registry.ts ──> forms/pto/{schema.json, index.ts, modal.ts}
        └──> store/profiles.ts ──> DATA_FILE   (AES-256-GCM, one entry per user)
```

**Never write `if (formId === 'pto')` in shared code.** If it seems necessary, the interface is wrong — fix the interface. Adding the expense form must be one directory plus one registry entry, with no edit to `engine.ts`, `home.ts`, `handlers.ts`, `messages.ts`, `profiles.ts`, the Dockerfile or the env schema. `tests/handlers.test.ts` asserts this by registering a second form at runtime.

A `Profile` is defined in terms of meaning (`fullName`, `managerEmail`), never field names. Each form's `schema.json` maps those keys onto its own Formstack field IDs, which is what lets one profile serve every form. A field only one form needs goes on `ProfileSchema` as `.optional()` — never fork the profile per form.

### Submission algorithm (`formstack/engine.ts`)

Four steps, in order, none optional:

1. GET the form page (10s timeout).
2. Copy every hidden input **verbatim, empty values included** — some are session tokens, some are honeypots that must stay empty — then verify every non-optional mapped field is still present on the page. This check is the only thing that detects a renamed field; the server discards unknown fields and answers 200.
3. Build the body: profile fields, then `form.toFieldValues(request)`, with dates converted here and nowhere else.
4. **Decide from `successMarker` only.** Formstack returns 200 for validation errors, so the status code decides nothing. Neither marker nor `.fsError` nodes → `unconfirmed`, which is genuinely ambiguous and must never be phrased as "try again".

`withRetry` retries `network` only. `rejected`, `schema` and `unconfirmed` are deterministic or dangerous to repeat.

### Slack conventions

- Input `action_id` equals the schema key it populates (`leaveType`), so `flattenValues` produces an object zod can parse directly. `blockIdFor` derives the block from the key (`leave_type_block`) — inline errors are addressed by block.
- `ack()` first in every action handler; `trigger_id` expires in 3 seconds.
- Errors the user can fix go inline (modal stays open, input intact). Errors the operator must fix go to a DM, because `response_action: errors` is plain text and cannot carry the form link or the copy-paste fallback block.
- **The Home tab does not refresh itself.** Every path that mutates a profile must call `refreshHome`. Omitting it is invisible locally, because reopening the app re-renders.

## Dates

Calendar dates stay `YYYY-MM-DD` strings end to end. **Never introduce `Date` objects** — these are dates, not instants, and a timezone can only make them wrong. Conversion to the form's format happens once, in `setDateField`.

## Tests

`tests/engine.test.ts` runs against a **synthetic** form definition (`tests/helpers/syntheticForm.ts`), not `ptoForm`. If the engine only passes for PTO, the abstraction is leaking. Every form is served by a local HTTP server; **never point a test at a real form** — each accidental submission is a real request a human has to cancel. `tests/fixtures/pto-form.html` is the committed snapshot.

## Current state

`src/forms/pto/schema.json` is a **placeholder** derived from the hand-written fixture, marked by a `$comment` field. Field names, date format, option values and the success marker must be confirmed against the live form before any real submission — see "Before first use" in `README.md`. Do not attempt to infer them.
