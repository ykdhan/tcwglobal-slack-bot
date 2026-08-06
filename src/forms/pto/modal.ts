import type { KnownBlock, ModalView } from '@slack/types';

import type { Profile } from '../../profile.js';
import { blockIdFor } from '../../slack/values.js';
import type { FormSchema } from '../types.js';

/**
 * The PTO request modal.
 *
 * Only the fields that change per request. Everything else comes from the saved
 * profile, shown at the top so the user can see what is about to be submitted on
 * their behalf — and correct it without losing what they have typed.
 */
export function buildPtoModal(schema: FormSchema, profile: Profile): ModalView {
  const leaveTypes = schema.request.leaveType?.options ?? [];

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${profile.fullName}* · ${profile.clientName} · ${profile.country}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Edit info' },
        action_id: 'open_profile',
      },
    },
    { type: 'divider' },
    {
      type: 'input',
      block_id: blockIdFor('leaveType'),
      label: { type: 'plain_text', text: 'Leave type' },
      element: {
        type: 'radio_buttons',
        action_id: 'leaveType',
        options: leaveTypes.map((option) => ({
          text: { type: 'plain_text', text: option },
          value: option,
        })),
      },
    },
    {
      type: 'input',
      block_id: blockIdFor('startDate'),
      label: { type: 'plain_text', text: 'First day of leave' },
      element: { type: 'datepicker', action_id: 'startDate' },
    },
    {
      type: 'input',
      block_id: blockIdFor('endDate'),
      label: { type: 'plain_text', text: 'Last day of leave' },
      element: { type: 'datepicker', action_id: 'endDate' },
    },
    {
      type: 'input',
      block_id: blockIdFor('totalDays'),
      label: { type: 'plain_text', text: 'Total days requested' },
      element: { type: 'number_input', action_id: 'totalDays', is_decimal_allowed: true },
      hint: { type: 'plain_text', text: 'Working days, not calendar days.' },
    },
    {
      type: 'input',
      block_id: blockIdFor('comments'),
      optional: true,
      label: { type: 'plain_text', text: 'Comments' },
      element: {
        type: 'plain_text_input',
        action_id: 'comments',
        multiline: true,
      },
    },
  ];

  return {
    type: 'modal',
    callback_id: 'pto_request_modal',
    title: { type: 'plain_text', text: 'New PTO request' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}
