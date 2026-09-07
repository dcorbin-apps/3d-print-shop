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

/** Who is asking. The name is what a log will say; nothing is ever answered with it. */
export interface Caller {
  name: string;
  role: Role;
}

export class UnusableCredentials extends Error {}

/**
 * Who may talk to this shop, by the token they present.
 *
 * Keyed by token because that is all a request carries; the name and role are what the token buys.
 */
export async function callersIn(etc: string = defaultEtc()): Promise<Map<string, Caller> | undefined> {
  const file = path.join(etc, CALLERS_FILE);
  const listed = await readOnlyByItsOwner(file);

  if (listed === MISSING) return undefined;

  if (!Array.isArray(listed)) {
    throw new UnusableCredentials(`${file} is a list of callers, each with a name, a role and a token`);
  }

  const callers = new Map<string, Caller>();

  for (const entry of listed as unknown[]) {
    const { name, role, token } = (entry ?? {}) as { name?: unknown; role?: unknown; token?: unknown };

    if (typeof name !== 'string' || name.trim() === '') {
      throw new UnusableCredentials(`${file} has a caller with no name, and a name is what says who did something`);
    }
    if (role !== 'admin' && role !== 'user') {
      throw new UnusableCredentials(`${file} gives ${name} the role ${JSON.stringify(role)}, and a role is "admin" or "user"`);
    }
    if (typeof token !== 'string' || token.trim() === '') {
      throw new UnusableCredentials(`${file} gives ${name} no token`);
    }

    // AIDEV-NOTE: a token shared by two callers would resolve to whichever was read last, so every
    // line the loser wrote would be attributed to the winner. That is an audit trail that lies,
    // which is worse than none - so it is refused rather than resolved.
    const already = callers.get(token);
    if (already) {
      throw new UnusableCredentials(`${file} gives ${name} and ${already.name} the same token, so neither could be told apart`);
    }

    callers.set(token, { name, role });
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
