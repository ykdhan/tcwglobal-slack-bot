import type { HomeView, KnownBlock } from '@slack/types';

import { forms } from '../forms/registry.js';
import { displayName, type Profile } from '../profile.js';

/**
 * The App Home tab — the app's only entry point.
 *
 * Two states and nothing else: no submission history, no timestamps, no "last
 * updated" line. The saved details are visible at all times, which is what makes
 * a wrong value something the user notices before submitting rather than after.
 */
export function homeView(profile: Profile | null): HomeView {
  return { type: 'home', blocks: profile ? withProfile(profile) : withoutProfile() };
}

function header(): KnownBlock {
  return { type: 'header', text: { type: 'plain_text', text: 'TCWGlobal' } };
}

function withoutProfile(): KnownBlock[] {
  return [
    header(),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Submit TCWGlobal forms without leaving Slack.\n' +
          'Set up your information once — it will be reused for every request.',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Set up my information' },
          style: 'primary',
          action_id: 'open_profile',
        },
      ],
    },
  ];
}

function withProfile(profile: Profile): KnownBlock[] {
  return [
    header(),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*Your information*\n' +
          `${displayName(profile)} · ${profile.email}\n` +
          `${profile.clientName} · ${profile.country}\n` +
          `Supervisor: ${profile.supervisorName} (${profile.supervisorEmail})`,
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        // One button per registered form. A new form appears here on its own;
        // this file never learns which forms exist.
        ...forms.map((form) => ({
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: `New ${form.label}` },
          style: 'primary' as const,
          action_id: `open_request:${form.id}`,
        })),
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Edit info' },
          action_id: 'open_profile',
        },
      ],
    },
  ];
}
