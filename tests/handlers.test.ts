import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_PROFILE, startFormServer, type FormServer } from './helpers/syntheticForm.js';

const FIXTURE = readFileSync(new URL('./fixtures/pto-form.html', import.meta.url), 'utf8');

const USER = 'U01ABCDEF';

/**
 * The whole Slack flow, without Slack.
 *
 * Bolt is replaced by a recorder that captures every registration, so each
 * handler can be driven with the payload Slack would send. This is the only
 * place the App Home refresh, the modal chaining and a real submission are
 * exercised together — and a missing `views.publish` is invisible in manual
 * testing, because reopening the app re-renders it anyway.
 */
type Handler = (args: any) => Promise<void>;

class RecordingApp {
  middleware: Handler[] = [];
  events = new Map<string, Handler>();
  actions = new Map<string, Handler>();
  viewHandlers = new Map<string, Handler>();

  use(fn: Handler) {
    this.middleware.push(fn);
  }
  event(name: string, fn: Handler) {
    this.events.set(name, fn);
  }
  action(id: string, fn: Handler) {
    this.actions.set(id, fn);
  }
  view(id: string, fn: Handler) {
    this.viewHandlers.set(id, fn);
  }
}

function fakeClient() {
  return {
    views: {
      publish: vi.fn().mockResolvedValue({ ok: true }),
      open: vi.fn().mockResolvedValue({ ok: true }),
      push: vi.fn().mockResolvedValue({ ok: true }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
    users: {
      info: vi.fn().mockResolvedValue({
        user: { profile: { real_name: 'Hong Gildong', email: 'gildong@example.com' } },
      }),
    },
  };
}

const PROFILE_STATE = {
  full_name_block: { fullName: { type: 'plain_text_input', value: 'Hong Gildong' } },
  email_block: { email: { type: 'plain_text_input', value: 'gildong@example.com' } },
  employee_id_block: { employeeId: { type: 'plain_text_input', value: 'EMP-1024' } },
  client_name_block: { clientName: { type: 'plain_text_input', value: 'Acme Corp' } },
  country_block: { country: { type: 'static_select', selected_option: { value: 'South Korea' } } },
  manager_name_block: { managerName: { type: 'plain_text_input', value: 'Jane Doe' } },
  manager_email_block: { managerEmail: { type: 'plain_text_input', value: 'jane@acme.com' } },
};

const REQUEST_STATE = {
  leave_type_block: {
    leaveType: { type: 'radio_buttons', selected_option: { value: 'Vacation' } },
  },
  start_date_block: { startDate: { type: 'datepicker', selected_date: '2026-08-17' } },
  end_date_block: { endDate: { type: 'datepicker', selected_date: '2026-08-21' } },
  total_days_block: { totalDays: { type: 'number_input', value: '5' } },
  comments_block: { comments: { type: 'plain_text_input', value: 'Family trip' } },
};

const REQUEST_BLOCKS = Object.keys(REQUEST_STATE).map((block_id) => ({ type: 'input', block_id }));

let dir: string;
let server: FormServer;
let app: RecordingApp;
let client: ReturnType<typeof fakeClient>;
let modules: {
  registerHandlers: (app: never) => void;
  ptoForm: { schema: { formUrl: string; successMarker: string } };
  registry: { forms: any[] };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tcwglobal-handlers-'));
  process.env.DATA_FILE = join(dir, 'profiles.json');

  server = await startFormServer(FIXTURE);

  vi.resetModules();
  const [{ registerHandlers }, { ptoForm }, registry] = await Promise.all([
    import('../src/slack/handlers.js'),
    import('../src/forms/pto/index.js'),
    import('../src/forms/registry.js'),
  ]);
  modules = { registerHandlers, ptoForm, registry };

  // Point the real form definition at a local copy of the form. Nothing in the
  // suite is allowed to touch the live form.
  ptoForm.schema.formUrl = server.url;
  server.setResponse(`<html><body>${ptoForm.schema.successMarker}</body></html>`);

  app = new RecordingApp();
  client = fakeClient();
  registerHandlers(app as never);
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

/** Run the profile modal submission, which is how a profile gets stored. */
async function saveProfileThroughModal(meta: object = { next: 'close' }) {
  const ack = vi.fn().mockResolvedValue(undefined);
  await app.viewHandlers.get('profile_modal')!({
    ack,
    body: { user: { id: USER } },
    view: { state: { values: PROFILE_STATE }, private_metadata: JSON.stringify(meta) },
    client,
  });
  return ack;
}

describe('app home', () => {
  it('publishes the setup view to a user with no profile', async () => {
    await app.events.get('app_home_opened')!({
      event: { tab: 'home', user: USER },
      client,
    });

    expect(client.views.publish).toHaveBeenCalledTimes(1);
    const view = client.views.publish.mock.calls[0]![0].view;
    expect(JSON.stringify(view)).toContain('Set up my information');
  });

  it('ignores the messages tab', async () => {
    await app.events.get('app_home_opened')!({
      event: { tab: 'messages', user: USER },
      client,
    });

    expect(client.views.publish).not.toHaveBeenCalled();
  });
});

describe('profile setup', () => {
  it('opens a prefilled modal that continues into a request', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);

    await app.actions.get('open_profile')!({
      ack,
      body: { user: { id: USER }, trigger_id: 'TRIGGER', view: { type: 'home', id: 'V_HOME' } },
      client,
    });

    expect(ack).toHaveBeenCalled();
    const view = client.views.open.mock.calls[0]![0].view;
    expect(view.callback_id).toBe('profile_modal');
    // Name and email come from Slack, so first-time setup is mostly filled in.
    expect(JSON.stringify(view)).toContain('Hong Gildong');
    expect(JSON.parse(view.private_metadata)).toEqual({ next: 'open_request', formId: 'pto' });
  });

  it('stores the profile and refreshes the home tab', async () => {
    const ack = await saveProfileThroughModal();

    expect(ack).toHaveBeenCalledWith({ response_action: 'clear' });
    expect(client.views.publish).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client.views.publish.mock.calls[0]![0].view)).toContain(
      'New PTO request',
    );
  });

  it('continues straight into the request modal after first-time setup', async () => {
    const ack = await saveProfileThroughModal({ next: 'open_request', formId: 'pto' });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'update',
      view: expect.objectContaining({ callback_id: 'pto_request_modal' }),
    });
  });

  it('reports bad input inline instead of saving it', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);

    await app.viewHandlers.get('profile_modal')!({
      ack,
      body: { user: { id: USER } },
      view: {
        state: {
          values: {
            ...PROFILE_STATE,
            email_block: { email: { type: 'plain_text_input', value: 'not-an-email' } },
          },
        },
        private_metadata: JSON.stringify({ next: 'close' }),
      },
      client,
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: expect.objectContaining({ email_block: expect.any(String) }),
    });
    expect(client.views.publish).not.toHaveBeenCalled();
  });

  it('pushes over a request modal and updates it once saved', async () => {
    await saveProfileThroughModal();
    client.views.publish.mockClear();

    const ack = vi.fn().mockResolvedValue(undefined);
    await app.actions.get('open_profile')!({
      ack,
      body: {
        user: { id: USER },
        trigger_id: 'TRIGGER',
        view: { type: 'modal', id: 'V_REQUEST', callback_id: 'pto_request_modal' },
      },
      client,
    });

    expect(client.views.open).not.toHaveBeenCalled();
    const meta = JSON.parse(client.views.push.mock.calls[0]![0].view.private_metadata);
    expect(meta).toEqual({ next: 'close', parentViewId: 'V_REQUEST', formId: 'pto' });

    await saveProfileThroughModal(meta);

    // The request the user was part-way through is rebuilt with the new details.
    expect(client.views.update).toHaveBeenCalledWith({
      view_id: 'V_REQUEST',
      view: expect.objectContaining({ callback_id: 'pto_request_modal' }),
    });
  });

  it('forgets a profile and refreshes the home tab', async () => {
    await saveProfileThroughModal();
    client.views.publish.mockClear();

    const ack = vi.fn().mockResolvedValue(undefined);
    await app.actions.get('forget_profile')!({
      ack,
      body: { user: { id: USER }, view: { id: 'V_PROFILE' } },
      client,
    });

    expect(JSON.stringify(client.views.publish.mock.calls[0]![0].view)).toContain(
      'Set up my information',
    );
    expect(client.views.update).toHaveBeenCalled();
  });
});

