# tcwglobal-slack-bot — Implementation Spec

Build spec for an agent implementing this repository. Read this file completely before writing code.

---

## 1. What this is

**TCWGlobal** is a Slack app that submits TCWGlobal's Formstack forms on a user's behalf.

The user opens the app in Slack, sees their saved details on the App Home tab, clicks a button for the form they need, fills in the request-specific fields in a modal, and submits. The bot POSTs to the form and reports the outcome.

Details that rarely change — name, email, employee ID, client, country, manager — are entered once and reused for every request across every form, until the user clicks **Edit info**.

### Forms

| ID | Form | Status |
|---|---|---|
| `pto` | International PTO request | **Build this now** |
| `expense` | Expense request | Planned — do not build |

Build only `pto`. Structure the code so that adding `expense` later means adding one directory and one registry entry, and touching nothing else. §12 defines that seam precisely.

---

## 2. Hard constraints

These are decisions, not suggestions. Do not "improve" them.

| Constraint | Rationale |
|---|---|
| **No browser automation** (no Playwright/Puppeteer) | The forms are plain HTML. A direct `fetch` POST is ~300ms vs ~15s and 150MB vs 1.5GB. |
| **No database** | Storage is a single encrypted JSON file. Expected user count is under 50. |
| **No queue, no Redis, no worker process** | Submission completes inside Slack's 3-second ack window. One process total. |
| **No slash commands** | Entry point is the App Home tab. Do not register commands or add the `commands` scope. |
| **No separate cache layer** | The in-memory object in `store/profiles.ts` *is* the cache. |
| **No cron drift-detection workflow** | Field presence is verified at submit time instead (§8.2). |
| **No submission history storage** | Nothing displays it. Log to pino and move on. |
| **Do not implement the expense form** | Its field mapping does not exist yet. Build the seam, not the form. |
| **All code, identifiers, Slack UI strings, log messages, comments, and commit messages in English** | Non-negotiable. |

### Non-goals

Do not build: approval workflows, calendar integration, business-day calculation, admin dashboards, analytics, a web UI, or a generic form builder. The registry in §5.2 is the extent of the abstraction.

---

## 3. Prerequisite: field mappings (human step)

**`src/forms/pto/schema.json` cannot be inferred and must exist before submission logic can be correct.**

If it is missing when you start, implement `scripts/extract-schema.ts` (§6.1) first, then stop and report that the operator must run it and confirm four things:

1. Field `name` attributes for every mapped key
2. Date format — `MM/DD/YYYY` vs `DD/MM/YYYY`, and whether date inputs are split into `-M` / `-D` / `-Y` parts
3. Exact `value` strings for `select` and `radio` options (these often differ from visible labels)
4. The success marker — a literal string present in the response body after a successful submission, obtained by submitting the form manually once

Build everything else against a committed fixture at `tests/fixtures/pto-form.html` in the meantime.

---

## 4. Stack

```
Node 22, TypeScript (ESM, "type": "module"), strict mode
```

| Package | Purpose |
|---|---|
| `@slack/bolt` | Slack app framework, Socket Mode |
| `cheerio` | Parse form pages for hidden inputs and field presence |
| `zod` | Env validation and modal input parsing |
| `pino` | Structured logging with PII redaction |

Dev: `typescript`, `tsx`, `vitest`, `@types/node`, `eslint`, `prettier`.

Use Node's built-in `fetch`. Do not add axios, node-fetch, or undici. Do not add an ORM, a database driver, or a Redis client.

**Do not add `dotenv`.** Node 20.6+ loads `.env` natively via `--env-file`. Railway injects variables directly, so production runs without the flag.

```json
{
  "name": "tcwglobal-slack-bot",
  "type": "module",
  "scripts": {
    "dev": "tsx watch --env-file=.env src/app.ts",
    "build": "tsc",
    "start": "node dist/app.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src scripts tests",
    "extract-schema": "tsx scripts/extract-schema.ts"
  }
}
```

`start` has no `--env-file` on purpose — the container gets its configuration from Railway's environment, and pointing at a non-existent `.env` would abort startup.

---

## 5. Repository layout

### 5.1 Files

```
src/
  app.ts                      entry point
  env.ts                      zod-validated environment
  logger.ts                   pino instance with redaction
  profile.ts                  Profile type + zod schema (shared by all forms)
  forms/
    types.ts                  FormDefinition interface, FormSchema types
    registry.ts               the list of enabled forms
    pto/
      schema.json             field mapping (hand-maintained, see §3)
      index.ts                FormDefinition for PTO
      modal.ts                request modal builder
    expense/                  DOES NOT EXIST YET — see §12
  formstack/
    engine.ts                 generic submit: fetch, verify, POST, interpret
    schema.ts                 schema.json loader + typed accessors
  slack/
    handlers.ts               event/action/view registration
    home.ts                   App Home view builder
    profileModal.ts           shared "Your information" modal
    messages.ts               success/failure DM blocks
    values.ts                 view.state.values -> flat object
  store/
    profiles.ts               in-memory object + encrypted JSON file
    crypto.ts                 AES-256-GCM
scripts/
  extract-schema.ts           one-off field extraction tool
tests/
  fixtures/pto-form.html      committed snapshot of the real form
  engine.test.ts
  dates.test.ts
  profiles.test.ts
  crypto.test.ts
data/                         gitignored — encrypted profile store lives here
assets/
  tcwglobal-icon.png          512x512 Slack app icon (see §11)
Dockerfile
railway.json
fly.toml
.env.example                  committed template
.gitignore
README.md
```

