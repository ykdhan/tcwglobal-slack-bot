import type {
  AllMiddlewareArgs,
  App,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

import { submitForm, withRetry } from '../formstack/engine.js';
import { forms, getForm } from '../forms/registry.js';
import type { FormDefinition } from '../forms/types.js';
import { logger } from '../logger.js';
import { ProfileSchema, type Profile } from '../profile.js';
import { forgetProfile, getProfile, saveProfile } from '../store/profiles.js';
import { homeView } from './home.js';
import { failureBlocks, successBlocks } from './messages.js';
import { matchCountries, parseProfileMeta, profileModal } from './profileModal.js';
import { flattenValues, toBlockErrors } from './values.js';

const INLINE_DETAIL_LIMIT = 140;

/**
 * Republish the Home tab.
 *
 * The Home tab does not refresh itself, so every path that changes a profile
 * has to call this. Forgetting is invisible in local testing — reopening the app
 * re-renders — and shows up as permanently stale details for everyone else.
 */
async function refreshHome(client: WebClient, userId: string): Promise<void> {
  await client.views.publish({ user_id: userId, view: homeView(getProfile(userId)) });
}

/** The block inline errors are attached to when they belong to no single field. */
function firstInputBlockId(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const input = blocks.find(
    (block: { type?: string; block_id?: string }) => block?.type === 'input' && block.block_id,
  ) as { block_id?: string } | undefined;
  return input?.block_id;
}

/** Best-effort prefill for a first-time setup, so most of the modal is already filled. */
async function prefillFromSlack(
  client: WebClient,
  userId: string,
): Promise<Partial<Profile> | undefined> {
  try {
    const result = await client.users.info({ user: userId });
    const slackProfile = result.user?.profile;

    // Slack exposes first and last name separately, but they are often empty
    // where real_name is not; splitting on the first space is the usual reading
    // and the user can correct it before saving either way.
    const [first = '', ...rest] = (slackProfile?.real_name ?? '').trim().split(/\s+/);
    const firstName = slackProfile?.first_name || first;
    const lastName = slackProfile?.last_name || rest.join(' ');

    return {
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(slackProfile?.email ? { email: slackProfile.email } : {}),
    };
  } catch (error) {
    // A prefill is a convenience. Failing to read it must not block setup.
    logger.warn({ err: error }, 'could not read the Slack profile for prefill');
    return undefined;
  }
}

/**
 * The request submission handler, one per registered form.
 *
 * The whole submission runs inside the view_submission handler: it finishes in
 * roughly half a second, well inside Slack's 3s budget, and staying synchronous
 * is what lets a rejected submission leave the modal open with the user's input
 * still in it.
 */
function makeSubmitHandler<T>(form: FormDefinition<T>) {
  return async ({
    ack,
    body,
    view,
    client,
  }: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs) => {
    const userId = body.user.id;
    const fallbackBlockId = firstInputBlockId(view.blocks);

    const parsed = form.requestSchema.safeParse(flattenValues(view.state.values));
    if (!parsed.success) {
      await ack({ response_action: 'errors', errors: toBlockErrors(parsed.error) });
      return;
    }
    const request = parsed.data;

    // Errors the user can fix stay inline, where their input still is.
    const invalid = form.validate?.(request);
    if (invalid) {
      await ack({ response_action: 'errors', errors: { [invalid.blockId]: invalid.message } });
      return;
    }

    const profile = getProfile(userId);
    if (!profile) {
      await ack({
        response_action: 'errors',
        errors: fallbackBlockId
          ? { [fallbackBlockId]: 'Set up your information on the app home tab first.' }
          : {},
      });
      return;
    }

    const result = await withRetry(() => submitForm(form, profile, request));

    if (!result.ok && result.reason === 'rejected' && fallbackBlockId) {
      await ack({
        response_action: 'errors',
        errors: { [fallbackBlockId]: result.detail.slice(0, INLINE_DETAIL_LIMIT) },
      });
      return;
    }

    await ack();

    if (result.ok) {
      logger.info({ formId: form.id, userId }, 'submission succeeded');
      await client.chat.postMessage({
        channel: userId,
        text: `Your ${form.label} was submitted.`,
        blocks: successBlocks(form, request),
      });
      return;
    }

    // Errors the operator must fix go to a DM: inline errors are plain text
    // only and cannot carry the form link or the copy-paste block.
    logger.error({ formId: form.id, userId, reason: result.reason }, 'submission failed');
    await client.chat.postMessage({
      channel: userId,
      text: `Could not submit your ${form.label}.`,
      blocks: failureBlocks(form, profile, request, result),
    });
  };
}

/**
 * There is no workspace allowlist.
 *
 * The bot token is scoped to the single workspace the app is installed in, and
 * the app is not distributed (`org_deploy_enabled: false`), so no other
 * workspace can produce events over this Socket Mode connection in the first
 * place. A team ID check would only re-state what the token already guarantees.
 *
 * That stops being true if the app is ever distributed or installed org-wide.
 * If either happens, reinstate a Bolt global middleware here that drops events
 * whose `context.teamId` is not on a configured list.
 */
export function registerHandlers(app: App): void {
  app.event('app_home_opened', async ({ event, client }) => {
    if (event.tab !== 'home') return;
    await client.views.publish({ user_id: event.user, view: homeView(getProfile(event.user)) });
  });

  // The country picker is an external select because the form offers 189
  // options and a Slack static select holds 100. Socket Mode delivers these
  // lookups over the same connection, so no public URL is involved.
  app.options('country', async ({ options, ack }) => {
    await ack({
      options: matchCountries(options.value ?? '').map((country) => ({
        text: { type: 'plain_text', text: country },
        value: country,
      })),
    });
  });

  app.action('open_profile', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    const profile = getProfile(userId);
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;

    const view = (body as { view?: { id: string; type: string; callback_id?: string } }).view;

    // Opened from inside a request modal: push one level so the user comes back
    // to the request they were part-way through. The stack is capped at three,
    // so this only ever pushes one.
    if (view && view.type === 'modal') {
      const formId = view.callback_id?.replace(/_request_modal$/, '');
      await client.views.push({
        trigger_id: triggerId,
        view: profileModal({
          ...(profile ? { initial: profile } : {}),
          meta: {
            next: 'close',
            parentViewId: view.id,
            ...(formId && forms.some((form) => form.id === formId) ? { formId } : {}),
          },
        }),
      });
      return;
    }

    const initial = profile ?? (await prefillFromSlack(client, userId));

    await client.views.open({
      trigger_id: triggerId,
      view: profileModal({
        ...(initial ? { initial } : {}),
        // First-time setup continues straight into a request instead of
        // dropping the user back on the Home tab to press another button.
        meta: profile
          ? { next: 'close' }
          : { next: 'open_request', ...(forms[0] ? { formId: forms[0].id } : {}) },
      }),
    });
  });

  app.action('forget_profile', async ({ ack, body, client }) => {
    await ack();

    const userId = body.user.id;
    forgetProfile(userId);
    await refreshHome(client, userId);

    const viewId = (body as { view?: { id: string } }).view?.id;
    if (!viewId) return;

    await client.views.update({
      view_id: viewId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Your information' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Your information has been removed. Set it up again any time from the app home tab.',
            },
          },
        ],
      },
    });
  });

  // A link button still delivers an action; acknowledging it keeps a warning
  // out of the Slack client.
  app.action('open_form_url', async ({ ack }) => {
    await ack();
  });

  app.view('profile_modal', async ({ ack, body, view, client }) => {
    const userId = body.user.id;

    const parsed = ProfileSchema.safeParse(flattenValues(view.state.values));
    if (!parsed.success) {
      await ack({ response_action: 'errors', errors: toBlockErrors(parsed.error) });
      return;
    }

    saveProfile(userId, parsed.data);
    logger.info({ userId }, 'profile saved');

    const meta = parseProfileMeta(view.private_metadata);

    if (meta.next === 'open_request' && meta.formId) {
      await ack({
        response_action: 'update',
        view: getForm(meta.formId).buildModal(parsed.data),
      });
    } else {
      await ack({ response_action: 'clear' });

      // Pushed from a request modal: put the updated details back on the modal
      // underneath, which is still holding what the user had typed.
      if (meta.parentViewId && meta.formId) {
        await client.views.update({
          view_id: meta.parentViewId,
          view: getForm(meta.formId).buildModal(parsed.data),
        });
      }
    }

    await refreshHome(client, userId);
  });

  for (const form of forms) {
    app.action(`open_request:${form.id}`, async ({ ack, body, client }) => {
      await ack();

      const userId = body.user.id;
      const triggerId = (body as { trigger_id?: string }).trigger_id;
      if (!triggerId) return;

      const profile = getProfile(userId);
      if (!profile) {
        await refreshHome(client, userId);
        return;
      }

      await client.views.open({ trigger_id: triggerId, view: form.buildModal(profile) });
    });

    app.view(`${form.id}_request_modal`, makeSubmitHandler(form));
  }
}
