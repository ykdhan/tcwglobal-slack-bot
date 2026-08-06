import type { KnownBlock, ModalView } from '@slack/types';

import { forms } from '../forms/registry.js';
import { PROFILE_LABELS, type Profile } from '../profile.js';
import { blockIdFor } from './values.js';

/**
 * Where the modal should go once the profile is saved.
 *
 * `formId` remembers which form the user was heading for, so first-time setup
 * continues into the right request modal instead of dead-ending on a save.
 */
export interface ProfileModalMeta {
  next: 'close' | 'open_request';
  formId?: string;
  parentViewId?: string;
}

export interface ProfileModalOptions {
  initial?: Partial<Profile>;
  meta: ProfileModalMeta;
}

/**
 * The country list comes from whichever registered form declares one.
 *
 * A free-text country would eventually be rejected by the form for not matching
 * an option exactly, and the user would never learn why. Reading the list from
 * the form schema keeps the two in step without naming a particular form here.
 */
function countryOptions(): string[] {
  for (const form of forms) {
    const options = form.schema.profile.country.options;
    if (options && options.length > 0) return options;
  }
  return [];
}

function textInput(key: keyof Profile, initial: string | undefined, hint?: string): KnownBlock {
  return {
    type: 'input',
    block_id: blockIdFor(key),
    label: { type: 'plain_text', text: PROFILE_LABELS[key] },
    ...(hint ? { hint: { type: 'plain_text' as const, text: hint } } : {}),
    element: {
      type: 'plain_text_input',
      action_id: key,
      ...(initial ? { initial_value: initial } : {}),
    },
  };
}

export function profileModal(options: ProfileModalOptions): ModalView {
  const { initial, meta } = options;
  const countries = countryOptions();

  const blocks: KnownBlock[] = [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: 'Entered once, reused for every request until you change it here.',
        },
      ],
    },
    textInput('fullName', initial?.fullName),
    textInput('email', initial?.email),
    textInput('clientName', initial?.clientName),
  ];

  if (countries.length > 0) {
    const selected =
      initial?.country && countries.includes(initial.country) ? initial.country : undefined;

    blocks.push({
      type: 'input',
      block_id: blockIdFor('country'),
      label: { type: 'plain_text', text: PROFILE_LABELS.country },
      element: {
        type: 'static_select',
        action_id: 'country',
        placeholder: { type: 'plain_text', text: 'Select a country' },
        options: countries.map((country) => ({
          text: { type: 'plain_text' as const, text: country },
          value: country,
        })),
        ...(selected
          ? {
              initial_option: {
                text: { type: 'plain_text' as const, text: selected },
                value: selected,
              },
            }
          : {}),
      },
    });
  } else {
    blocks.push(textInput('country', initial?.country));
  }

  blocks.push(
    textInput('managerName', initial?.managerName),
    textInput('managerEmail', initial?.managerEmail),
  );

  if (initial) {
    blocks.push(
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Remove my information' },
            style: 'danger',
            action_id: 'forget_profile',
            confirm: {
              title: { type: 'plain_text', text: 'Remove your information?' },
              text: {
                type: 'plain_text',
                text: 'Your saved details will be deleted. Requests already submitted are unaffected.',
              },
              confirm: { type: 'plain_text', text: 'Remove' },
              deny: { type: 'plain_text', text: 'Keep' },
            },
          },
        ],
      },
    );
  }

  return {
    type: 'modal',
    callback_id: 'profile_modal',
    title: { type: 'plain_text', text: 'Your information' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(meta),
    blocks,
  };
}

/** Read back what {@link profileModal} stored, tolerating anything unexpected. */
export function parseProfileMeta(privateMetadata: string | undefined): ProfileModalMeta {
  if (!privateMetadata) return { next: 'close' };

  try {
    const parsed = JSON.parse(privateMetadata) as ProfileModalMeta;
    return parsed.next === 'open_request' ? parsed : { ...parsed, next: 'close' };
  } catch {
    return { next: 'close' };
  }
}
