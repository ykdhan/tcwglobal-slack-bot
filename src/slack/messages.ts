import type { KnownBlock } from '@slack/types';

import type { SubmitFailure } from '../formstack/engine.js';
import type { FormDefinition } from '../forms/types.js';
import { PROFILE_KEYS, PROFILE_LABELS, type Profile } from '../profile.js';

/**
 * The DMs the bot sends after a submission.
 *
 * Both are built from `form.summarize`, so a new form needs no changes here.
 */

const DETAIL_LIMIT = 300;

/** Copy for each failure the user can actually be told something useful about. */
const REASONS: Record<SubmitFailure['reason'], { title: string; fix: string }> = {
  schema: {
    title: 'The form structure has changed',
    fix: "Re-run the extract-schema script and update the form's schema.json",
  },
  network: {
    title: 'Could not reach the form (retried 3 times)',
    fix: 'Try again in a few minutes',
  },
  unconfirmed: {
    title: 'Could not confirm whether the submission went through',
    fix: 'Check the form for a duplicate entry before resubmitting',
  },
  // Rejections are shown inline in the modal, where the user still has their
  // input. This entry exists so an unexpected path still produces a message.
  rejected: {
    title: 'The form rejected the submission',
    fix: 'Correct the values and submit again',
  },
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** A fixed-width label/value block, sized so the values line up when pasted. */
function copyBlock(lines: Array<[string, string]>): string {
  const width = Math.max(...lines.map(([label]) => label.length));
  const body = lines.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
  return `\`\`\`\n${body}\n\`\`\``;
}

export function successBlocks<T>(form: FormDefinition<T>, request: T): KnownBlock[] {
  const summary = form
    .summarize(request)
    .map(([label, value]) => `*${label}* · ${truncate(value, 200)}`)
    .join('\n');

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: *Your ${form.label} was submitted*` },
    },
    { type: 'section', text: { type: 'mrkdwn', text: summary } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          // The only defence against a date-format mistake: the user sees the
          // values that were actually sent, not the ones they think they sent.
          text: 'These are the values that were submitted. Let the form owner know if anything looks wrong.',
        },
      ],
    },
  ];
}

export function failureBlocks<T>(
  form: FormDefinition<T>,
  profile: Profile,
  request: T,
  result: SubmitFailure,
): KnownBlock[] {
  const reason = REASONS[result.reason];

  const values: Array<[string, string]> = [
    ...PROFILE_KEYS.map((key) => [PROFILE_LABELS[key], profile[key]] as [string, string]),
    ...form.summarize(request),
  ];

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:x: *Could not submit your ${form.label}*` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reason* · ${reason.title}\n\`${truncate(result.detail, DETAIL_LIMIT)}\``,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open the form' },
          url: form.schema.formUrl,
          action_id: 'open_form_url',
        },
      ],
    },
    {
      type: 'section',
      // Everything needed to submit by hand. If the bot is broken for a week,
      // this block is what keeps the user unblocked in the meantime.
      text: {
        type: 'mrkdwn',
        text: `Copy these values and submit manually:\n${copyBlock(values)}`,
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `*Fix* · ${reason.fix}` }],
    },
  ];
}
