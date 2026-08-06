import { z } from 'zod';

/**
 * The details a user enters once and reuses for every request, on every form.
 *
 * Fields are named for what they mean, not for the form field they land in.
 * Each form's schema.json maps these keys onto its own Formstack field names,
 * which is what lets one profile serve the PTO form and the expense form even
 * though they use different field IDs for the same person's name.
 */
export const ProfileSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  employeeId: z.string().min(1),
  clientName: z.string().min(1),
  country: z.string().min(1),
  managerName: z.string().min(1),
  managerEmail: z.string().email(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Profile keys in the order they are rendered in modals and copy-paste blocks. */
export const PROFILE_KEYS = [
  'fullName',
  'email',
  'employeeId',
  'clientName',
  'country',
  'managerName',
  'managerEmail',
] as const satisfies readonly (keyof Profile)[];

/** Human-readable labels, used in the profile modal and the manual-submission block. */
export const PROFILE_LABELS: Record<keyof Profile, string> = {
  fullName: 'Full name',
  email: 'Email',
  employeeId: 'Employee ID',
  clientName: 'Client',
  country: 'Country',
  managerName: 'Manager name',
  managerEmail: 'Manager email',
};
