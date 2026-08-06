import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { blockIdFor, flattenValues, toBlockErrors } from '../src/slack/values.js';

describe('flattenValues', () => {
  it('keys the result by action_id, not by block_id', () => {
    const flat = flattenValues({
      full_name_block: { fullName: { type: 'plain_text_input', value: 'Hong Gildong' } },
    });

    expect(flat).toEqual({ fullName: 'Hong Gildong' });
  });

  it('reads the selected value out of each input type', () => {
    const flat = flattenValues({
      a: { leaveType: { type: 'radio_buttons', selected_option: { value: 'Vacation' } } },
      b: { country: { type: 'static_select', selected_option: { value: 'South Korea' } } },
      c: { startDate: { type: 'datepicker', selected_date: '2026-08-17' } },
      d: { tags: { type: 'checkboxes', selected_options: [{ value: 'x' }, { value: 'y' }] } },
    });

    expect(flat).toEqual({
      leaveType: 'Vacation',
      country: 'South Korea',
      startDate: '2026-08-17',
      tags: ['x', 'y'],
    });
  });

  it('turns a number input into a number, because Slack sends it as text', () => {
    const flat = flattenValues({ a: { totalDays: { type: 'number_input', value: '5' } } });

    expect(flat.totalDays).toBe(5);
  });

  it('reports an untouched optional input as undefined rather than an empty string', () => {
    const flat = flattenValues({
      a: { comments: { type: 'plain_text_input', value: null } },
      b: { other: { type: 'plain_text_input', value: '   ' } },
      c: { day: { type: 'datepicker', selected_date: null } },
    });

    expect(flat.comments).toBeUndefined();
    expect(flat.other).toBeUndefined();
    expect(flat.day).toBeUndefined();
  });

  it('trims whitespace off text input', () => {
    const flat = flattenValues({ a: { email: { type: 'plain_text_input', value: '  x@y.z ' } } });

    expect(flat.email).toBe('x@y.z');
  });

  it('survives an empty state', () => {
    expect(flattenValues(undefined)).toEqual({});
  });
});

describe('blockIdFor', () => {
  it('derives the block id from the schema key', () => {
    expect(blockIdFor('leaveType')).toBe('leave_type_block');
    expect(blockIdFor('startDate')).toBe('start_date_block');
    expect(blockIdFor('comments')).toBe('comments_block');
    expect(blockIdFor('managerEmail')).toBe('manager_email_block');
  });
});

describe('toBlockErrors', () => {
  const schema = z.object({
    email: z.string().email('Enter a valid email address.'),
    totalDays: z.number({ invalid_type_error: 'Enter the number of days.' }),
  });

  it('addresses each message to the block that holds the field', () => {
    const result = schema.safeParse({ email: 'nope', totalDays: 'five' });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(toBlockErrors(result.error)).toEqual({
      email_block: 'Enter a valid email address.',
      total_days_block: 'Enter the number of days.',
    });
  });

  it('keeps only the first message per field, since Slack shows one', () => {
    const strict = z.object({ email: z.string().min(20, 'Too short.').email('Not an email.') });
    const result = strict.safeParse({ email: 'a@b' });

    if (result.success) throw new Error('expected a validation failure');

    expect(Object.keys(toBlockErrors(result.error))).toEqual(['email_block']);
  });
});