`.gitignore` must contain at minimum:

```gitignore
.env
.env.*
!.env.example
data/
*.json.tmp
dist/
node_modules/
*.log
.DS_Store
```

### 5.2 The one abstraction: form definitions

Everything form-specific lives behind `FormDefinition`. Everything else — the submit engine, the profile store, the Home tab, the handlers — is written against that interface and never mentions PTO by name.

```
                       ┌──────────────────┐
                       │  registry.ts     │  [ptoForm]  ← add expenseForm here later
                       └────────┬─────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   slack/home.ts          slack/handlers.ts      formstack/engine.ts
   one button per form    one handler pair       submit(def, profile, request)
                          per form
```

Do not put `if (formId === 'pto')` anywhere. If you feel the need, the interface is wrong — fix the interface.

---

## 6. Module contracts

### 6.1 `scripts/extract-schema.ts`

Standalone tool, not imported by the app. Takes a URL and an output path:

```bash
pnpm extract-schema --url https://targetcw.formstack.com/forms/international_pto --out src/forms/pto/schema.raw.json
```

Fetches the URL, walks every `input`/`select`/`textarea` in the first `<form>`, writes the raw JSON, and prints a console table.

For each field capture: `name`, tag, `type`, associated label text (via `label[for=id]`, falling back to the nearest ancestor container's first `label`), `required`, default `value`, and for `select` the full list of `{ value, text }` options.

The operator hand-writes `schema.json` from this output. Do not attempt to generate it automatically — deciding which field means "start date" requires a human.

### 6.2 `src/forms/types.ts`

```ts
export interface FieldDef {
  name: string;
  type?: 'date';
  parts?: boolean;      // date split into {name}-M / -D / -Y
  optional?: boolean;
  options?: string[];
}

export interface FormSchema {
  formUrl: string;          // the page users see
  action: string;           // the POST target
  successMarker: string;    // literal string present on success
  dateFormat: 'MM/DD/YYYY' | 'DD/MM/YYYY';
  profile: Record<keyof Profile, FieldDef>;
  request: Record<string, FieldDef>;
}

export interface FormDefinition<TRequest = unknown> {
  id: string;                    // 'pto'
  label: string;                 // 'PTO request'  — used in button text and DMs
  schema: FormSchema;
  requestSchema: z.ZodType<TRequest>;

  /** Block Kit modal for the request-specific fields. callback_id must be `${id}_request_modal`. */
  buildModal(profile: Profile): ModalView;

  /** Extra validation the zod schema cannot express, e.g. endDate >= startDate. */
  validate?(request: TRequest): { blockId: string; message: string } | null;

  /** Map request fields to form field values. Profile fields are handled by the engine. */
  toFieldValues(request: TRequest): Record<string, string>;

  /** Human-readable lines for success DMs and the manual-submission fallback block. */
  summarize(request: TRequest): Array<[label: string, value: string]>;
}
```

`buildModal` returns the modal; `action_id` for its Edit info accessory is the shared `open_profile`.

### 6.3 `src/forms/registry.ts`

```ts
import { ptoForm } from './pto/index.js';

export const forms: FormDefinition<any>[] = [ptoForm];

export function getForm(id: string): FormDefinition<any> {
  const form = forms.find((f) => f.id === id);
  if (!form) throw new Error(`Unknown form: ${id}`);
  return form;
}
```

Adding `expense` later is one import and one array entry.

### 6.4 `src/forms/pto/index.ts`

```ts
export const PtoRequestSchema = z.object({
  leaveType: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),   // Slack datepicker format
  endDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalDays: z.number().positive(),
  comments:  z.string().optional(),
});
export type PtoRequest = z.infer<typeof PtoRequestSchema>;

export const ptoForm: FormDefinition<PtoRequest> = {
  id: 'pto',
  label: 'PTO request',
  schema: loadSchema('./schema.json'),
  requestSchema: PtoRequestSchema,
  buildModal: buildPtoModal,
  validate: (r) =>
    r.endDate < r.startDate
      ? { blockId: 'end_date_block', message: 'End date must be on or after the start date.' }
      : null,
  toFieldValues: (r) => ({ /* keyed by request schema key, not form field name */ }),
  summarize: (r) => [
    ['Leave type', r.leaveType],
    ['Dates', `${r.startDate} ~ ${r.endDate}`],
    ['Total days', String(r.totalDays)],
    ...(r.comments ? [['Comments', r.comments] as [string, string]] : []),
  ],
};
```

Dates stay as `YYYY-MM-DD` strings end to end. Convert to the form's format only inside the engine. Do not introduce `Date` objects — they invite timezone bugs for a value that is a calendar date, not an instant.

### 6.5 `src/profile.ts`

```ts
export const ProfileSchema = z.object({
  fullName:     z.string().min(1),
  email:        z.string().email(),
  employeeId:   z.string().min(1),
  clientName:   z.string().min(1),
  country:      z.string().min(1),
  managerName:  z.string().min(1),
  managerEmail: z.string().email(),
});
export type Profile = z.infer<typeof ProfileSchema>;
```

**One profile serves every form.** The PTO form and the expense form will use different Formstack field IDs for the same person's name — that mapping lives in each form's `schema.json`, which is exactly why `Profile` is defined in terms of meaning rather than field names.

If the expense form later needs a profile field PTO does not have (a cost center, say), add it here as `.optional()` and render it in the shared profile modal. Do not fork the profile per form.

### 6.6 `src/formstack/engine.ts`

```ts
export type SubmitResult =
  | { ok: true }
  | { ok: false; reason: 'schema' | 'network' | 'rejected' | 'unconfirmed'; detail: string };

export async function submitForm<T>(
  form: FormDefinition<T>,
  profile: Profile,
  request: T,
): Promise<SubmitResult>;

export async function withRetry(fn: () => Promise<SubmitResult>): Promise<SubmitResult>;
```

Form-agnostic. See §8 for the required algorithm. `withRetry` makes three attempts with exponential backoff (1s, 2s, 4s), retrying **only** `reason === 'network'` — a rejected or schema failure produces the same result every time.

### 6.7 `src/formstack/schema.ts`

```ts
export function loadSchema(path: string): FormSchema;

/** Every non-optional field name the form must expose, expanded for split dates. */
export function requiredFieldNames(schema: FormSchema): string[];

/** Set a date value on the body, honouring dateFormat and split-part fields. */
export function setDateField(body: URLSearchParams, field: FieldDef, iso: string, schema: FormSchema): void;
```

`requiredFieldNames` must expand `parts: true` entries into the three suffixed names, because that is what the presence check in §8.2 compares against.

Type the loaded JSON against `FormSchema`. Do not use `any`.

### 6.8 `src/store/crypto.ts`

```ts
export function encrypt(plaintext: string): Encrypted;   // { ciphertext, iv, authTag } — all base64
export function decrypt(enc: Encrypted): string;         // throws if the auth tag fails
```

AES-256-GCM. Import `encryptionKey` from `env.ts` — do not read `process.env` here. Fresh 12-byte random IV per call.

### 6.9 `src/store/profiles.ts`

```ts
export function getProfile(userId: string): Profile | null;
export function saveProfile(userId: string, profile: Profile): void;
export function forgetProfile(userId: string): void;
```

Synchronous API. Backed by a module-level `Record<string, Profile>` loaded from `DATA_FILE` at import time. Every mutation rewrites the whole file.

**File writes must be atomic**: write to `${DATA_FILE}.tmp`, then `renameSync` over the target. A crash mid-write must not corrupt the store.

**On disk the values are encrypted per user** — the file is `Record<string, Encrypted>`, decrypted into memory on load. Plaintext must never be written to disk.

If the file is missing, start from `{}`. If it exists but fails to parse or decrypt, throw at startup rather than silently discarding user data.

### 6.10 `src/slack/home.ts`

```ts
export function homeView(profile: Profile | null): HomeView;
```

Two states, nothing else. No submission history, no timestamps, no "last updated" line.

**No profile:**
- Header: `TCWGlobal`
- Section: `Submit TCWGlobal forms without leaving Slack.` / `Set up your information once — it will be reused for every request.`
- Primary button `Set up my information`, `action_id: open_profile`

**Has profile:**
- Header: `TCWGlobal`
- Section titled `Your information` showing name · email, client · country, and `Manager: {name} ({email})`
- **One primary button per registered form**, generated by mapping over `forms`: text `New ${form.label}`, `action_id: open_request:${form.id}`
- Secondary button `Edit info`, `action_id: open_profile`

Iterate the registry. Do not hardcode a PTO button — with `expense` registered, the second button must appear with no change to this file.

### 6.11 `src/slack/profileModal.ts`

```ts
export function profileModal(opts: {
  initial?: Partial<Profile>;
  meta: { next: 'close' | 'open_request'; formId?: string; parentViewId?: string };
}): ModalView;
```

`callback_id: profile_modal`, title `Your information`, submit `Save`. Seven inputs matching `ProfileSchema`; country is a `static_select` populated from the PTO schema's country options. `meta` is JSON-serialized into `private_metadata`. Include a `Remove my information` button (`action_id: forget_profile`) when `initial` is present.

`meta.formId` records which form the user was heading for, so first-time setup can continue into the right request modal.

### 6.12 `src/forms/pto/modal.ts`

`callback_id: pto_request_modal`, title `New PTO request`, submit `Submit`. A context header showing `{fullName} · {clientName} · {country}` with an `Edit info` accessory button (`action_id: open_profile`), then: leave type (`radio_buttons` from schema options), start date and end date (`datepicker`), total days (`number_input`), comments (optional multiline `plain_text_input`).

Give every input block a stable `block_id` — `leave_type_block`, `start_date_block`, `end_date_block`, `total_days_block`, `comments_block`. Inline errors are addressed by `block_id`, and `FormDefinition.validate` returns one.

### 6.13 `src/slack/messages.ts`

```ts
export function successBlocks(form: FormDefinition<T>, request: T): KnownBlock[];
export function failureBlocks(
  form: FormDefinition<T>, profile: Profile, request: T, result: SubmitFailure,
): KnownBlock[];
```

Both build their body from `form.summarize(request)`, so a new form needs no changes here.

`successBlocks` — confirmation naming the form, plus every summarized line, so the user can verify the values landed correctly. This is the only defense against a silent date-format error.

`failureBlocks` — must contain all four of:
1. Reason title mapped from `result.reason`, plus the raw `detail` truncated to 300 chars in a code span
2. A link button `Open the form` pointing at `form.schema.formUrl`
3. A code block with the profile fields and every summarized line, labeled, ready to copy-paste for manual submission
4. A context line telling the operator how to fix it

Reason copy:

| reason | title | fix |
|---|---|---|
| `schema` | The form structure has changed | Re-run the extract-schema script and update the form's schema.json |
| `network` | Could not reach the form (retried 3 times) | Try again in a few minutes |
| `unconfirmed` | Could not confirm whether the submission went through | Check the form for a duplicate entry before resubmitting |

`rejected` never reaches this function — it surfaces as an inline modal error instead.

### 6.14 `src/env.ts`

Implement exactly this. It is the reference implementation, not a sketch.

```ts
import { z } from 'zod';

/**
 * Environment configuration, validated at import time.
 *
 * Any missing or malformed value aborts startup with a readable message rather
 * than surfacing later as a confusing runtime error deep inside a Slack handler.
 */

const base64Key32 = z
  .string()
  .min(1, 'PROFILE_ENC_KEY is required — generate one with: openssl rand -base64 32')
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'PROFILE_ENC_KEY must be base64 that decodes to exactly 32 bytes');

const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z
    .string()
    .startsWith('xoxb-', 'SLACK_BOT_TOKEN must start with xoxb- (Settings -> Install App)'),

  SLACK_APP_TOKEN: z
    .string()
    .startsWith(
      'xapp-',
      'SLACK_APP_TOKEN must start with xapp- (Basic Information -> App-Level Tokens, scope connections:write)',
    ),

  ALLOWED_TEAM_IDS: z
    .string()
    .min(1, 'ALLOWED_TEAM_IDS is required')
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean)),

  DATA_FILE: z.string().default('./data/profiles.json'),

  PROFILE_ENC_KEY: base64Key32,

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.');
  process.exit(1);
}

export const env = parsed.data;

/** The encryption key as raw bytes, decoded once. */
export const encryptionKey = Buffer.from(env.PROFILE_ENC_KEY, 'base64');
```

**Form URLs are not environment variables.** Each form's URL lives in its own `schema.json` alongside the field mapping it belongs to, so adding a form never means adding a variable. Tests point the engine at a local fixture server by passing a URL, not by overriding env.

Instead, guard CI at startup in `app.ts`:

```ts
if (process.env.CI) {
  for (const form of forms) {
    if (form.schema.formUrl.includes('formstack.com')) {
      throw new Error(`Refusing to use the real form URL in CI: ${form.id}`);
    }
  }
}
```

Notes on the env module:

- `process.exit(1)` rather than a thrown error, so the operator sees the formatted list instead of a stack trace burying it.
- `ALLOWED_TEAM_IDS` is transformed to `string[]` at the boundary, so consumers never re-split it.
- The two Slack tokens are easy to swap by accident. The `startsWith` checks catch that immediately instead of letting the app boot and fail mysteriously on first use.

### 6.15 `.env.example`

Committed. Every variable documented with where to obtain it.

```dotenv
# Copy this file to .env and fill in the values.
# Never commit .env — it is listed in .gitignore.

# ── Slack ────────────────────────────────────────────────────────────────
# Bot User OAuth Token. Calls the Slack Web API (posting DMs, opening modals).
# Where: api.slack.com/apps -> TCWGlobal -> Settings -> Install App
SLACK_BOT_TOKEN=xoxb-

# App-Level Token. Opens the Socket Mode WebSocket connection.
# Requires the connections:write scope.
# Where: Settings -> Basic Information -> App-Level Tokens -> Generate Token and Scopes
SLACK_APP_TOKEN=xapp-

# Comma-separated Slack workspace IDs allowed to use this bot.
# Where: open Slack in a browser, the URL contains /client/T01ABCDEFGH/
ALLOWED_TEAM_IDS=

# ── Storage ──────────────────────────────────────────────────────────────
# Path to the encrypted profile store.
# Local: ./data/profiles.json
# Railway: /data/profiles.json (must match the volume mount path)
DATA_FILE=./data/profiles.json

# AES-256-GCM key for encrypting stored profiles.
# Generate with: openssl rand -base64 32
# Losing this key makes every stored profile unrecoverable — back it up separately.
PROFILE_ENC_KEY=

# ── Misc ─────────────────────────────────────────────────────────────────
# debug during development, info in production
LOG_LEVEL=debug
```

Form URLs live in each form's `schema.json`, not here.

### 6.16 `src/logger.ts`

```ts
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: ['*.email', '*.fullName', '*.employeeId', '*.managerEmail', '*.managerName'],
});
```

Never log a full profile object or a request body.

---

## 7. Slack flows

### 7.1 App Home

```ts
app.event('app_home_opened', async ({ event, client }) => {
  if (event.tab !== 'home') return;
  await client.views.publish({ user_id: event.user, view: homeView(getProfile(event.user)) });
});
```

**The Home tab does not refresh itself.** Every code path that mutates a profile must call `views.publish` afterward. Extract a `refreshHome(client, userId)` helper and call it after `saveProfile` and after `forgetProfile`. Omitting this is the single most likely bug in this codebase, and it is invisible locally because reopening the app re-renders.

### 7.2 Opening modals

`ack()` before anything else in every action handler. `trigger_id` expires in 3 seconds.

Register request handlers by iterating the registry:

```ts
for (const form of forms) {
  app.action(`open_request:${form.id}`, async ({ ack, body, client }) => {
    await ack();
    const profile = getProfile(body.user.id);
    if (!profile) return refreshHome(client, body.user.id);
    await client.views.open({ trigger_id: body.trigger_id, view: form.buildModal(profile) });
  });

  app.view(`${form.id}_request_modal`, makeSubmitHandler(form));
}
```

`open_profile` is shared and branches on `body.view`:

| Origin | Method | `meta` |
|---|---|---|
| Home, no profile yet | `views.open` | `{ next: 'open_request', formId: <first form id> }` |
| Home, profile exists | `views.open` | `{ next: 'close' }` |
| Inside a request modal | `views.push` | `{ next: 'close', parentViewId: body.view.id }` |

Modal stack depth is capped at 3; only ever push one level.

When no profile exists, prefill name and email from `users.info` / `users.profile.get` before opening.

### 7.3 `profile_modal` submission

Parse with `ProfileSchema`. On failure return `ack({ response_action: 'errors', errors })`.

On success `saveProfile`, then branch on `meta`:

| Case | Response |
|---|---|
| `parentViewId` present | `ack({ response_action: 'clear' })`, then `views.update` the parent with `getForm(...).buildModal(profile)` |
| `next === 'open_request'` | `ack({ response_action: 'update', view: getForm(meta.formId).buildModal(profile) })` |
| otherwise | `ack({ response_action: 'clear' })` |

Then `refreshHome`.

### 7.4 Request modal submission

One generic handler, parameterized by `FormDefinition`:

```
parse with form.requestSchema     -> invalid: inline errors
form.validate(request)            -> non-null: inline error on the returned blockId
profile missing                   -> inline error on the first block
withRetry(() => submitForm(form, profile, request))
  reason === 'rejected'           -> inline error, detail truncated to 140 chars
  ok                              -> ack clear, log, DM successBlocks
  otherwise                       -> ack clear, log error, DM failureBlocks
```

The whole submission runs inside the view_submission handler. It completes in roughly 450ms — comfortably inside the 3s budget — and keeping it synchronous means a rejected submission leaves the modal open with the user's input intact.

Errors the user can fix go inline. Errors the operator must fix go to a DM, because `response_action: errors` accepts plain text only and cannot carry the form link or the copy-paste block.

If measured latency ever approaches 2.5s, switch to `ack()` first and report via `chat.postMessage`. Do not preemptively build that.

### 7.5 Team allowlist

Reject any event whose team ID is not in `ALLOWED_TEAM_IDS`. Implement as Bolt global middleware, not per-handler checks.

---

## 8. Submission algorithm

`submitForm` runs four steps in order. Do not reorder or skip.

### 8.1 Fetch the form page

GET `form.schema.formUrl` with a 10s timeout. On failure return `{ ok: false, reason: 'network', ... }`.

Parse with cheerio, take the first `<form>`. Resolve the POST target from the form's `action` attribute relative to `formUrl`, falling back to `schema.action`.

### 8.2 Harvest hidden inputs and verify field presence

Collect every `input[type="hidden"]` into a `Record<string, string>` — **copying the value verbatim, including empty strings**. Some are anti-spam honeypots that must stay empty; some are session tokens that must be echoed back. Do not filter, rename, or populate them.

Then build the set of all `name` attributes present on the form and compare against `requiredFieldNames(form.schema)`. If any are missing:

```ts
return { ok: false, reason: 'schema', detail: `Fields not found on the form: ${missing.join(', ')}` };
```

**This check is the only mechanism that detects a changed form.** Without it the server silently discards unknown fields and returns success, and the user gets a confirmation for a request that arrived with blank dates.

### 8.3 Build and send the body

Seed a `URLSearchParams` with the harvested hidden fields. Then:

1. Map every `Profile` key through `schema.profile` — the engine does this, identically for every form.
2. Merge `form.toFieldValues(request)`, mapping each returned key through `schema.request`.

Date conversion, driven by the field definition:

```ts
const [year, month, day] = iso.split('-');
if (field.parts) {
  body.set(`${field.name}-M`, month);
  body.set(`${field.name}-D`, day);
  body.set(`${field.name}-Y`, year);
} else if (schema.dateFormat === 'DD/MM/YYYY') {
  body.set(field.name, `${day}/${month}/${year}`);
} else {
  body.set(field.name, `${month}/${day}/${year}`);
}
```

Omit optional fields entirely when empty rather than sending an empty string.

POST as `application/x-www-form-urlencoded` with `Referer: formUrl` and a `User-Agent` of `tcwglobal-slack-bot`, `redirect: 'follow'`, 15s timeout.

### 8.4 Determine the outcome

**Never use the HTTP status code to decide success.** Formstack returns 200 for validation errors.

```
body contains schema.successMarker           -> { ok: true }
body has .fsError / .fsValidationError nodes -> { ok: false, reason: 'rejected', detail: <joined texts> }
neither                                      -> { ok: false, reason: 'unconfirmed', detail: 'Success marker not found in the response' }
```

`unconfirmed` is genuinely ambiguous — the submission may or may not have gone through. Never phrase it as a failure the user should retry; the messaging must tell them to check for a duplicate first.

---

## 9. Tests

Vitest. `pnpm test` must pass with no network access.

| File | Must cover |
|---|---|
| `dates.test.ts` | `2026-08-17` → `08/17/2026`; `DD/MM/YYYY` variant; `parts: true` producing three suffixed entries |
| `engine.test.ts` | Hidden inputs copied verbatim including empty values; every mapped profile and request field present in the body; missing required field → `reason: 'schema'`; a 200 response containing `.fsError` → `reason: 'rejected'`; a 200 response with neither marker nor errors → `reason: 'unconfirmed'`; `withRetry` retries `network` three times and does not retry `rejected` |
| `profiles.test.ts` | `saveProfile` then `getProfile` returns the new value; `forgetProfile` leaves nothing in memory or on disk; reload from file round-trips; the on-disk file contains no plaintext field values |
| `crypto.test.ts` | Round-trip; decrypt with a wrong key throws; two encryptions of the same plaintext differ (fresh IV) |

Serve `tests/fixtures/pto-form.html` from a local HTTP server. Derive missing-field and validation-error variants by mutating the fixture in memory.

Write `engine.test.ts` against a synthetic two-field `FormDefinition` defined in the test file, not against `ptoForm`. If the engine tests only pass for PTO, the abstraction is leaking.

**Never point tests at a real form.** Every accidental test submission creates a real request for a human to clean up.

---

## 10. Deployment

### Dockerfile

Two stages, both `node:22-bookworm-slim`. Build stage compiles TypeScript; runtime stage installs prod deps only, copies `dist/`, and copies **every** `src/forms/*/schema.json` into the matching `dist/forms/*/` path. Create `/data` owned by `node`, declare `VOLUME ["/data"]`, run as `node`, `CMD ["node", "dist/app.js"]`.

Use a glob or a directory copy for the schema files — a hardcoded single-file `COPY` silently breaks when the expense form is added, and the failure only appears at runtime.

Expected image size ~150MB. Do not `EXPOSE` a port — Socket Mode opens an outbound WebSocket and the app never listens.

### Railway (primary)

`railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10 }
}
```

Operator steps, to document in the README:

1. Deploy `tcwglobal-slack-bot` from GitHub
2. Add a volume mounted at `/data`
3. Set variables (below)
4. Leave the health check empty — the app opens no HTTP port, so a configured health check fails forever and produces a restart loop
5. Do not generate a public domain

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_TEAM_IDS=T01ABCDEFGH
PROFILE_ENC_KEY=<same value as local>
DATA_FILE=/data/profiles.json
NODE_ENV=production
LOG_LEVEL=info
TZ=Asia/Seoul
```

Two values differ from local, and both matter:

| Variable | Local | Railway | Consequence of getting it wrong |
|---|---|---|---|
| `DATA_FILE` | `./data/profiles.json` | `/data/profiles.json` | Writes land in ephemeral container storage; every profile is lost on redeploy |
| `LOG_LEVEL` | `debug` | `info` | Noise only |

`PROFILE_ENC_KEY` **must be identical in both places**. A profile encrypted with one key cannot be decrypted with another, and `store/profiles.ts` throws on load rather than silently discarding data — correct, but a mismatched key takes the app down at boot.

Log `socket mode connected` and `app started` at info level on boot so the operator can confirm from the Deployments tab.

### Secret handling

| Secret | If leaked | If lost |
|---|---|---|
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Reinstall to Workspace (invalidates the old token) | Same — reinstall |
| `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens → Revoke, then Generate | Same — regenerate |
| `PROFILE_ENC_KEY` | Rotate, then have every user re-enter their details | **Unrecoverable.** Every stored profile is permanently unreadable |

`PROFILE_ENC_KEY` is the only value with no recovery path. The README must tell the operator to store it in a password manager before first deploy.

The `.gitignore` in §5.1 is not optional. If `.env` ever reaches a remote, treat both Slack tokens as compromised and rotate them — removing the commit from history does not un-leak them.

### Fly.io (alternative)

`fly.toml` with `primary_region = "nrt"`, a `pto_data` volume mounted at `/data`, a single 256MB shared-CPU VM, and no `[[services]]` block.

### CI

`.github/workflows/ci.yml` runs lint, typecheck, and test with `CI=true`. Railway auto-deploys on push to `main`, so add a deploy workflow only if targeting Fly.io.

---

## 11. Slack app configuration

To document in the README. The fastest path is creating the app **From a manifest** at api.slack.com/apps:

```yaml
display_information:
  name: TCWGlobal
  description: Submit TCWGlobal forms without leaving Slack
  background_color: "#2c3e50"

features:
  bot_user:
    display_name: TCWGlobal
    always_online: true
  app_home:
    home_tab_enabled: true
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true

oauth_config:
  scopes:
    bot:
      - chat:write
      - users:read
      - users:read.email

settings:
  socket_mode_enabled: true
  interactivity:
    is_enabled: true
  event_subscriptions:
    bot_events:
      - app_home_opened
  org_deploy_enabled: false
  token_rotation_enabled: false
```

| Setting | Value | Why |
|---|---|---|
| App Home → Home Tab | **On** | The entry point. Off means a blank screen and no `app_home_opened` event |
| Messages tab, read-only | On | Failure DMs stay visible, but users cannot message the bot — there is no message handler, and silence reads as broken |
| Socket Mode | On | No public URL, no signature verification |
| Interactivity | On | Required for button clicks and modal submissions |
| Bot events | `app_home_opened` | Only event the app needs |
| Bot scopes | `chat:write`, `users:read`, `users:read.email` | No `commands`, no channel scopes — the bot cannot post anywhere except DMs |
| Slash commands | None | Entry point is App Home |

**The manifest does not create the app-level token.** After importing it, go to Basic Information → App-Level Tokens → Generate Token and Scopes, add `connections:write`, and use the resulting `xapp-` value for `SLACK_APP_TOKEN`. Missing this is the most common setup failure.

If configuring by hand instead, **enable Socket Mode first**. Turning it on later means Interactivity and Event Subscriptions will demand a Request URL that this app does not have.

Socket Mode requires no public URL, so `pnpm dev` connects to Slack directly from localhost — no ngrok, no tunnel.

### App icon

**The manifest cannot set the icon.** Upload it at Basic Information → Display Information → App icon.

| Requirement | Value |
|---|---|
| Dimensions | 512×512 minimum, **square** |
| Format | PNG, JPG, GIF, or BMP — **not WebP** |

Source: the TCWGlobal logo from the company site (`tcwglobal.com/hs-fs/hubfs/TCWGlobal_Cooper_Full Color copy.webp`). It ships as a 400×199 WebP, so it needs three changes before upload.

**1. Get a larger source.** The HubSpot CDN accepts size parameters, so requesting `?width=1024&height=510` may return real resolution. If it looks upscaled, ask marketing for the original SVG or a high-resolution PNG.

**2. Use the mark, not the full lockup.** The asset is a mascot-plus-wordmark lockup. Slack renders the icon at roughly 20px in the sidebar, where a wide wordmark padded into a square becomes illegible. Crop to the mascot mark alone — the app name renders as text beside the icon anyway, so repeating it inside the icon wastes the space.

**3. Convert and pad to square.**

```bash
curl -o logo.webp "https://www.tcwglobal.com/hs-fs/hubfs/TCWGlobal_Cooper_Full%20Color%20copy.webp?width=1024&height=510&name=TCWGlobal_Cooper_Full%20Color%20copy.webp"

# Crop to the mark — adjust the geometry against the actual image
magick logo.webp -crop 510x510+0+0 +repage mark.png

# Center on a 512x512 canvas with breathing room
magick mark.png -resize 440x440 -background white -gravity center -extent 512x512 tcwglobal-icon.png
```

Prefer a solid brand color over white for the background: white elements in the logo disappear against a white canvas in Slack's dark mode. Set the matching brand color as `background_color` in the manifest, replacing the placeholder `#2c3e50`.

Verify the result at actual rendered size in the Slack sidebar, in both light and dark mode. An icon that looks right in a design tool frequently turns to mud at 20px.

Commit the final PNG to the repo as `assets/tcwglobal-icon.png` so it can be re-uploaded without regenerating it.

---

## 12. Adding the expense form later

This is the acceptance test for the architecture. When the expense field mapping exists, adding it must require exactly this and nothing more:

```
src/forms/expense/
  schema.json      new field mapping, including its own formUrl
  index.ts         FormDefinition: id 'expense', label 'Expense request'
  modal.ts         request modal, callback_id 'expense_request_modal'

src/forms/registry.ts
  +1 import, +1 array entry

tests/fixtures/expense-form.html
```

Plus, if the expense form needs a profile field PTO does not have: one optional field on `ProfileSchema` and one input on the shared profile modal.

**Nothing else changes.** No edits to `engine.ts`, `home.ts`, `handlers.ts`, `messages.ts`, `profiles.ts`, the Dockerfile, or the env schema.

While implementing PTO, verify this by writing `engine.test.ts` against a synthetic form definition. If the engine needs to know it is handling PTO, stop and fix the interface before continuing.

---

## 13. Build order

Each phase must be green before starting the next.

| # | Deliverable | Done when |
|---|---|---|
| 1 | `.gitignore`, `.env.example`, `env.ts`, `logger.ts`, `profile.ts`, `crypto.ts` + tests | `crypto.test.ts` passes; a missing variable produces the formatted startup error, not a stack trace |
| 2 | `store/profiles.ts` + tests | Save/load/forget round-trips; on-disk file contains no plaintext |
| 3 | `scripts/extract-schema.ts` | Produces a field table from the fixture |
| 4 | `forms/types.ts`, `formstack/schema.ts`, `formstack/engine.ts` + tests | All `engine.test.ts` and `dates.test.ts` cases pass **against a synthetic form definition** |
| 5 | `forms/pto/*`, `forms/registry.ts` | PTO submits successfully against the fixture |
| 6 | `slack/home.ts`, `profileModal.ts`, `messages.ts` | Home renders one button per registered form for both profile states |
| 7 | `slack/handlers.ts`, `app.ts` | `pnpm dev` renders Home; a full request submits against the fixture |
| 8 | `Dockerfile`, `railway.json`, `fly.toml`, `README.md` | `docker build` succeeds and the container boots |

Phase 4 before phase 5 is deliberate. Building the engine against a synthetic form first is what keeps PTO-specific assumptions out of it.

---

## 14. Failure modes to guard against

Ranked by how likely they are to ship unnoticed.

1. **Home tab not refreshed after a profile change.** Stale data shown indefinitely. Invisible in local testing because reopening the app re-renders. Every mutation path must call `refreshHome`.
2. **Success assumed from HTTP 200.** Formstack returns 200 for validation errors. Only the success marker decides.
3. **Field renamed on the form.** The server ignores unknown fields and returns success. Only the §8.2 presence check catches this.
4. **Date format wrong.** A submission with `08/17/2026` interpreted as `DD/MM` is silently invalid or wrong by months. Mitigated by echoing the submitted values in the success DM.
5. **PTO assumptions leaking into shared code.** Costs nothing now and everything when expense arrives. Caught by testing the engine against a synthetic form.
6. **`unconfirmed` framed as a retryable failure.** Produces duplicate requests.
7. **Dockerfile copies only the PTO schema.** The expense form builds fine and fails at runtime. Copy the whole forms directory.
8. **Volume path mismatch on Railway.** Profiles disappear on redeploy. Verify by deploying, saving a profile, redeploying, and confirming it survives.
9. **Health check enabled on Railway.** Restart loop.
10. **Hidden honeypot field populated.** Submission silently classified as spam. Copy hidden values verbatim, never synthesize them.
11. **`PROFILE_ENC_KEY` differs between local and production.** The app throws at boot on an undecryptable store. Loud, but confusing if the operator does not know the two must match.
12. **`.env` committed.** Both Slack tokens must then be rotated. Verify with `git check-ignore -v .env` before the first push.
