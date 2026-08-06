import { describe, expect, it } from 'vitest';

import { submitForm } from '../src/formstack/engine.js';
import { forms } from '../src/forms/registry.js';
import { ptoForm, type PtoRequest } from '../src/forms/pto/index.js';
import { homeView } from '../src/slack/home.js';
import { failureBlocks, successBlocks } from '../src/slack/messages.js';
import { parseProfileMeta, profileModal } from '../src/slack/profileModal.js';
import { DEMO_PROFILE } from './helpers/syntheticForm.js';

type Block = { type: string; block_id?: string; elements?: unknown[]; text?: { text?: string } };

const REQUEST: PtoRequest = {
  startDate: '2026-08-17',
  endDate: '2026-08-21',
  category: 'Vacation',
};

function buttons(blocks: unknown[]): Array<{ text: { text: string }; action_id: string }> {
  return (blocks as Block[])
    .filter((block) => block.type === 'actions')
    .flatMap(
      (block) => (block.elements ?? []) as Array<{ text: { text: string }; action_id: string }>,
    );
}

describe('home view', () => {
  it('offers setup and nothing else when there is no profile', () => {
    const view = homeView(null);
    const actions = buttons(view.blocks);

    expect(actions.map((b) => b.action_id)).toEqual(['open_profile']);
    expect(actions[0]?.text.text).toBe('Set up my information');
  });

  it('shows the saved details when there is a profile', () => {
    const text = JSON.stringify(homeView(DEMO_PROFILE).blocks);

    expect(text).toContain('Gildong Hong');
    expect(text).toContain(DEMO_PROFILE.email);
    expect(text).toContain(DEMO_PROFILE.clientName);
    expect(text).toContain(DEMO_PROFILE.country);
    expect(text).toContain(DEMO_PROFILE.supervisorName);
    expect(text).toContain(DEMO_PROFILE.supervisorEmail);
  });

  it('renders one request button per registered form, plus Edit info', () => {
    const actions = buttons(homeView(DEMO_PROFILE).blocks);

    // Driven by the registry: a second form appears here with no edit to home.ts.
    expect(actions.map((b) => b.action_id)).toEqual([
      ...forms.map((form) => `open_request:${form.id}`),
      'open_profile',
    ]);
    expect(actions.map((b) => b.text.text)).toContain(`New ${ptoForm.label}`);
  });

  it('shows no submission history or timestamps', () => {
    const text = JSON.stringify(homeView(DEMO_PROFILE));

    expect(text.toLowerCase()).not.toContain('last updated');
    expect(text.toLowerCase()).not.toContain('history');
  });
});

describe('profile modal', () => {
  it('collects every profile field', () => {
    const view = profileModal({ meta: { next: 'close' } });
    const blockIds = (view.blocks as Block[]).map((block) => block.block_id).filter(Boolean);

    expect(blockIds).toEqual(
      expect.arrayContaining([
        'first_name_block',
        'last_name_block',
        'email_block',
        'client_name_block',
        'country_block',
        'supervisor_name_block',
        'supervisor_email_block',
      ]),
    );
  });

  it('searches the countries the form accepts, rather than listing them', () => {
    const view = profileModal({ meta: { next: 'close' } });
    const country = (view.blocks as Block[]).find(
      (block) => block.block_id === 'country_block',
    ) as unknown as { element: { type: string; action_id: string } };

    // 189 options do not fit a static select, which Slack caps at 100.
    expect(ptoForm.schema.profile.country.options!.length).toBeGreaterThan(100);
    expect(country.element.type).toBe('external_select');
    expect(country.element.action_id).toBe('country');
  });

  it('preselects a stored country so it survives a re-open', () => {
    const view = profileModal({ initial: DEMO_PROFILE, meta: { next: 'close' } });

    expect(JSON.stringify(view.blocks)).toContain(DEMO_PROFILE.country);
  });

  it('prefills what it already knows', () => {
    const view = profileModal({ initial: DEMO_PROFILE, meta: { next: 'close' } });

    expect(JSON.stringify(view.blocks)).toContain(DEMO_PROFILE.clientName);
  });

  it('offers removal only once something is stored', () => {
    const empty = JSON.stringify(profileModal({ meta: { next: 'close' } }));
    const filled = JSON.stringify(profileModal({ initial: DEMO_PROFILE, meta: { next: 'close' } }));

    expect(empty).not.toContain('forget_profile');
    expect(filled).toContain('forget_profile');
  });

  it('round-trips its metadata', () => {
    const view = profileModal({ meta: { next: 'open_request', formId: 'pto' } });

    expect(parseProfileMeta(view.private_metadata)).toEqual({
      next: 'open_request',
      formId: 'pto',
    });
  });

  it('falls back to closing when the metadata is unusable', () => {
    expect(parseProfileMeta(undefined)).toEqual({ next: 'close' });
    expect(parseProfileMeta('not json')).toEqual({ next: 'close' });
  });
});

