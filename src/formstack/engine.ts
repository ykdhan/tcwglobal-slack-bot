import * as cheerio from 'cheerio';

import { logger } from '../logger.js';
import { PROFILE_KEYS, type Profile } from '../profile.js';
import type { FieldDef, FormDefinition, FormSchema } from '../forms/types.js';
import { requiredFieldNames, setDateField } from './schema.js';

export type SubmitFailure = {
  ok: false;
  reason: 'schema' | 'network' | 'rejected' | 'unconfirmed';
  detail: string;
};

export type SubmitResult = { ok: true } | SubmitFailure;

const PAGE_TIMEOUT_MS = 10_000;
const SUBMIT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'tcwglobal-slack-bot';

/** Backoff between retried attempts. Overridable so tests do not sleep. */
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

function failure(reason: SubmitFailure['reason'], detail: string): SubmitFailure {
  return { ok: false, reason, detail };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'The request timed out' : error.message;
  }
  return String(error);
}

/**
 * Put one value on the body, honouring date formatting and optional fields.
 *
 * Optional fields are omitted entirely rather than sent empty: an empty string
 * is a value, and some forms treat it as one.
 */
function setField(body: URLSearchParams, field: FieldDef, value: string, schema: FormSchema): void {
  if (!value) {
    if (field.optional) return;
    body.set(field.name, '');
    return;
  }

  if (field.type === 'date') {
    setDateField(body, field, value, schema);
    return;
  }

  body.set(field.name, value);
}

/**
 * Submit one request to one form.
 *
 * Form-agnostic by construction: everything specific to a form arrives through
 * `FormDefinition`. The four steps run in order and none of them is optional —
 * step 2 in particular is the only thing standing between a renamed field and a
 * confirmation message for a request that arrived blank.
 */
export async function submitForm<T>(
  form: FormDefinition<T>,
  profile: Profile,
  request: T,
): Promise<SubmitResult> {
  const { schema } = form;

  // 1. Fetch the form page.
  let page: Response;
  try {
    page = await fetch(schema.formUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (error) {
    return failure('network', `Could not load the form page: ${describe(error)}`);
  }

  if (!page.ok) {
    return failure('network', `The form page returned HTTP ${page.status}`);
  }

  const $ = cheerio.load(await page.text());
  const formElement = $('form').first();
  if (formElement.length === 0) {
    return failure('schema', 'No form element was found on the page');
  }

  const action = formElement.attr('action');
  const target = action ? new URL(action, schema.formUrl).toString() : schema.action;

  // 2. Harvest hidden inputs, verbatim.
  //
  // Values are copied exactly as found, empty ones included. Some are session
  // tokens that must be echoed back; some are anti-spam honeypots that must stay
  // empty. Filtering or populating them is how a submission gets silently
  // classified as spam.
  const body = new URLSearchParams();
  formElement.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name');
    if (!name) return;
    body.set(name, $(element).attr('value') ?? '');
  });

  // Verify the form still exposes every field the mapping expects. Unknown
  // fields are discarded server-side without complaint, so a rename shows up as
  // a successful submission with missing data unless it is caught here.
  const present = new Set<string>();
  formElement.find('input, select, textarea').each((_, element) => {
    const name = $(element).attr('name');
    if (name) present.add(name);
  });

  const missing = requiredFieldNames(schema).filter((name) => !present.has(name));
  if (missing.length > 0) {
    return failure('schema', `Fields not found on the form: ${missing.join(', ')}`);
  }

  // 3. Build the body: profile fields first, then the request-specific ones.
  for (const key of PROFILE_KEYS) {
    setField(body, schema.profile[key], profile[key], schema);
  }

  for (const [key, value] of Object.entries(form.toFieldValues(request))) {
    const field = schema.request[key];
    if (!field) {
      return failure('schema', `The form mapping has no field for "${key}"`);
    }
    setField(body, field, value, schema);
  }

  // 4. Submit and interpret the response.
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Referer: schema.formUrl,
      },
      body: body.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (error) {
    return failure('network', `Could not submit the form: ${describe(error)}`);
  }

  const html = await response.text();

  // The status code decides nothing. Formstack answers 200 to a rejected
  // submission just as readily as to an accepted one.
  if (html.includes(schema.successMarker)) {
    logger.debug({ formId: form.id, status: response.status }, 'submission accepted');
    return { ok: true };
  }

  const $response = cheerio.load(html);
  const errors = $response('.fsError, .fsValidationError')
    .map((_, element) => $response(element).text().trim())
    .get()
    .filter(Boolean);

  if (errors.length > 0) {
    return failure('rejected', [...new Set(errors)].join(' '));
  }

  return failure('unconfirmed', 'Success marker not found in the response');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry transient failures only.
 *
 * A rejected or schema failure is deterministic — repeating it wastes the user's
 * time and, for `unconfirmed`, risks a duplicate request landing on someone's
 * desk. Only `network` is worth another attempt.
 */
export async function withRetry(
  fn: () => Promise<SubmitResult>,
  delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<SubmitResult> {
  const attempts = 3;
  let last: SubmitResult = failure('network', 'No attempt was made');

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await fn();
    if (last.ok || last.reason !== 'network') return last;

    if (attempt < attempts - 1) {
      logger.warn({ attempt: attempt + 1, detail: last.detail }, 'submission attempt failed');
      await sleep(delaysMs[attempt] ?? 0);
    }
  }

  return last;
}
