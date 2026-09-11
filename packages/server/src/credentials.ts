import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Caller } from '@3d-print-shop/client';
import type { Log } from './log.js';

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

// The wire contract, so the shop and everything that talks to it cannot drift apart - a caller is
// answered to a client by `whoAmI`, and what it is told has to be what the shop holds.
export type { Caller, Role } from '@3d-print-shop/client';

// AIDEV-NOTE: what a file that is not there MEANS is the reader's to say, and the two readers below
// say opposite things. No printer keys is a shop that has not been pointed at a machine yet, which
// is a fresh install rather than a fault. No callers is a shop nobody may call, and since every
// route names its caller that is a shop that cannot answer anybody - so it refuses to start rather
// than starting open, which is the failure nobody would notice.
const MISSING = Symbol('no such file');

// AIDEV-NOTE: narrow on purpose. An id reaches disk in a record nothing rewrites, so this rule can
// be LOOSENED later and never tightened - whatever a query string, a log format or a path wants of
// an id one day, the ids already written cannot be changed to suit.
const AN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class UnusableCredentials extends Error {}

/** A shop that already has callers. Writing over them would revoke every one of them at once. */
export class AlreadyHasCallers extends Error {}

// 32 random bytes, which is the whole of what a token is: unguessable, and nothing about it meant
// to be read or remembered. Hex rather than base64url so that a token copied out of a terminal
// cannot pick up a character whose case or punctuation matters on the way.
const TOKEN_BYTES = 32;

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * Give a shop its first admin, and answer with their token.
 *
 * The token is answered rather than kept: this is the only moment it exists anywhere but the file,
 * and nothing here can read it back out of one, so whoever asked says it once or not at all.
 */
export async function writeFirstCaller(etc: string, id: string, name: string): Promise<string> {
  if (!AN_ID.test(id)) {
    throw new UnusableCredentials(
      `${JSON.stringify(id)} is not an id - an id is up to 64 of letters, digits, dot, dash and underscore, beginning with a letter or a digit`,
    );
  }
  if (name.trim() === '') {
    throw new UnusableCredentials('a caller needs a name, which is what a log and a UI say');
  }

  const file = path.join(etc, CALLERS_FILE);
  const token = randomBytes(TOKEN_BYTES).toString('hex');

  // The credentials directory is this command's to make - it is what setting a machine up MEANS,
  // where the spool is the installer's because work put somewhere nobody is looking is work lost.
  await mkdir(etc, { recursive: true, mode: DIRECTORY_MODE });

  try {
    // AIDEV-NOTE: 'wx' rather than a look and then a write. This file holds every token the shop
    // knows, so writing over one would revoke every caller at once and orphan every job their ids
    // own - and asking first leaves a window in which two of these both find nothing.
    await writeFile(file, `${JSON.stringify([{ id, name, role: 'admin', token }], null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;

    throw new AlreadyHasCallers(`${file} is already there, and it holds every token this shop knows - so this will not write over it`);
  }

  return token;
}

/**
 * Who may talk to this shop, by the token they present.
 *
 * Keyed by token because that is all a request carries; the id, name and role are what it buys.
 */
export async function callersIn(etc: string = defaultEtc()): Promise<Map<string, Caller>> {
  const file = path.join(etc, CALLERS_FILE);
  const listed = await readOnlyByItsOwner(file);

  if (listed === MISSING) {
    throw new UnusableCredentials(
      `${file} is not there, and every route names its caller - so this shop cannot run until it lists them, each with an id, a name, a role and a token`,
    );
  }

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

// AIDEV-NOTE: the answer to "how does a credential get changed without stopping the shop". SIGHUP is
// what a long-running service is told to re-read its configuration with, and the whole of the
// mechanism is the files it already reads, read again - the callers here, the printer keys below.
/**
 * Read the callers again, so one can be added or revoked while the shop is running.
 *
 * A file it cannot read leaves the callers exactly as they were, and says why. The alternative is a
 * shop that answers nobody because of a stray comma - which revokes every caller at once, including
 * the operator who would then have to get back in to fix it.
 */
export async function rereadCallers(etc: string, keeping: ReadonlyMap<string, Caller>, log: Log): Promise<ReadonlyMap<string, Caller>> {
  try {
    const callers = await callersIn(etc);
    log.info('callers re-read', { etc, callers: callers.size });

    return callers;
  } catch (failure) {
    log.error('could not re-read the callers, so the shop keeps the ones it has', {
      etc,
      callers: keeping.size,
      why: (failure as Error).message,
    });

    return keeping;
  }
}

// AIDEV-NOTE: a key is corrected the way a token is, and for the same reason: a shop stopped to fix
// a typo loses sight of every print it was watching, and a stop outlives a restart, so the operator
// pays twice. What makes it safe is WHERE a key is used - nothing swaps a client on a re-read, and a
// printer that is holding a print is never started on, so a new key waits for the machine to be idle
// without anything here having to know what is being watched.
/**
 * Read the printer keys again, so one can be corrected while the shop is running.
 *
 * A file it cannot read leaves the keys exactly as they were, and says why. A file that is not there
 * is no keys at all, which is what it means at startup too - the machines are out of reach until it
 * is back, and nothing else about the shop stops.
 */
export async function rereadPrinterKeys(etc: string, keeping: ReadonlyMap<string, string>, log: Log): Promise<ReadonlyMap<string, string>> {
  try {
    const keys = await printerKeysIn(etc);
    log.info('printer keys re-read', { etc, printers: keys.size });

    return keys;
  } catch (failure) {
    log.error('could not re-read the printer keys, so the shop keeps the ones it has', {
      etc,
      printers: keeping.size,
      why: (failure as Error).message,
    });

    return keeping;
  }
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
