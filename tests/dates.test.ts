import { describe, expect, it } from 'vitest';

import { requiredFieldNames, setDateField } from '../src/formstack/schema.js';
import type { FieldDef, FormSchema } from '../src/forms/types.js';

const PROFILE_FIELDS: FormSchema['profile'] = {
  firstName: { name: 'p_name-first', base: 'p_name' },
  lastName: { name: 'p_name-last', base: 'p_name' },
  email: { name: 'p_email' },
  clientName: { name: 'p_client' },
  country: { name: 'p_country' },
  supervisorName: { name: 'p_supervisor' },
  supervisorEmail: { name: 'p_supervisor_email' },
};

function schemaWith(
  dateFormat: FormSchema['dateFormat'],
  request: Record<string, FieldDef>,
): FormSchema {
  return {
    formUrl: 'https://example.test/form',
    action: 'https://example.test/submit',
    successMarker: 'Thank you',
    dateFormat,
    profile: PROFILE_FIELDS,
    request,
  };
}

describe('setDateField', () => {
  it('writes MM/DD/YYYY', () => {
    const field: FieldDef = { name: 'q_start', type: 'date' };
    const body = new URLSearchParams();

    setDateField(body, field, '2026-08-17', schemaWith('MM/DD/YYYY', { start: field }));

    expect(body.get('q_start')).toBe('08/17/2026');
  });

  it('writes DD/MM/YYYY', () => {
    const field: FieldDef = { name: 'q_start', type: 'date' };
    const body = new URLSearchParams();

    setDateField(body, field, '2026-08-17', schemaWith('DD/MM/YYYY', { start: field }));

    expect(body.get('q_start')).toBe('17/08/2026');
  });

  it('keeps the leading zeroes that distinguish the two formats', () => {
    const field: FieldDef = { name: 'q_start', type: 'date' };
    const body = new URLSearchParams();

    setDateField(body, field, '2026-01-05', schemaWith('MM/DD/YYYY', { start: field }));

    expect(body.get('q_start')).toBe('01/05/2026');
  });

  it('splits into three suffixed inputs when the field has parts', () => {
    const field: FieldDef = { name: 'q_start', type: 'date', parts: 'hyphenParts' };
    const body = new URLSearchParams();

    setDateField(body, field, '2026-08-17', schemaWith('MM/DD/YYYY', { start: field }));

    expect([...body.entries()]).toEqual([
      ['q_start-M', '08'],
      ['q_start-D', '17'],
      ['q_start-Y', '2026'],
    ]);
    expect(body.get('q_start')).toBeNull();
  });

  it('ignores dateFormat when the field is split into parts', () => {
    const field: FieldDef = { name: 'q_start', type: 'date', parts: 'hyphenParts' };
    const body = new URLSearchParams();

    setDateField(body, field, '2026-08-17', schemaWith('DD/MM/YYYY', { start: field }));

    expect(body.get('q_start-M')).toBe('08');
    expect(body.get('q_start-D')).toBe('17');
  });

  it('rejects a value that is not an ISO date', () => {
    const field: FieldDef = { name: 'q_start', type: 'date' };

    expect(() =>
      setDateField(new URLSearchParams(), field, '08/17/2026', schemaWith('MM/DD/YYYY', {})),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('setDateField, Formstack datetime style', () => {
  const field: FieldDef = { name: 'q_start', type: 'date', parts: 'datetimeParts' };

  it('writes the parts the renderer posts, with no separator', () => {
    const body = new URLSearchParams();

    setDateField(body, field, '2026-08-17', schemaWith('MM/DD/YYYY', { start: field }));

    // The month is an English abbreviation and the day is unpadded — this is the
    // wire format, regardless of how the form displays a date.
    expect(body.get('q_startM')).toBe('Aug');
    expect(body.get('q_startD')).toBe('17');
    expect(body.get('q_startY')).toBe('2026');
    expect(body.get('q_start')).toBeNull();
  });

  it('drops the leading zero from single-digit days', () => {
    const body = new URLSearchParams();

    setDateField(body, field, '2026-01-06', schemaWith('MM/DD/YYYY', { start: field }));

    expect(body.get('q_startM')).toBe('Jan');
    expect(body.get('q_startD')).toBe('6');
  });

  it('sends a time, because a datetime field stores one', () => {
    const body = new URLSearchParams();

    setDateField(body, field, '2026-12-31', schemaWith('MM/DD/YYYY', { start: field }));

    expect(body.get('q_startH')).toBe('12');
    expect(body.get('q_startI')).toBe('00');
    expect(body.get('q_startS')).toBe('00');
    expect(body.get('q_startA')).toBe('AM');
  });

  it('abbreviates every month correctly', () => {
    const months = Array.from({ length: 12 }, (_, index) => {
      const body = new URLSearchParams();
      const month = String(index + 1).padStart(2, '0');
      setDateField(body, field, `2026-${month}-15`, schemaWith('MM/DD/YYYY', { start: field }));
      return body.get('q_startM');
    });

    expect(months).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });
});

describe('requiredFieldNames', () => {
  it('names the field, not the inputs a date is spread across', () => {
    const names = requiredFieldNames(
      schemaWith('MM/DD/YYYY', {
        start: { name: 'q_start', type: 'date', parts: 'datetimeParts' },
        topic: { name: 'q_topic' },
      }),
    );

    // The form advertises one datetime field; the parts are how it is posted.
    expect(names).toContain('q_start');
    expect(names).not.toContain('q_startM');
    expect(names).toContain('q_topic');
  });

  it('collapses inputs onto the field they belong to', () => {
    const names = requiredFieldNames(schemaWith('MM/DD/YYYY', {}));

    // firstName and lastName are two inputs of one field.
    expect(names).toContain('p_name');
    expect(names).not.toContain('p_name-first');
    expect(names.filter((name) => name === 'p_name')).toHaveLength(1);
  });

  it('leaves optional fields out', () => {
    const names = requiredFieldNames(
      schemaWith('MM/DD/YYYY', {
        note: { name: 'q_note', optional: true },
        topic: { name: 'q_topic' },
      }),
    );

    expect(names).not.toContain('q_note');
    expect(names).toContain('q_topic');
  });
});
