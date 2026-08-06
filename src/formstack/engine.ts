import * as cheerio from 'cheerio';

import { logger } from '../logger.js';
import { PROFILE_KEYS, type Profile } from '../profile.js';
import type { FieldDef, FormDefinition, FormSchema } from '../forms/types.js';
import { parseFormPage } from './formPage.js';
import { requiredFieldNames, setDateField, type FieldSink } from './schema.js';

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
function setField(body: FieldSink, field: FieldDef, value: string, schema: FormSchema): void {
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

  // 2. Read the form definition and verify it still exposes what we map.
  let definition;
  try {
    definition = parseFormPage(await page.text());
  } catch (error) {
    return failure('schema', describe(error));
  }

  const missing = requiredFieldNames(schema).filter((name) => !definition.fields.has(name));
  if (missing.length > 0) {
    return failure('schema', `Fields not found on the form: ${missing.join(', ')}`);
  }

  const target = definition.action ?? schema.action;

  // 3. Build the body: page values first, then constants, then the mapping.
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(definition.hidden)) values.set(name, value);
  for (const [name, value] of Object.entries(schema.constants ?? {})) values.set(name, value);

  for (const key of PROFILE_KEYS) {
    setField(values, schema.profile[key], profile[key], schema);
  }

  for (const [key, value] of Object.entries(form.toFieldValues(request))) {
    const field = schema.request[key];
    if (!field) {
      return failure('schema', `The form mapping has no field for "${key}"`);
    }
    setField(values, field, value, schema);
  }

  // 4. Submit and interpret the response.
  //
  // multipart/form-data, matching what the renderer sends. fetch sets the
  // Content-Type and boundary from the FormData body; setting it by hand
  // produces a boundary mismatch and a body the server cannot parse.
  const body = new FormData();
  for (const [name, value] of values) body.set(name, value);

  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, Referer: schema.formUrl },
      body,
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

  const $ = cheerio.load(html);
  const errors = $('.fsError, .fsValidationError')
    .map((_, element) => $(element).text().trim())
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
