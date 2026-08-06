# tcwglobal-slack-bot

**TCWGlobal** is a Slack app that submits TCWGlobal's Formstack forms on a user's behalf.

Open the app in Slack, and the App Home tab shows your saved details and a button per form. Click one, fill in the fields that change per request, and submit. The bot POSTs to the form and reports back by DM.

Name, email, client, country and manager are entered once and reused for every request on every form, until you click **Edit info**.

| Form | ID | Status |
| --- | --- | --- |
| International PTO request | `pto` | Built |
| Expense request | `expense` | Planned — mapping does not exist yet |

Design rationale is in [`docs/PLAN.md`](docs/PLAN.md) (Korean); the build spec is in [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

---

## ⚠️ Before first use

**`src/forms/pto/schema.json` is a placeholder.** Its field names, option values, date format and success marker were read off `tests/fixtures/pto-form.html` — a hand-written stand-in, not the real form. Everything is wired up and tested against that fixture, but a submission to the live form will not land correctly until the mapping is verified.

This is the one step that cannot be automated: deciding which field means "start date" requires a human.

1. **Snapshot the real form and list its fields.**

   ```bash
   pnpm extract-schema --url https://<the real form url> --out /tmp/raw.json
   curl -s https://<the real form url> > tests/fixtures/pto-form.html
   ```

2. **Submit the form manually once**, in a browser with **F12 → Network** open, using your own name and a **one-day date in the past** (ask the form owner to cancel it afterwards). Right-click the POST request → **Copy as cURL**.

3. **Read four things off that request**, and put them in `src/forms/pto/schema.json`:

   | What | Where | Why it matters |
   | --- | --- | --- |
   | Field names | Payload tab | `field12345678`-style. Match them to labels. |
   | Date format | The date values in the payload | `08/17/2026` vs `17/08/2026`. **The easiest thing to get silently wrong.** |
   | Option values | The leave type value | May be `1` rather than `Vacation`. Use `value`, never the visible label. |
   | Success marker | The page after submitting | The **only** signal the bot uses to decide a submission worked. |

   Also check whether dates are split into `field123-M` / `-D` / `-Y` inputs. If so, set `"parts": true` on that field. Formstack does this often.

4. **Remove the `$comment` line** from `schema.json` once the values are real.

5. `pnpm test` — the suite checks the mapping against the committed fixture.

6. Use it yourself for a few days before telling the team. If the date format is wrong, announcing it first means several people's leave requests go in wrong.

---

## Quick start

```bash
pnpm install
cp .env.example .env      # then fill it in — see the comments in the file
openssl rand -base64 32   # PROFILE_ENC_KEY
pnpm dev
```

Socket Mode connects to Slack directly from localhost. No ngrok, no tunnel, no public URL. Open the app in the Slack sidebar and the Home tab renders.

Deploying is the last step, not the first: during development the local process is a fully working bot, with instant reloads and logs in your terminal.

### Scripts

| Command | Does |
| --- | --- |
| `pnpm dev` | Run with reload, loading `.env` |
| `pnpm test` | Vitest. No network access required — every form is served from a local fixture |
| `pnpm typecheck` | `tsc --noEmit` across `src`, `scripts` and `tests` |
| `pnpm lint` | ESLint |
| `pnpm build` / `pnpm start` | Compile to `dist/` and run it |
| `pnpm extract-schema --url <url> --out <path>` | Dump a form's fields for hand-writing a schema |

`pnpm start` deliberately has no `--env-file`: in production the environment comes from the platform, and pointing at a missing `.env` would abort startup.

---

## Slack app setup

Create the app at [api.slack.com/apps](https://api.slack.com/apps) **from a manifest**:

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

Then, and this is the step people miss: **the manifest cannot create the app-level token.** Go to **Basic Information → App-Level Tokens → Generate Token and Scopes**, add `connections:write`, and use the resulting `xapp-` value as `SLACK_APP_TOKEN`.

The bot has no `commands` scope and no channel scopes — it cannot post anywhere except DMs, and it has no slash commands. The entry point is the App Home tab.

If you configure the app by hand instead of from the manifest, **turn Socket Mode on first**. Enabling it later means Interactivity and Event Subscriptions will demand a Request URL this app does not have.

Installing the app notifies nobody. `#general` may show an "added an integration" system message, which is Slack recording a workspace change, not the bot joining a channel.

### App icon

The manifest cannot set the icon. Upload it at **Basic Information → Display Information → App icon**. Slack wants a **square PNG, 512×512 or larger** — not WebP.

The company logo ships as a 400×199 WebP lockup, so it needs three changes:

```bash
curl -o logo.webp "https://www.tcwglobal.com/hs-fs/hubfs/TCWGlobal_Cooper_Full%20Color%20copy.webp?width=1024&height=510&name=TCWGlobal_Cooper_Full%20Color%20copy.webp"

# Crop to the mascot mark — adjust the geometry against the actual image
magick logo.webp -crop 510x510+0+0 +repage mark.png

# Center on a 512x512 canvas with breathing room
magick mark.png -resize 440x440 -background '#2c3e50' -gravity center -extent 512x512 assets/tcwglobal-icon.png
```

Use the **mark alone, not the full lockup**: the icon renders at about 20px in the sidebar, where a wide wordmark is unreadable — and the app name already appears as text beside it. Prefer a solid brand colour over white, or white elements in the logo vanish in dark mode, and set the same colour as `background_color` in the manifest. Check the result at actual size in both light and dark mode; icons that look fine in a design tool routinely turn to mud at 20px.

Commit the final PNG as `assets/tcwglobal-icon.png` so it can be re-uploaded without regenerating it.

---

## Deployment

Socket Mode holds a WebSocket open, so the process must run continuously — which rules out every serverless platform. Nothing connects *to* the bot, so self-hosting needs no public IP, port forwarding, domain or certificate; a machine that is already on all the time is the simplest option there is.

### Railway

1. Push to GitHub, then **New Project → Deploy from GitHub repo**
2. Add a volume mounted at `/data` — created from the **project canvas** (right-click, or `⌘K`), not from inside the service settings. `railway volume add --mount-path /data` does the same thing
3. Set the variables below
4. **Leave the health check empty.** The app opens no HTTP port, so a configured health check fails forever and produces a restart loop
5. Do not generate a public domain — nothing would use it

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
PROFILE_ENC_KEY=<same value as local>
DATA_FILE=/data/profiles.json
NODE_ENV=production
LOG_LEVEL=info
TZ=Asia/Seoul
RAILWAY_RUN_UID=0
```

Two values differ from local, and one exists only on Railway:

| Variable | Local | Railway | If you get it wrong |
| --- | --- | --- | --- |
| `DATA_FILE` | `./data/profiles.json` | `/data/profiles.json` | Writes land in ephemeral container storage; every profile is lost on redeploy |
| `LOG_LEVEL` | `debug` | `info` | Noise only |
| `RAILWAY_RUN_UID` | — | `0` | Saving a profile fails with `EACCES` — see below |

`RAILWAY_RUN_UID=0` runs the container as root. The Dockerfile drops to `USER node`, but Railway mounts volumes owned by root, so the `node` user cannot write to `/data`. The failure is late and misleading: the app boots fine and the Home tab renders, because nothing is written until someone saves a profile. Running as root gives up the non-root hardening, which is an acceptable trade here — the container listens on no port and processes only Slack-signed payloads.

**Verify the volume immediately after the first deploy**: save a profile, push any commit to trigger a redeploy, and confirm the profile is still on the Home tab. If it vanished, the mount path and `DATA_FILE` disagree. This is not reproducible locally and is annoying to diagnose later.

`app started` and `socket mode connected` are logged at info level on boot, so the Deployments tab confirms a healthy start.

### Fly.io

`fly.toml` is committed: Tokyo region, a 256MB shared-CPU VM, a `pto_data` volume at `/data`, and no `[[services]]` block. Set the same variables with `fly secrets set`.

### Secrets

| Secret | If leaked | If lost |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Reinstall to Workspace | Reinstall |
| `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens → Revoke, then Generate | Regenerate |
| `PROFILE_ENC_KEY` | Rotate, then have everyone re-enter their details | **Unrecoverable** |

`PROFILE_ENC_KEY` is the only value with no recovery path, and it must be **identical locally and in production** — the store throws at boot on data it cannot decrypt, which is correct but confusing if you do not know the two have to match. **Put it in a password manager before the first deploy.**

Check `git check-ignore -v .env` before your first push. If `.env` ever reaches a remote, both Slack tokens are compromised; rotate them. Deleting the commit does not un-leak them.

---

## How it works

No browser automation, no database, no queue. The forms are plain HTML, so a submission is one `fetch` POST — about 300ms, which fits inside Slack's 3-second acknowledgement window. That single decision removes the queue, the worker process and Redis, and it means a rejected submission leaves the modal open with the user's input still in it.

```
slack/handlers.ts ──> formstack/engine.ts ──> the form
        │                     │
        │                     └── forms/registry.ts ──> forms/pto/{schema.json, index.ts, modal.ts}
        └──> store/profiles.ts ──> data/profiles.json   (AES-256-GCM, one entry per user)
```

A submission runs four steps, in order:

1. GET the form page
2. Copy every hidden input **verbatim** — some are session tokens, some are anti-spam honeypots that must stay empty — and check that every mapped field is still present. This check is the only thing that catches a renamed field; without it the server discards unknown fields and answers 200.
3. Build the body: profile fields, then request fields, with dates converted to the form's format
4. Decide the outcome **from the success marker only**. Formstack returns 200 for validation errors, so the status code decides nothing.

Failures the user can fix (end date before start date, a rejected value) appear inline in the modal, where their input still is. Failures the operator must fix arrive as a DM containing the reason, a link to the form, and a copy-paste block of every value — so a broken bot costs the user 30 seconds, not their afternoon.

### Adding the expense form

By design this is a new directory and one registry line:

```
src/forms/expense/{schema.json, index.ts, modal.ts}
src/forms/registry.ts     +1 import, +1 array entry
tests/fixtures/expense-form.html
```

The Home tab grows a button, the handlers register themselves, and the Dockerfile picks up the new schema — none of those files change. If the expense form needs a profile field PTO does not have, add it to `ProfileSchema` as `.optional()`; do not fork the profile per form.

`tests/engine.test.ts` runs against a synthetic form definition rather than the PTO one, which is what keeps PTO-shaped assumptions out of the shared code.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| App Home is blank | Home Tab is off in the app config, so no `app_home_opened` event fires |
| `invalid_auth` at boot | Bot and app tokens swapped, or the app-level token was never created |
| Restart loop on Railway | A health check is configured. The app opens no port — clear it |
| Profiles vanish on redeploy | `DATA_FILE` does not match the volume mount path |
| Boots fine, but saving a profile does nothing | `RAILWAY_RUN_UID=0` is missing; the volume is root-owned and the container is not |
| Throws at boot on the profile store | `PROFILE_ENC_KEY` differs from the key the file was written with |
| Details on the Home tab are stale | A code path changed a profile without republishing the view |
| "Could not confirm whether the submission went through" | Genuinely ambiguous. **Check the form for a duplicate before resubmitting** |
