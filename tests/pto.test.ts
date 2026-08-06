import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { submitForm } from '../src/formstack/engine.js';
import { requiredFieldNames } from '../src/formstack/schema.js';
import { PtoRequestSchema, ptoForm, type PtoRequest } from '../src/forms/pto/index.js';
import type { FormDefinition } from '../src/forms/types.js';
import { DEMO_PROFILE, startFormServer, type FormServer } from './helpers/syntheticForm.js';

const FIXTURE = readFileSync(new URL('./fixtures/pto-form.html', import.meta.url), 'utf8');

const REQUEST: PtoRequest = {
  leaveType: 'Vacation',
  startDate: '2026-08-17',
  endDate: '2026-08-21',
  totalDays: 5,
  comments: 'Family trip',
};

let server: FormServer;

/** The real PTO definition, pointed at a local copy of the form. */
function ptoAgainstFixture(): FormDefinition<PtoRequest> {
  return { ...ptoForm, schema: { ...ptoForm.schema, formUrl: server.url } };
}

beforeEach(async () => {
  server = await startFormServer(FIXTURE);
  server.setResponse(`<html><body>${ptoForm.schema.successMarker}</body></html>`);
});

afterEach(async () => {
  await server.close();
});

describe('pto schema', () => {
  it('maps every field the committed fixture exposes', async () => {
    const result = await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);

    expect(result).toEqual({ ok: true });
  });

  it('names only fields that exist on the fixture', () => {
    const present = new Set(FIXTURE.match(/name="([^"]+)"/g)?.map((m) => m.slice(6, -1)) ?? []);

    for (const name of requiredFieldNames(ptoForm.schema)) {
      expect(present.has(name), `${name} is missing from the fixture`).toBe(true);
    }
  });
});

describe('pto submission body', () => {
  it('sends the profile and the request under the form field names', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field10000001')).toBe(DEMO_PROFILE.fullName);
    expect(body?.get('field10000005')).toBe(DEMO_PROFILE.country);
    expect(body?.get('field10000008')).toBe('Vacation');
    expect(body?.get('field10000011')).toBe('5');
    expect(body?.get('field10000012')).toBe('Family trip');
  });

  it('formats dates as the schema declares', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field10000009')).toBe('08/17/2026');
    expect(body?.get('field10000010')).toBe('08/21/2026');
  });

  it('preserves the hidden session values and the honeypot', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('form')).toBe('1000000');
    expect(body?.get('form_token')).toBe('7f3a91c4d2e58b60');
    expect(body?.get('fsSpamTrap')).toBe('');
  });

  it('omits comments when none were entered', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, { ...REQUEST, comments: undefined });

    expect(server.lastBody()?.has('field10000012')).toBe(false);
  });
});

describe('pto request validation', () => {
  it('accepts a well-formed request', () => {
    expect(PtoRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it('rejects a non-positive day count', () => {
    expect(PtoRequestSchema.safeParse({ ...REQUEST, totalDays: 0 }).success).toBe(false);
  });

  it('rejects a date that is not ISO formatted', () => {
    expect(PtoRequestSchema.safeParse({ ...REQUEST, startDate: '08/17/2026' }).success).toBe(false);
  });

  it('flags an end date before the start date, against the end date block', () => {
    const error = ptoForm.validate?.({ ...REQUEST, endDate: '2026-08-16' });

    expect(error).toEqual({
      blockId: 'end_date_block',
      message: 'End date must be on or after the start date.',
    });
  });

  it('allows a single-day request', () => {
    expect(ptoForm.validate?.({ ...REQUEST, endDate: REQUEST.startDate, totalDays: 1 })).toBeNull();
  });
});

describe('pto modal', () => {
  const modal = ptoForm.buildModal(DEMO_PROFILE);

  it('uses the callback_id the handler registration derives from the form id', () => {
    expect(modal.callback_id).toBe(`${ptoForm.id}_request_modal`);
  });

  it('gives every input the block_id its inline errors are addressed to', () => {
    const blockIds = modal.blocks.map((block) => (block as { block_id?: string }).block_id);

    expect(blockIds).toEqual(
      expect.arrayContaining([
        'leave_type_block',
        'start_date_block',
        'end_date_block',
        'total_days_block',
        'comments_block',
      ]),
    );
  });

  it('offers exactly the leave types the schema declares', () => {
    const block = modal.blocks.find(
      (b) => (b as { block_id?: string }).block_id === 'leave_type_block',
    ) as { element: { options: { value: string }[] } };

    expect(block.element.options.map((option) => option.value)).toEqual(
      ptoForm.schema.request.leaveType?.options,
    );
  });

  it('offers a way back to the profile without leaving the request', () => {
    expect(JSON.stringify(modal.blocks)).toContain('open_profile');
  });

  it('summarizes a request for the confirmation DM', () => {
    expect(ptoForm.summarize(REQUEST)).toEqual([
      ['Leave type', 'Vacation'],
      ['Dates', '2026-08-17 ~ 2026-08-21'],
      ['Total days', '5'],
      ['Comments', 'Family trip'],
    ]);
  });
});