describe('success message', () => {
  const blocks = successBlocks(ptoForm, REQUEST);

  it('names the form and echoes every submitted value', () => {
    const text = JSON.stringify(blocks);

    expect(text).toContain(ptoForm.label);
    for (const [label, value] of ptoForm.summarize(REQUEST)) {
      expect(text).toContain(label);
      expect(text).toContain(value);
    }
  });
});

describe('failure message', () => {
  const failure = {
    ok: false as const,
    reason: 'schema' as const,
    detail: 'Fields not found on the form: field180756707',
  };
  const blocks = failureBlocks(ptoForm, DEMO_PROFILE, REQUEST, failure);
  const text = JSON.stringify(blocks);

  it('states the reason and the raw detail', () => {
    expect(text).toContain('The form structure has changed');
    expect(text).toContain('field180756707');
  });

  it('links to the form', () => {
    expect(text).toContain(ptoForm.schema.formUrl);
    expect(text).toContain('Open the form');
  });

  it('carries everything needed to submit by hand', () => {
    for (const value of Object.values(DEMO_PROFILE)) {
      expect(text).toContain(value);
    }
    for (const [, value] of ptoForm.summarize(REQUEST)) {
      expect(text).toContain(value);
    }
  });

  it('tells the operator what to do about it', () => {
    expect(text).toContain('schema.json');
  });

  it('truncates a runaway detail instead of blowing the block limit', () => {
    const long = failureBlocks(ptoForm, DEMO_PROFILE, REQUEST, {
      ok: false,
      reason: 'network',
      detail: 'x'.repeat(5_000),
    });

    expect(JSON.stringify(long)).not.toContain('x'.repeat(400));
  });

  it('never tells the user to simply retry an unconfirmed submission', () => {
    const unconfirmed = JSON.stringify(
      failureBlocks(ptoForm, DEMO_PROFILE, REQUEST, {
        ok: false,
        reason: 'unconfirmed',
        detail: 'Success marker not found in the response',
      }),
    );

    expect(unconfirmed).toContain('duplicate');
  });
});

describe('form-agnostic messaging', () => {
  it('builds both messages for a form it has never seen', async () => {
    // The message builders read everything from the definition, so a second form
    // needs no edit here. This is the check that keeps that true.
    const other = {
      id: 'other',
      label: 'Expense request',
      schema: { ...ptoForm.schema, formUrl: 'https://example.invalid/expense' },
      requestSchema: ptoForm.requestSchema,
      buildModal: ptoForm.buildModal,
      toFieldValues: () => ({}),
      summarize: () => [['Amount', '120.00'] as [string, string]],
    };

    expect(JSON.stringify(successBlocks(other, REQUEST))).toContain('Expense request');
    expect(
      JSON.stringify(
        failureBlocks(other, DEMO_PROFILE, REQUEST, {
          ok: false,
          reason: 'network',
          detail: 'timeout',
        }),
      ),
    ).toContain('120.00');
    expect(typeof submitForm).toBe('function');
  });
});
