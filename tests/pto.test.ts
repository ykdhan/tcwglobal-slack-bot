import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { submitForm } from '../src/formstack/engine.js';
import { parseFormPage } from '../src/formstack/formPage.js';
import { requiredFieldNames } from '../src/formstack/schema.js';
import { PtoRequestSchema, ptoForm, type PtoRequest } from '../src/forms/pto/index.js';
import type { FormDefinition } from '../src/forms/types.js';
import { DEMO_PROFILE, startFormServer, type FormServer } from './helpers/syntheticForm.js';

/** A snapshot of the real form page, taken with curl. Never submitted to. */
const FIXTURE = readFileSync(new URL('./fixtures/pto-form.html', import.meta.url), 'utf8');

const REQUEST: PtoRequest = {
  startDate: '2026-08-17',
  endDate: '2026-08-21',
  category: 'Vacation',
  comments: 'Family trip',
};

let server: FormServer;

/**
 * The real PTO definition, pointed at a local copy of the form.
 *
 * `action` has to be overridden as well as `formUrl`: the snapshot advertises
 * the real submit endpoint, and the engine prefers what the page says.
 */
function ptoAgainstFixture(): FormDefinition<PtoRequest> {
  return { ...ptoForm, schema: { ...ptoForm.schema, formUrl: server.url, action: server.url } };
}

beforeEach(async () => {
  server = await startFormServer();

  // The engine posts where the page says to, and the snapshot says to post to
  // the real form. Redirect it at the local server before serving it.
  server.setPage(
    FIXTURE.replace(
      /https:\\?\/\\?\/targetcw\.formstack\.com\\?\/forms\\?\/index\.php/g,
      server.url,
    ),
  );
  server.setResponse(`<html><body>${ptoForm.schema.successMarker}</body></html>`);
});

afterEach(async () => {
  await server.close();
});

describe('the committed form snapshot', () => {
  const page = parseFormPage(FIXTURE);

  it('carries a form definition with no <form> element in sight', () => {
    expect(FIXTURE).not.toContain('<form ');
    expect(page.fields.size).toBeGreaterThan(0);
  });

  it('advertises every field the mapping needs', () => {
    for (const name of requiredFieldNames(ptoForm.schema)) {
      expect(page.fields.has(name), `${name} is missing from the form`).toBe(true);
    }
  });

  it('carries the values a submission has to echo back', () => {
    expect(page.hidden.form).toBe('6108501');
    expect(page.hidden.viewkey).toBe('BbOmizxjYm');
    expect(page.hidden.formstackFormSchemaVersion).toBe('4');
    expect(page.hidden._submit).toBe('1');
    expect(page.hidden.displayTime).toBeTruthy();
  });

  it('advertises where to post', () => {
    expect(page.action).toBe('https://targetcw.formstack.com/forms/index.php');
  });
});

describe('pto submission body', () => {
  it('splits the worker name across the two inputs the form exposes', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field180619082-first')).toBe('Gildong');
    expect(body?.get('field180619082-last')).toBe('Hong');
  });

  it('sends the rest of the profile under the form field names', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field180619083')).toBe(DEMO_PROFILE.email);
    expect(body?.get('field180619084')).toBe(DEMO_PROFILE.clientName);
    expect(body?.get('field180619086')).toBe(DEMO_PROFILE.supervisorName);
    expect(body?.get('field180619087')).toBe(DEMO_PROFILE.supervisorEmail);
    expect(body?.get('field180619088')).toBe('South Korea - APAC Region');
  });

  it('posts dates as Formstack datetime parts, with an abbreviated month', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field180756707M')).toBe('Aug');
    expect(body?.get('field180756707D')).toBe('17');
    expect(body?.get('field180756707Y')).toBe('2026');
    expect(body?.get('field180756796M')).toBe('Aug');
    expect(body?.get('field180756796D')).toBe('21');
    expect(body?.get('field180756796Y')).toBe('2026');
  });

  it('sends the category and an empty companion when a preset was chosen', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('field180757964')).toBe('Vacation');
    // The renderer posts this either way, so it is present and empty.
    expect(body?.get('field180757964_other')).toBe('');
  });

  it('sends the literal Other plus the typed text when Other was chosen', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, {
      ...REQUEST,
      category: 'Other',
      otherCategory: 'Parental leave',
    });
    const body = server.lastBody();

    expect(body?.get('field180757964')).toBe('Other');
    expect(body?.get('field180757964_other')).toBe('Parental leave');
  });

  it('echoes the page values back', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);
    const body = server.lastBody();

    expect(body?.get('form')).toBe('6108501');
    expect(body?.get('viewkey')).toBe('BbOmizxjYm');
    expect(body?.get('_submit')).toBe('1');
    expect(body?.get('formstackFormRendererVersion')).toBe('7.52.7');
  });

  it('omits the comments field when none were entered', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, { ...REQUEST, comments: undefined });

    expect(server.lastBody()?.has('field180812258')).toBe(false);
  });

  it('never posts a total-days field, which the form does not have', async () => {
    await submitForm(ptoAgainstFixture(), DEMO_PROFILE, REQUEST);

    for (const name of server.lastBody()?.keys() ?? []) {
      expect(name).not.toMatch(/total/i);
    }
  });
});