describe('request submission', () => {
  async function submit(state: object = REQUEST_STATE) {
    const ack = vi.fn().mockResolvedValue(undefined);
    await app.viewHandlers.get('pto_request_modal')!({
      ack,
      body: { user: { id: USER } },
      view: { state: { values: state }, blocks: REQUEST_BLOCKS },
      client,
    });
    return ack;
  }

  it('opens the request modal for a user who has a profile', async () => {
    await saveProfileThroughModal();

    const ack = vi.fn().mockResolvedValue(undefined);
    await app.actions.get('open_request:pto')!({
      ack,
      body: { user: { id: USER }, trigger_id: 'TRIGGER' },
      client,
    });

    expect(client.views.open.mock.calls[0]![0].view.callback_id).toBe('pto_request_modal');
  });

  it('sends a user with no profile back to the home tab', async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    await app.actions.get('open_request:pto')!({
      ack,
      body: { user: { id: USER }, trigger_id: 'TRIGGER' },
      client,
    });

    expect(client.views.open).not.toHaveBeenCalled();
    expect(client.views.publish).toHaveBeenCalled();
  });

  it('submits the form and confirms by DM', async () => {
    await saveProfileThroughModal();

    const ack = await submit();

    expect(ack).toHaveBeenCalledWith();
    expect(server.postCount()).toBe(1);

    const body = server.lastBody();
    expect(body?.get('field10000001')).toBe('Hong Gildong');
    expect(body?.get('field10000008')).toBe('Vacation');
    expect(body?.get('field10000009')).toBe('08/17/2026');
    expect(body?.get('field10000010')).toBe('08/21/2026');
    expect(body?.get('field10000011')).toBe('5');

    const dm = client.chat.postMessage.mock.calls[0]![0];
    expect(dm.channel).toBe(USER);
    expect(JSON.stringify(dm.blocks)).toContain('2026-08-17 ~ 2026-08-21');
  });

  it('keeps the modal open with an inline error when the end date precedes the start', async () => {
    await saveProfileThroughModal();

    const ack = await submit({
      ...REQUEST_STATE,
      end_date_block: { endDate: { type: 'datepicker', selected_date: '2026-08-16' } },
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: { end_date_block: 'End date must be on or after the start date.' },
    });
    expect(server.postCount()).toBe(0);
  });

  it('keeps the modal open when the form rejects the submission', async () => {
    await saveProfileThroughModal();
    server.setResponse('<div class="fsError">Total days must be a number.</div>');

    const ack = await submit();

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: expect.objectContaining({
        leave_type_block: expect.stringContaining('Total days must be a number.'),
      }),
    });
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it('DMs the manual-submission fallback when the form has changed', async () => {
    await saveProfileThroughModal();
    server.setPage(FIXTURE.replace('name="field10000009"', 'name="field99999999"'));

    const ack = await submit();

    expect(ack).toHaveBeenCalledWith();
    const dm = JSON.stringify(client.chat.postMessage.mock.calls[0]![0].blocks);
    expect(dm).toContain('The form structure has changed');
    expect(dm).toContain('field10000009');
    // Everything needed to submit by hand, including the saved details.
    expect(dm).toContain('EMP-1024');
    expect(dm).toContain('Vacation');
  });

  it('reports missing input inline without submitting', async () => {
    await saveProfileThroughModal();

    const ack = await submit({
      ...REQUEST_STATE,
      start_date_block: { startDate: { type: 'datepicker', selected_date: null } },
    });

    expect(ack).toHaveBeenCalledWith({
      response_action: 'errors',
      errors: expect.objectContaining({ start_date_block: expect.any(String) }),
    });
    expect(server.postCount()).toBe(0);
  });
});

