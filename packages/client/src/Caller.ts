/** What a caller may do. Authority, not occupation - a script can be an admin and a person a user. */
export type Role = 'admin' | 'user';

// AIDEV-NOTE: an id is what a job record will say it is OWNED by, and a record is written once and
// never rewritten - so the id may never change, and the name is free to. An operator retyping
// `name` renames a person; retyping `id` makes them a stranger to every job they submitted.
/** Who is asking. The id is what outlives them; the name is what a log and a UI say. */
export interface Caller {
  id: string;
  name: string;
  role: Role;
}