describe('pto request validation', () => {
  it('accepts a well-formed request', () => {
    expect(PtoRequestSchema.safeParse(REQUEST).success).toBe(true);
  });

  it('rejects a date that is not ISO formatted', () => {
    expect(PtoRequestSchema.safeParse({ ...REQUEST, startDate: '17 August 2026' }).success).toBe(
      false,
    );
  });

  it('flags an end date before the start date, against the end date block', () => {
    expect(ptoForm.validate?.({ ...REQUEST, endDate: '2026-08-16' })).toEqual({
      blockId: 'end_date_block',
      message: 'End date must be on or after the start date.',
    });
  });

  it('allows a single-day request', () => {
    expect(ptoForm.validate?.({ ...REQUEST, endDate: REQUEST.startDate })).toBeNull();
  });

  it('requires a description when the category is Other', () => {
    expect(ptoForm.validate?.({ ...REQUEST, category: 'Other' })).toEqual({
      blockId: 'other_category_block',
      message: 'Describe the category, since you chose Other.',
    });
    expect(ptoForm.validate?.({ ...REQUEST, category: 'Other', otherCategory: '  ' })).toEqual({
      blockId: 'other_category_block',
      message: 'Describe the category, since you chose Other.',
    });
  });

  it('accepts Other once it is described', () => {
    expect(
      ptoForm.validate?.({ ...REQUEST, category: 'Other', otherCategory: 'Parental leave' }),
    ).toBeNull();
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
        'start_date_block',
        'end_date_block',
        'category_block',
        'other_category_block',
        'comments_block',
      ]),
    );
  });

  it('offers exactly the categories the form accepts, Other included', () => {
    const block = modal.blocks.find(
      (b) => (b as { block_id?: string }).block_id === 'category_block',
    ) as unknown as { element: { options: { value: string }[] } };

    expect(block.element.options.map((option) => option.value)).toEqual([
      'Vacation',
      'Sick',
      'Other',
    ]);
  });

  it('asks for nothing the form does not have', () => {
    expect(JSON.stringify(modal)).not.toMatch(/total days/i);
  });

  it('shows who the request is for, and a way to correct it', () => {
    const text = JSON.stringify(modal.blocks);

    expect(text).toContain('Gildong Hong');
    expect(text).toContain('open_profile');
  });

  it('summarizes a request for the confirmation DM', () => {
    expect(ptoForm.summarize(REQUEST)).toEqual([
      ['Dates', '2026-08-17 ~ 2026-08-21'],
      ['Category', 'Vacation'],
      ['Comments', 'Family trip'],
    ]);
  });

  it('spells out a free-text category in the summary', () => {
    expect(
      ptoForm.summarize({ ...REQUEST, category: 'Other', otherCategory: 'Parental leave' }),
    ).toContainEqual(['Category', 'Other — Parental leave']);
  });
});
