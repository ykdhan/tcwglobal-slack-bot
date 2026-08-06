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
pnpm vitest run -t 'echoes back the values'      # one test by name
pnpm extract-schema --url <url|local.html> --out <path>
```

`pnpm start` has no `--env-file` on purpose: production gets its configuration from the platform, and pointing at a missing `.env` would abort startup. `pnpm build` emits JavaScript only — the `schema.json` files are copied into `dist/` separately by the Dockerfile.

## Design constraints

These are decisions from `docs/IMPLEMENTATION.md` §2, not defaults to improve on:

- **No browser automation.** The form page is JS-rendered, but the submission it builds is one ordinary multipart POST with no CSRF token, CAPTCHA or session cookie — verified against a real payload. A browser would cost seconds and gigabytes to assemble the same request.
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

A `Profile` is defined in terms of meaning (`firstName`, `supervisorEmail`), never field names. Each form's `schema.json` maps those keys onto its own Formstack field IDs, which is what lets one profile serve every form. A field only one form needs goes on `ProfileSchema` as `.optional()` — never fork the profile per form.

### Submission algorithm (`formstack/engine.ts`)

Four steps, in order, none optional:

1. GET the form page (10s timeout).
2. Parse the `FSForm.render(...)` JSON embedded in it (`formstack/formPage.ts`) — **there is no `<form>` element to scrape**. Echo back the values it carries verbatim, then verify every non-optional mapped field is still advertised. This check is the only thing that detects a renamed field; the server discards unknown fields and answers 200.
3. Build the body: profile fields, then `form.toFieldValues(request)`, with dates converted here and nowhere else. Posted as `multipart/form-data`, matching the renderer.
4. **Decide from `successMarker` only.** Formstack returns 200 for validation errors, so the status code decides nothing. Neither marker nor `.fsError` nodes → `unconfirmed`, which is genuinely ambiguous and must never be phrased as "try again".

`withRetry` retries `network` only. `rejected`, `schema` and `unconfirmed` are deterministic or dangerous to repeat.

### Slack conventions

- Input `action_id` equals the schema key it populates (`startDate`), so `flattenValues` produces an object zod can parse directly. `blockIdFor` derives the block from the key (`start_date_block`) — inline errors are addressed by block.
- `ack()` first in every action handler; `trigger_id` expires in 3 seconds.
- Errors the user can fix go inline (modal stays open, input intact). Errors the operator must fix go to a DM, because `response_action: errors` is plain text and cannot carry the form link or the copy-paste fallback block.
- **The Home tab does not refresh itself.** Every path that mutates a profile must call `refreshHome`. Omitting it is invisible locally, because reopening the app re-renders.

## Dates

Calendar dates stay `YYYY-MM-DD` strings end to end. **Never introduce `Date` objects** — these are dates, not instants, and a timezone can only make them wrong. Conversion happens once, in `setDateField`.

The PTO form's date fields are Formstack `datetime` fields, posted as `{name}M`/`D`/`Y`/`H`/`I`/`S`/`A` with **no separator**, a three-letter English month (`Aug`) and an **unpadded** day (`6`, not `06`). That is the wire format regardless of how the form displays a date. `parts: 'hyphenParts'` is the other style (`{name}-M`), kept for forms that use it.

## Tests

`tests/engine.test.ts` runs against a **synthetic** form definition (`tests/helpers/syntheticForm.ts`), not `ptoForm`. If the engine only passes for PTO, the abstraction is leaking.

**Never point a test at a real form** — each accidental submission is a real request a human has to delete. `tests/fixtures/pto-form.html` is a snapshot of the live page, so it *advertises the real submit endpoint*: overriding `formUrl` is not enough, because the engine posts where the page says to. Tests rewrite that URL in the fixture text and override `schema.action`. `tests/setup/noNetwork.ts` blocks any request to a non-loopback host as the backstop; it has already caught one leak.

## Current state

`src/forms/pto/schema.json` is mapped from the live form definition and verified against a real submission payload. **`successMarker` is still a placeholder**, so every submission reports `unconfirmed` — see "Before first use" in `README.md`. It cannot be inferred; it comes from the page shown after a successful manual submission.

The form offers 189 countries and a Slack static select holds 100, so the country picker is an `external_select` answered by `app.options('country')` over Socket Mode.

A profile whose stored shape no longer matches `ProfileSchema` is **discarded with a warning**, not thrown on — a schema change must not put the deployment in a boot loop. A *decryption* failure still throws, because that means the key is wrong and the data is recoverable.
