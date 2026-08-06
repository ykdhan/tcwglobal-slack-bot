import { ptoForm } from './pto/index.js';
import type { FormDefinition } from './types.js';

/**
 * Every form the app offers, in the order their buttons appear on the Home tab.
 *
 * Adding the expense form is one import and one entry here. Nothing else — not
 * the engine, the Home tab, the handlers or the Dockerfile — needs to know.
 */
export const forms: FormDefinition<any>[] = [ptoForm];

export function getForm(id: string): FormDefinition<any> {
  const form = forms.find((f) => f.id === id);
  if (!form) throw new Error(`Unknown form: ${id}`);
  return form;
}
