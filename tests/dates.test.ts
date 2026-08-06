import { describe, expect, it } from 'vitest';

import { datePartNames, requiredFieldNames, setDateField } from '../src/formstack/schema.js';
import type { FieldDef, FormSchema } from '../src/forms/types.js';

const PROFILE_FIELDS: FormSchema['profile'] = {
  fullName: { name: 'p_name' },
  email: { name: 'p_email' },
  clientName: { name: 'p_client' },
  country: { name: 'p_country' },
  managerName: { name: 'p_manager' },
  managerEmail: { name: 'p_manager_email' },
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
    const field: FieldDef = { name: 'q_start', type: 'date', parts: true };
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
    const field: FieldDef = { name: 'q_start', type: 'date', parts: true };
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

describe('datePartNames', () => {
  it('suffixes the base name with -M, -D and -Y', () => {
    expect(datePartNames({ name: 'q_start' })).toEqual(['q_start-M', 'q_start-D', 'q_start-Y']);
  });
});

describe('requiredFieldNames', () => {
  it('expands split dates into the names the markup actually contains', () => {
    const names = requiredFieldNames(
      schemaWith('MM/DD/YYYY', {
        start: { name: 'q_start', type: 'date', parts: true },
        topic: { name: 'q_topic' },
      }),
    );

    expect(names).toContain('q_start-M');
    expect(names).toContain('q_start-D');
    expect(names).toContain('q_start-Y');
    expect(names).not.toContain('q_start');
    expect(names).toContain('q_topic');
  });

  it('includes every profile field', () => {
    const names = requiredFieldNames(schemaWith('MM/DD/YYYY', {}));

    expect(names).toEqual(expect.arrayContaining(Object.values(PROFILE_FIELDS).map((f) => f.name)));
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
