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
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  clientName: z.string().min(1),
  country: z.string().min(1),
  supervisorName: z.string().min(1),
  supervisorEmail: z.string().email(),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** Profile keys in the order they are rendered in modals and copy-paste blocks. */
export const PROFILE_KEYS = [
  'firstName',
  'lastName',
  'email',
  'clientName',
  'country',
  'supervisorName',
  'supervisorEmail',
] as const satisfies readonly (keyof Profile)[];

/**
 * Human-readable labels.
 *
 * These match the wording on the form — "Supervisor", not "Manager" — so that a
 * user comparing the modal against the form sees the same words in both.
 */
export const PROFILE_LABELS: Record<keyof Profile, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  clientName: 'Client name',
  country: 'Work country',
  supervisorName: 'Supervisor name',
  supervisorEmail: 'Supervisor email',
};

/** Display name, for the Home tab and modal headers. */
export function displayName(profile: Profile): string {
  return `${profile.firstName} ${profile.lastName}`;
}
