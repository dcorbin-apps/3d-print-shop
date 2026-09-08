import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

// AIDEV-NOTE: two files, not one, and deliberately. `callers` lets somebody into the SHOP; `printer
// keys` let somebody into the PRINTERS, bypassing the shop entirely. One file holding both means
// that copying "the credentials" to a client machine hands it every printer's key - and a client
// needs none of them. They also change at different times: a key when a machine is swapped, a token
// when a caller is added or revoked.
const SYSTEM_ETC = '/etc/3d-print-shop';

export const ETC_ENV = 'PRINT_SHOP_ETC';

export const CALLERS_FILE = 'callers.json';
export const PRINTER_KEYS_FILE = 'printer-keys.json';

export function defaultEtc(): string {
  return process.env[ETC_ENV] ?? SYSTEM_ETC;
}

/** What a caller may do. Authority, not occupation - a script can be an admin and a person a user. */
export type Role = 'admin' | 'user';

// AIDEV-NOTE: a file that is not there and a file that is wrong are different answers, and the
// difference is the whole safety of this. Not there means nobody has set credentials up, which a
// shop on loopback runs without. Wrong - unreadable, malformed, two callers on one token, a mode
// anybody can read - must STOP the shop: treating it as "nobody configured" would answer a typo in
// the credentials file by opening the shop to everyone, which is the failure nobody would notice.
const MISSING = Symbol('no such file');

// AIDEV-NOTE: an id is what a job record will say it is OWNED by, and a record is written once and
// never rewritten - so the id may never change, and the name is free to. An operator retyping
// `name` renames a person; retyping `id` makes them a stranger to every job they submitted.
/** Who is asking. The id is what outlives them; the name is what a log and a UI say. */
export interface Caller {
  id: string;
  name: string;
  role: Role;
}

// AIDEV-NOTE: narrow on purpose. An id reaches disk in a record nothing rewrites, so this rule can
// be LOOSENED later and never tightened - whatever a query string, a log format or a path wants of
// an id one day, the ids already written cannot be changed to suit.
const AN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class UnusableCredentials extends Error {}

/**
 * Who may talk to this shop, by the token they present.
 *
 * Keyed by token because that is all a request carries; the id, name and role are what it buys.
 */
export async function callersIn(etc: string = defaultEtc()): Promise<Map<string, Caller> | undefined> {
  const file = path.join(etc, CALLERS_FILE);
  const listed = await readOnlyByItsOwner(file);

  if (listed === MISSING) return undefined;

  if (!Array.isArray(listed)) {
    throw new UnusableCredentials(`${file} is a list of callers, each with an id, a name, a role and a token`);
  }

  const callers = new Map<string, Caller>();
  const named = new Map<string, string>();

  for (const entry of listed as unknown[]) {
    const { id, name, role, token } = (entry ?? {}) as { id?: unknown; name?: unknown; role?: unknown; token?: unknown };

    if (typeof id !== 'string' || !AN_ID.test(id)) {
      throw new UnusableCredentials(
        `${file} gives a caller the id ${JSON.stringify(id)}, and an id is up to 64 of letters, digits, dot, dash and underscore`,
      );
    }
    if (typeof name !== 'string' || name.trim() === '') {
      throw new UnusableCredentials(`${file} gives ${id} no name, and a name is what says who did something`);
    }
    if (role !== 'admin' && role !== 'user') {
      throw new UnusableCredentials(`${file} gives ${name} the role ${JSON.stringify(role)}, and a role is "admin" or "user"`);
    }
    if (typeof token !== 'string' || token.trim() === '') {
      throw new UnusableCredentials(`${file} gives ${name} no token`);
    }

    // AIDEV-NOTE: two callers on one id are one owner, and every job either submits belongs to both
    // of them - which is not a thing the shop can later untangle, because it cannot rewrite a
    // record to say which of them meant it.
    const sharing = named.get(id);
    if (sharing !== undefined) {
      throw new UnusableCredentials(`${file} gives the id ${id} to both ${sharing} and ${name}, so a job could not say which of them owns it`);
    }

    // AIDEV-NOTE: a token shared by two callers would resolve to whichever was read last, so every
    // line the loser wrote would be attributed to the winner. That is an audit trail that lies,
    // which is worse than none - so it is refused rather than resolved.
    const already = callers.get(token);
    if (already) {
      throw new UnusableCredentials(`${file} gives ${name} and ${already.name} the same token, so neither could be told apart`);
    }

    named.set(id, name);
    callers.set(token, { id, name, role });
  }

  return callers;
}

/** How this shop talks to each machine, by the printer's own name - the one on its record. */
export async function printerKeysIn(etc: string = defaultEtc()): Promise<Map<string, string>> {
  const file = path.join(etc, PRINTER_KEYS_FILE);
  const listed = await readOnlyByItsOwner(file);

  if (listed === MISSING) return new Map();

  if (typeof listed !== 'object' || listed === null || Array.isArray(listed)) {
    throw new UnusableCredentials(`${file} names a key per printer, as {"mk4": "..."}`);
  }

  const keys = new Map<string, string>();

  for (const [printer, key] of Object.entries(listed as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new UnusableCredentials(`${file} gives ${printer} no key`);
    }

    keys.set(printer, key);
  }

  return keys;
}

// AIDEV-NOTE: the mode is checked rather than assumed, the way ssh refuses a private key anyone can
// read. A file installed 0644 by accident is the whole of the protection gone, silently and while
// everything still works - which is exactly the failure nobody notices. Group and other, not owner:
// what matters is that nobody ELSE can read it.
async function readOnlyByItsOwner(file: string): Promise<unknown> {
  const found = await stat(file).catch(() => undefined);

  if (found === undefined) return MISSING;

  const openTo = found.mode & 0o077;
  if (openTo !== 0) {
    throw new UnusableCredentials(`${file} can be read by somebody other than its owner (mode ${(found.mode & 0o777).toString(8)}) - it holds secrets, so it must be 0600`);
  }

  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown;
  } catch {
    throw new UnusableCredentials(`${file} is not JSON`);
  }
}