describe('adding a second form', () => {
  // The acceptance test for the architecture: a new form is a directory and a
  // registry entry. If this needs an edit to home.ts or handlers.ts, the
  // FormDefinition interface is wrong.
  it('registers its handlers and appears on the home tab with no shared-code change', async () => {
    const { homeView } = await import('../src/slack/home.js');
    const expense = {
      id: 'expense',
      label: 'Expense request',
      schema: modules.ptoForm.schema,
      requestSchema: { safeParse: () => ({ success: true, data: {} }) },
      buildModal: () => ({ type: 'modal', callback_id: 'expense_request_modal', blocks: [] }),
      toFieldValues: () => ({}),
      summarize: () => [],
    };

    modules.registry.forms.push(expense);
    try {
      const second = new RecordingApp();
      modules.registerHandlers(second as never);

      expect(second.actions.has('open_request:expense')).toBe(true);
      expect(second.viewHandlers.has('expense_request_modal')).toBe(true);

      const actionIds = (homeView(DEMO_PROFILE).blocks as any[])
        .filter((block) => block.type === 'actions')
        .flatMap((block) => block.elements)
        .map((element: { action_id: string }) => element.action_id);

      expect(actionIds).toEqual(['open_request:pto', 'open_request:expense', 'open_profile']);
    } finally {
      modules.registry.forms.pop();
    }
  });
});

describe('global middleware', () => {
  it('registers none', () => {
    // There is no workspace allowlist: the bot token already scopes the app to
    // one workspace. A middleware appearing here means something reinstated a
    // check that the deployment does not configure.
    expect(app.middleware).toHaveLength(0);
  });
});
