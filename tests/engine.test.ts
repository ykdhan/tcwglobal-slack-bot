import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitForm, withRetry, type SubmitResult } from '../src/formstack/engine.js';
import {
  DEMO_PROFILE,
  DEMO_REQUEST,
  NOTE_FIELD,
  PAGE_HIDDEN,
  PROFILE_FIELD_NAMES,
  TOPIC_FIELD,
  WHEN_FIELD,
  demoForm,
  demoFormHtml,
  demoSchema,
  startFormServer,
  type FormServer,
} from './helpers/syntheticForm.js';

let server: FormServer;

/** The synthetic form, pointed at the local server. */
function formAt(overrides: Parameters<typeof demoSchema>[0] = {}) {
  return demoForm(demoSchema({ formUrl: server.url, action: server.url, ...overrides }));
}

beforeEach(async () => {
  server = await startFormServer();
});

afterEach(async () => {
  await server.close();
});

describe('submitForm', () => {
  it('reports success when the response contains the success marker', async () => {
    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({ ok: true });
  });

  it('echoes back the values the page carries, empty ones included', async () => {
    await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);
    const body = server.lastBody();

    for (const [name, value] of Object.entries(PAGE_HIDDEN)) {
      expect(body?.get(name)).toBe(value);
    }
    // Declared constants ride along, including the deliberately empty one.
    expect(body?.get('rendererVersion')).toBe('7.52.7');
    expect(body?.has('emptyOnPurpose')).toBe(true);
    expect(body?.get('emptyOnPurpose')).toBe('');
  });

  it('sends every mapped profile field', async () => {
    await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);
    const body = server.lastBody();

    for (const [key, name] of Object.entries(PROFILE_FIELD_NAMES)) {
      expect(body?.get(name)).toBe(DEMO_PROFILE[key as keyof typeof DEMO_PROFILE]);
    }
  });

  it('sends every mapped request field, formatting dates for the form', async () => {
    await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);
    const body = server.lastBody();

    expect(body?.get(TOPIC_FIELD)).toBe('Quarterly review');
    expect(body?.get(WHEN_FIELD)).toBe('08/17/2026');
    expect(body?.get(NOTE_FIELD)).toBe('Second half of the day');
  });

  it('honours the form-level date format', async () => {
    await submitForm(formAt({ dateFormat: 'DD/MM/YYYY' }), DEMO_PROFILE, DEMO_REQUEST);

    expect(server.lastBody()?.get(WHEN_FIELD)).toBe('17/08/2026');
  });

  it('omits an optional field rather than sending it empty', async () => {
    await submitForm(formAt(), DEMO_PROFILE, { ...DEMO_REQUEST, note: undefined });

    expect(server.lastBody()?.has(NOTE_FIELD)).toBe(false);
  });

  it('posts to the target the page advertises', async () => {
    server.setPage(demoFormHtml({ submitUrl: `${server.url}/elsewhere` }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({ ok: true });
    expect(server.postCount()).toBe(1);
  });

  it('fails with reason schema when a mapped field is missing from the form', async () => {
    server.setPage(demoFormHtml({ omit: [WHEN_FIELD] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect((result as { detail: string }).detail).toContain(WHEN_FIELD);
    // Nothing is submitted once the form is known to have changed.
    expect(server.postCount()).toBe(0);
  });

  it('fails with reason schema when a required profile field is missing', async () => {
    server.setPage(demoFormHtml({ omit: [PROFILE_FIELD_NAMES.email] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect((result as { detail: string }).detail).toContain(PROFILE_FIELD_NAMES.email);
  });

  it('does not require an optional field to be present on the form', async () => {
    server.setPage(demoFormHtml({ omit: [NOTE_FIELD] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({ ok: true });
  });

  it('checks presence against the field an input belongs to, not the input', async () => {
    // A name split across two inputs is one field on the form.
    const result = await submitForm(
      formAt({
        profile: {
          ...demoSchema().profile,
          firstName: {
            name: `${PROFILE_FIELD_NAMES.firstName}-first`,
            base: PROFILE_FIELD_NAMES.firstName,
          },
          lastName: {
            name: `${PROFILE_FIELD_NAMES.firstName}-last`,
            base: PROFILE_FIELD_NAMES.firstName,
          },
        },
      }),
      DEMO_PROFILE,
      DEMO_REQUEST,
    );

    expect(result).toEqual({ ok: true });
    expect(server.lastBody()?.get(`${PROFILE_FIELD_NAMES.firstName}-first`)).toBe('Gildong');
    expect(server.lastBody()?.get(`${PROFILE_FIELD_NAMES.firstName}-last`)).toBe('Hong');
  });

  it('splits a Formstack datetime field into its parts', async () => {
    const result = await submitForm(
      formAt({
        request: {
          topic: { name: TOPIC_FIELD },
          whenDate: { name: WHEN_FIELD, type: 'date', parts: 'datetimeParts' },
          note: { name: NOTE_FIELD, optional: true },
        },
      }),
      DEMO_PROFILE,
      DEMO_REQUEST,
    );

    expect(result).toEqual({ ok: true });
    const body = server.lastBody();
    expect(body?.get(`${WHEN_FIELD}M`)).toBe('Aug');
    expect(body?.get(`${WHEN_FIELD}D`)).toBe('17');
    expect(body?.get(`${WHEN_FIELD}Y`)).toBe('2026');
    expect(body?.get(`${WHEN_FIELD}A`)).toBe('AM');
    // The base name is never posted on its own.
    expect(body?.has(WHEN_FIELD)).toBe(false);
  });

  it('fails with reason schema when the page carries no form definition', async () => {
    server.setPage('<html><body>Down for maintenance</body></html>');

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect(server.postCount()).toBe(0);
  });

  it('fails with reason rejected when the response carries validation errors', async () => {
    server.setResponse('<div class="fsError">This field is required.</div>', 200);

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({
      ok: false,
      reason: 'rejected',
      detail: 'This field is required.',
    });
  });

  it('collects fsValidationError nodes too', async () => {
    server.setResponse(
      '<span class="fsValidationError">Enter a valid date.</span>' +
        '<span class="fsError">Category is required.</span>',
      200,
    );

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect((result as { detail: string }).detail).toContain('Enter a valid date.');
    expect((result as { detail: string }).detail).toContain('Category is required.');
  });

  it('fails with reason unconfirmed when the response has neither marker nor errors', async () => {
    server.setResponse('<html><body>Something else entirely</body></html>', 200);

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({
      ok: false,
      reason: 'unconfirmed',
      detail: 'Success marker not found in the response',
    });
  });

  it('does not treat HTTP 200 as success on its own', async () => {
    server.setResponse('<html><body>OK</body></html>', 200);

    await expect(submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('fails with reason network when the form page cannot be loaded', async () => {
    server.setUnreachable(true);

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('fails with reason schema when the mapping names a field the definition did not supply', async () => {
    const form = demoForm(
      demoSchema({
        formUrl: server.url,
        request: { topic: { name: TOPIC_FIELD }, whenDate: { name: WHEN_FIELD, type: 'date' } },
      }),
    );

    const result = await submitForm(form, DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect((result as { detail: string }).detail).toContain('note');
  });
});

describe('withRetry', () => {
  const noDelay = [0, 0, 0];

  it('retries a network failure three times in total', async () => {
    const fn = vi.fn<() => Promise<SubmitResult>>().mockResolvedValue({
      ok: false,
      reason: 'network',
      detail: 'connection refused',
    });

    const result = await withRetry(fn, noDelay);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('stops as soon as an attempt succeeds', async () => {
    const fn = vi
      .fn<() => Promise<SubmitResult>>()
      .mockResolvedValueOnce({ ok: false, reason: 'network', detail: 'timeout' })
      .mockResolvedValueOnce({ ok: true });

    const result = await withRetry(fn, noDelay);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: true });
  });

  it('does not retry a rejected submission', async () => {
    const fn = vi.fn<() => Promise<SubmitResult>>().mockResolvedValue({
      ok: false,
      reason: 'rejected',
      detail: 'This field is required.',
    });

    await withRetry(fn, noDelay);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry a schema failure', async () => {
    const fn = vi.fn<() => Promise<SubmitResult>>().mockResolvedValue({
      ok: false,
      reason: 'schema',
      detail: 'Fields not found on the form',
    });

    await withRetry(fn, noDelay);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unconfirmed submission, which could already have landed', async () => {
    const fn = vi.fn<() => Promise<SubmitResult>>().mockResolvedValue({
      ok: false,
      reason: 'unconfirmed',
      detail: 'Success marker not found in the response',
    });

    await withRetry(fn, noDelay);

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
