import type { KnownBlock, ModalView } from '@slack/types';

import { displayName, type Profile } from '../../profile.js';
import { blockIdFor } from '../../slack/values.js';
import type { FormSchema } from '../types.js';
import { OTHER_CATEGORY } from './index.js';

/**
 * The time off request modal.
 *
 * Only the fields that change per request. Everything else comes from the saved
 * profile, shown at the top so the user can see what is about to be submitted on
 * their behalf — and correct it without losing what they have typed.
 */
export function buildPtoModal(schema: FormSchema, profile: Profile): ModalView {
  const categories = schema.request.category?.options ?? [];

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${displayName(profile)}* · ${profile.clientName} · ${profile.country}`,
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
      block_id: blockIdFor('startDate'),
      label: { type: 'plain_text', text: 'Time off start date' },
      element: { type: 'datepicker', action_id: 'startDate' },
    },
    {
      type: 'input',
      block_id: blockIdFor('endDate'),
      label: { type: 'plain_text', text: 'Time off end date' },
      element: { type: 'datepicker', action_id: 'endDate' },
    },
    {
      type: 'input',
      block_id: blockIdFor('category'),
      label: { type: 'plain_text', text: 'Category of time off' },
      element: {
        type: 'radio_buttons',
        action_id: 'category',
        options: categories.map((option) => ({
          text: { type: 'plain_text', text: option },
          value: option,
        })),
      },
    },
    {
      type: 'input',
      block_id: blockIdFor('otherCategory'),
      optional: true,
      label: { type: 'plain_text', text: `If ${OTHER_CATEGORY}, describe it` },
      // A Slack modal cannot show or hide an input based on another one, so this
      // is always visible and only required once Other is chosen — which
      // `validate` enforces, against this block.
      hint: { type: 'plain_text', text: `Only needed when the category is ${OTHER_CATEGORY}.` },
      element: { type: 'plain_text_input', action_id: 'otherCategory' },
    },
    {
      type: 'input',
      block_id: blockIdFor('comments'),
      optional: true,
      label: { type: 'plain_text', text: 'Additional details' },
      element: { type: 'plain_text_input', action_id: 'comments', multiline: true },
    },
  ];

  return {
    type: 'modal',
    callback_id: 'pto_request_modal',
    title: { type: 'plain_text', text: 'New time off request' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}
