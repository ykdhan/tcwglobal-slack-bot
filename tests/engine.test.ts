import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitForm, withRetry, type SubmitResult } from '../src/formstack/engine.js';
import {
  DEMO_PROFILE,
  DEMO_REQUEST,
  HIDDEN_FIELDS,
  PROFILE_FIELD_NAMES,
  demoForm,
  demoFormHtml,
  demoSchema,
  startFormServer,
  type FormServer,
} from './helpers/syntheticForm.js';

let server: FormServer;

/** The synthetic form, pointed at the local server. */
function formAt(overrides: Parameters<typeof demoSchema>[0] = {}) {
  return demoForm(demoSchema({ formUrl: server.url, ...overrides }));
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

  it('copies hidden inputs verbatim, empty values included', async () => {
    await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);
    const body = server.lastBody();

    for (const [name, value] of Object.entries(HIDDEN_FIELDS)) {
      expect(body?.get(name)).toBe(value);
    }
    // The honeypot is present and empty, not dropped and not filled in.
    expect(body?.has('trap')).toBe(true);
    expect(body?.get('trap')).toBe('');
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

    expect(body?.get('q_topic')).toBe('Quarterly review');
    expect(body?.get('q_when')).toBe('08/17/2026');
    expect(body?.get('q_note')).toBe('Second half of the day');
  });

  it('honours the form-level date format', async () => {
    await submitForm(formAt({ dateFormat: 'DD/MM/YYYY' }), DEMO_PROFILE, DEMO_REQUEST);

    expect(server.lastBody()?.get('q_when')).toBe('17/08/2026');
  });

  it('omits an optional field rather than sending it empty', async () => {
    await submitForm(formAt(), DEMO_PROFILE, { ...DEMO_REQUEST, note: undefined });

    expect(server.lastBody()?.has('q_note')).toBe(false);
  });

  it('posts to the action resolved from the page, not the configured fallback', async () => {
    server.setPage(demoFormHtml({ action: '/elsewhere' }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({ ok: true });
    expect(server.postCount()).toBe(1);
  });

  it('fails with reason schema when a mapped field is missing from the form', async () => {
    server.setPage(demoFormHtml({ omit: ['q_when'] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect((result as { detail: string }).detail).toContain('q_when');
    // Nothing is submitted once the form is known to have changed.
    expect(server.postCount()).toBe(0);
  });

  it('fails with reason schema when a required profile field is missing', async () => {
    server.setPage(demoFormHtml({ omit: ['p_email'] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
    expect((result as { detail: string }).detail).toContain('p_email');
  });

  it('does not require an optional field to be present on the form', async () => {
    server.setPage(demoFormHtml({ omit: ['q_note'] }));

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toEqual({ ok: true });
  });

  it('expands split date fields when checking field presence', async () => {
    server.setPage(
      demoFormHtml({ omit: ['q_when'] }).replace(
        '<input type="submit"',
        '<input type="text" name="q_when-M" /><input type="text" name="q_when-D" />' +
          '<input type="text" name="q_when-Y" /><input type="submit"',
      ),
    );

    const result = await submitForm(
      formAt({
        request: {
          topic: { name: 'q_topic' },
          whenDate: { name: 'q_when', type: 'date', parts: true },
          note: { name: 'q_note', optional: true },
        },
      }),
      DEMO_PROFILE,
      DEMO_REQUEST,
    );

    expect(result).toEqual({ ok: true });
    expect(server.lastBody()?.get('q_when-M')).toBe('08');
    expect(server.lastBody()?.get('q_when-D')).toBe('17');
    expect(server.lastBody()?.get('q_when-Y')).toBe('2026');
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
        '<span class="fsError">Total days must be a number.</span>',
      200,
    );

    const result = await submitForm(formAt(), DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect((result as { detail: string }).detail).toContain('Enter a valid date.');
    expect((result as { detail: string }).detail).toContain('Total days must be a number.');
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

  it('fails with reason network on a non-200 form page', async () => {
    const form = formAt({ formUrl: `${server.url}` });
    server.setPage('');
    // A page with no form at all is a structural problem, not a transport one.
    const result = await submitForm(form, DEMO_PROFILE, DEMO_REQUEST);

    expect(result).toMatchObject({ ok: false, reason: 'schema' });
  });

  it('fails with reason schema when the mapping names a field the form definition did not supply', async () => {
    const form = demoForm(
      demoSchema({
        formUrl: server.url,
        request: { topic: { name: 'q_topic' }, whenDate: { name: 'q_when', type: 'date' } },
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
      detail: 'Fields not found on the form: q_when',
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
