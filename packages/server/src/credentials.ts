import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Caller, Role } from '@3d-print-shop/client';
import type { Log } from './log.js';
import { digestOf, hashPassword, newToken } from './secrets.js';
import { atMostAtOnce } from './turns.js';

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

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

// AIDEV-NOTE: one at a time, and wrapped around the read-modify-write rather than around any caller -
// the same reasoning as the bound on scrypt in secrets.ts, so that anything added later is covered
// without having to remember. Each of these reads the whole file, changes it and writes it back, and
// the gap is not small: setting a password hashes one in the middle of it, which is fifty
// milliseconds before it queues behind whatever else is hashing. Two overlapping lose one of the
// changes, and the caller whose change was lost has already been told it took.
//
// What this cannot reach is the OPERATOR'S terminal. `caller add`, `caller password`, `caller token`
// and `callers migrate` run in a process of their own and write this same file - deliberately,
// because a shop cannot be asked to give somebody a way in that it does not yet answer. A lock those
// could share would have to be a file, and a file outlives the process that took it: see dataLock.ts,
// which reached for a listening socket rather than leave the next writer guessing what a leftover
// means, and a socket is the wrong shape for a fifty-millisecond turn taken over and over. So that
// half is answered where the DAMAGE is instead - `keepingTheirPassword` in running.ts reads back what
// it wrote, and a change that was overwritten is refused rather than reported as done.
const oneAtATime = atMostAtOnce(1);

// AIDEV-NOTE: written beside and renamed over, because a rename is atomic and a write is not - and
// beside under a name nothing else will pick, which is the half that was missing. `writeFile`
// truncates on open and writes from nought on a handle of its own, so two of these overlapping on one
// scratch path leave the shorter one's bytes with the longer one's tail behind them: a file that is
// not JSON, published by whichever renamed first, over the credentials of every caller this shop
// knows. A shop already running survives that - it keeps what it holds and says why - but the next
// restart refuses to start, and the fix is a person with a text editor.
//
// The name is this write's alone, so there is nothing to lock and nothing left behind that a later
// writer has to interpret. It is removed again if the rename never happens, because a crash is
// allowed to orphan one and a failure is not.
export function scratchBeside(file: string): string {
  return `${file}.${process.pid}.${randomBytes(6).toString('hex')}.new`;
}

async function writtenBesideAndRenamedOver(file: string, contents: string): Promise<void> {
  const being = scratchBeside(file);

  try {
    await writeFile(being, contents, { mode: FILE_MODE });
    await rename(being, file);
  } catch (failure) {
    await rm(being, { force: true });
    throw failure;
  }
}

/** What a caller is on disk. The credentials are hashes; nothing here is ever what was presented. */
interface WrittenCaller {
  id: string;
  name: string;
  role: Role;
  credentials: { kind: 'token' | 'password'; hash: string }[];
}

/**
 * Give a shop its first admin - a password to log in with, and a token to call it with - and answer
 * with the token.
 *
 * The token is answered rather than kept: this is the only moment it exists anywhere but the file,
 * and nothing here can read it back out of one, so whoever asked says it once or not at all. The
 * password is not answered at all, because whoever typed it already has it.
 */
export async function writeFirstCaller(etc: string, id: string, name: string, password: string): Promise<string> {
  requireAnId(id);
  requireAName(name);
  requireAPassword(password);

  const file = path.join(etc, CALLERS_FILE);
  const token = newToken();
  const first: WrittenCaller = {
    id,
    name,
    role: 'admin',
    credentials: [
      { kind: 'password', hash: await hashPassword(password) },
      { kind: 'token', hash: digestOf(token) },
    ],
  };

  // The credentials directory is this command's to make - it is what setting a machine up MEANS,
  // where the data directory is the installer's because work put where nobody is looking is work lost.
  await mkdir(etc, { recursive: true, mode: DIRECTORY_MODE });

  try {
    // AIDEV-NOTE: 'wx' rather than a look and then a write. This file holds every credential the
    // shop knows, so writing over one would revoke every caller at once and orphan every job their
    // ids own - and asking first leaves a window in which two of these both find nothing.
    await writeFile(file, `${JSON.stringify([first], null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;

    throw new AlreadyHasCallers(`${file} is already there, and it holds every credential this shop knows - so this will not write over it`);
  }

  return token;
}

// AIDEV-NOTE: every change to this file goes through here - read, change, write beside and rename
// over. Read first so that a change made while the shop is running is made to what is THERE rather
// than to what this process last saw, and renamed over so a crash part way through cannot leave a
// shop with a file naming nobody, which is a shop that will not start.
async function changeCallers(etc: string, changing: (known: WrittenCaller[]) => Promise<WrittenCaller[]>): Promise<void> {
  await oneAtATime(async () => {
    const file = path.join(etc, CALLERS_FILE);
    const known = (await callersIn(etc)).all().map(({ caller, credentials }) => ({ ...caller, credentials }));
    const changed = await changing(known);

    await writtenBesideAndRenamedOver(file, `${JSON.stringify(changed, null, 2)}\n`);
  });
}

/** Add somebody this shop may answer, with a password for a person or a token for a machine. */
export async function addCaller(etc: string, id: string, name: string, role: Role, password?: string): Promise<string | undefined> {
  requireAnId(id);
  requireAName(name);
  if (password !== undefined) requireAPassword(password);

  const token = password === undefined ? newToken() : undefined;

  await changeCallers(etc, async (known) => {
    if (known.some((caller) => caller.id === id)) {
      throw new UnusableCredentials(`${id} is already somebody this shop knows - a second would own the first one's jobs`);
    }

    const credentials =
      password === undefined
        ? [{ kind: 'token' as const, hash: digestOf(token as string) }]
        : [{ kind: 'password' as const, hash: await hashPassword(password) }];

    return [...known, { id, name, role, credentials }];
  });

  return token;
}

/**
 * Set what a caller logs in with, replacing whatever password they had.
 *
 * Their tokens are left alone: a password is a person's and a token is a machine's, and changing
 * one is not a reason to go round every machine they slice with.
 */
export async function setPassword(etc: string, id: string, password: string): Promise<void> {
  requireAPassword(password);

  await changeCallers(etc, async (known) => {
    const caller = known.find((held) => held.id === id);
    if (caller === undefined) throw new UnusableCredentials(`${id} is nobody this shop knows`);

    const hash = await hashPassword(password);
    const rest = caller.credentials.filter(({ kind }) => kind !== 'password');

    return known.map((held) => (held.id === id ? { ...held, credentials: [{ kind: 'password' as const, hash }, ...rest] } : held));
  });
}

/**
 * Issue a caller another token, and answer with it - said once here and stored as a digest.
 *
 * Another, not a replacement: a caller may have one per machine, and the point of a list is that
 * losing a laptop costs that laptop's token rather than everything the person can reach.
 */
export async function issueToken(etc: string, id: string): Promise<string> {
  const token = newToken();

  await changeCallers(etc, (known) => {
    const caller = known.find((held) => held.id === id);
    if (caller === undefined) throw new UnusableCredentials(`${id} is nobody this shop knows`);

    const given = { kind: 'token' as const, hash: digestOf(token) };

    return Promise.resolve(known.map((held) => (held.id === id ? { ...held, credentials: [...held.credentials, given] } : held)));
  });

  return token;
}

// AIDEV-NOTE: the one thing that reads the OLD shape, which `callersIn` refuses - a token in the
// clear. It hashes what is there and writes the file back, so every caller keeps the token they
// already hold and nothing has to be reissued to anybody. It is also the only thing here that can
// see a token in the clear, which is the point of doing it once and never again.
/** Turn a file of plaintext tokens into one of hashes, keeping every token that is in it. */
export async function migrateCallers(etc: string): Promise<number> {
  return oneAtATime(async () => {
    const file = path.join(etc, CALLERS_FILE);
    const listed = await readOnlyByItsOwner(file);

    if (!Array.isArray(listed)) throw new UnusableCredentials(`${file} is not a list of callers`);

    let hashed = 0;
    const migrated = (listed as unknown[]).map((entry) => {
      const { token, credentials, ...caller } = (entry ?? {}) as Record<string, unknown> & { token?: unknown; credentials?: unknown };
      if (typeof token !== 'string' || token.trim() === '') return entry as WrittenCaller;

      hashed += 1;
      const already = Array.isArray(credentials) ? (credentials as WrittenCaller['credentials']) : [];

      return { ...caller, credentials: [...already, { kind: 'token' as const, hash: digestOf(token) }] } as WrittenCaller;
    });

    await writtenBesideAndRenamedOver(file, `${JSON.stringify(migrated, null, 2)}\n`);

    return hashed;
  });
}

function requireAnId(id: string): void {
  if (!AN_ID.test(id)) {
    throw new UnusableCredentials(
      `${JSON.stringify(id)} is not an id - an id is up to 64 of letters, digits, dot, dash and underscore, beginning with a letter or a digit`,
    );
  }
}

function requireAName(name: string): void {
  if (name.trim() === '') throw new UnusableCredentials('a caller needs a name, which is what a log and a UI say');
}

// AIDEV-NOTE: a length and nothing else. Everything else a rule could demand - a digit, a symbol, a
// capital - is known to push people towards `Password1!` and towards writing it down, and this file
// is read by one shop in one workshop. Length is the thing that actually costs an attacker.
const SHORTEST_PASSWORD = 12;

function requireAPassword(password: string): void {
  if (password.length < SHORTEST_PASSWORD) {
    throw new UnusableCredentials(`a password is at least ${SHORTEST_PASSWORD} characters, which is the only rule there is`);
  }
}

// AIDEV-NOTE: a credential hangs off an identity rather than BEING one, and there may be several -
// a person's password and the token on the machine they slice with are two ways in for one owner,
// and a job either submits belongs to the same id. That is what the old shape could not say: a
// token WAS the caller, so a second token meant a second person, and every job the first one
// submitted was a stranger's work to the second.
//
// Nothing here is stored as it was presented. A token is a digest, because 32 random bytes of this
// shop's own making cannot be guessed and the only job of the hash is that the file cannot be read
// back into a way in. A password is scrypt, because a person chose it. See secrets.ts.
export interface StoredCredential {
  kind: 'token' | 'password';
  hash: string;
}

/** A caller, and what they may present to be recognised as one. */
export interface HeldCaller {
  caller: Caller;
  credentials: StoredCredential[];
}

// AIDEV-NOTE: built once, from the file, and asked rather than searched. A token is found by the
// digest of what was presented, which is a map lookup - putting scrypt in front of that would have
// meant a memory-hard function on every request this shop ever answers.
/** Who may talk to this shop, and what each of them may present. */
export class Callers {
  private readonly byDigest = new Map<string, Caller>();
  private readonly byId = new Map<string, HeldCaller>();

  constructor(held: readonly HeldCaller[]) {
    for (const holding of held) {
      this.byId.set(holding.caller.id, holding);
      for (const credential of holding.credentials) {
        if (credential.kind === 'token') this.byDigest.set(credential.hash, holding.caller);
      }
    }
  }

  get size(): number {
    return this.byId.size;
  }

  /** Whoever presents this token, or nobody - which is what an unknown token IS. */
  presenting(token: string): Caller | undefined {
    return this.byDigest.get(digestOf(token));
  }

  /** The caller with this id, and the password they would be recognised by if they have one. */
  named(id: string): { caller: Caller; password?: string } | undefined {
    const holding = this.byId.get(id);
    if (holding === undefined) return undefined;

    return { caller: holding.caller, password: holding.credentials.find(({ kind }) => kind === 'password')?.hash };
  }

  /** Everyone this shop knows, for an operator asking who that is. */
  all(): { caller: Caller; credentials: StoredCredential[] }[] {
    return [...this.byId.values()].map(({ caller, credentials }) => ({ caller, credentials: [...credentials] }));
  }
}

/**
 * Who may talk to this shop, and what each of them may present.
 *
 * Keyed by nothing a request carries: a token is recognised by its digest and a password by the
 * hash it was made from, and neither is stored as it was given.
 */
export async function callersIn(etc: string = defaultEtc()): Promise<Callers> {
  const file = path.join(etc, CALLERS_FILE);
  const listed = await readOnlyByItsOwner(file);

  if (listed === MISSING) {
    throw new UnusableCredentials(
      `${file} is not there, and every route names its caller - so this shop cannot run until it lists them, each with an id, a name, a role and the credentials they may present`,
    );
  }

  if (!Array.isArray(listed)) {
    throw new UnusableCredentials(`${file} is a list of callers, each with an id, a name, a role and the credentials they may present`);
  }

  const held: HeldCaller[] = [];
  const named = new Map<string, string>();
  const presenting = new Map<string, string>();

  for (const entry of listed as unknown[]) {
    const { id, name, role, token, credentials } = (entry ?? {}) as {
      id?: unknown;
      name?: unknown;
      role?: unknown;
      token?: unknown;
      credentials?: unknown;
    };

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

    // AIDEV-NOTE: the old shape, refused rather than read. It held a token in the CLEAR, and a shop
    // that went on accepting one would keep every install that has ever run on plaintext for ever -
    // which is the fault nobody notices, because everything works. Named with the command that
    // fixes it, because this stops a shop from starting and the operator is holding the file.
    if (token !== undefined) {
      throw new UnusableCredentials(
        `${file} gives ${name} a token in the clear, which this shop no longer reads - run "3d-print-shop callers migrate" to hash what is there`,
      );
    }

    if (!Array.isArray(credentials)) {
      throw new UnusableCredentials(`${file} gives ${name} no credentials, and a credential is what a caller presents to be recognised`);
    }

    const heldCredentials: StoredCredential[] = [];

    for (const credential of credentials as unknown[]) {
      const { kind, hash } = (credential ?? {}) as { kind?: unknown; hash?: unknown };

      if (kind !== 'token' && kind !== 'password') {
        throw new UnusableCredentials(`${file} gives ${name} a credential of kind ${JSON.stringify(kind)}, and a kind is "token" or "password"`);
      }
      if (typeof hash !== 'string' || hash.trim() === '') {
        throw new UnusableCredentials(`${file} gives ${name} a ${kind} with nothing stored for it`);
      }

      // A password is what a PERSON presents, and two of them would mean either might let somebody
      // in - which is one more way in than anybody meant to leave open.
      if (kind === 'password' && heldCredentials.some((already) => already.kind === 'password')) {
        throw new UnusableCredentials(`${file} gives ${name} two passwords, and a person has one`);
      }

      // AIDEV-NOTE: a token shared by two callers would resolve to whichever was read last, so every
      // line the loser wrote would be attributed to the winner. That is an audit trail that lies,
      // which is worse than none - so it is refused rather than resolved.
      if (kind === 'token') {
        const already = presenting.get(hash);
        if (already !== undefined) {
          throw new UnusableCredentials(`${file} gives ${name} and ${already} the same token, so neither could be told apart`);
        }
        presenting.set(hash, name);
      }

      heldCredentials.push({ kind, hash });
    }

    // AIDEV-NOTE: two callers on one id are one owner, and every job either submits belongs to both
    // of them - which is not a thing the shop can later untangle, because it cannot rewrite a
    // record to say which of them meant it.
    const sharing = named.get(id);
    if (sharing !== undefined) {
      throw new UnusableCredentials(`${file} gives the id ${id} to both ${sharing} and ${name}, so a job could not say which of them owns it`);
    }

    named.set(id, name);
    held.push({ caller: { id, name, role }, credentials: heldCredentials });
  }

  return new Callers(held);
}

// AIDEV-NOTE: what a changed password MEANS, which is more than "a new one works". Somebody either
// forgot theirs or believes somebody else has it, and in both cases every browser already logged in
// as them is a browser that should not be - so the sessions go with it. Nothing else reads this: a
// caller who was taken out of the file entirely is already refused by the guard, which looks their
// id up in the callers it has and finds nobody.
/** Whose password is not the one it was, so that whoever is logged in as them no longer is. */
export function whosePasswordChanged(before: Callers, after: Callers): string[] {
  return before
    .all()
    .map(({ caller }) => caller.id)
    .filter((id) => before.named(id)?.password !== after.named(id)?.password);
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
export async function rereadCallers(etc: string, keeping: Callers, log: Log): Promise<Callers> {
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

// AIDEV-NOTE: the one thing the SERVICE writes into its own credentials directory, and it took a
// decision to allow it. The rule that put a key here in the first place was that it must not be in
// shell history or in `ps` or in a world-readable plist - none of which a shop writing the file
// itself breaks. What it does change is that /etc is no longer somewhere the running shop only ever
// reads, so this is the only function that writes there, it writes nothing but a key, and it leaves
// the file the mode it demands of one.
//
// Answered with the whole map rather than nothing, because whoever asked for this holds the keys the
// shop is using and has to be given the new ones - a key written to a file the shop will not re-read
// until a signal is a key that has not taken effect.
/**
 * Give a printer its key, keeping every other one, and answer with what the shop now holds.
 *
 * Read, merged and written rather than appended: this file is a whole JSON object, and the shop's
 * own copy of it has to end up agreeing with what is on disk.
 */
export async function writePrinterKey(etc: string, printer: string, key: string): Promise<Map<string, string>> {
  if (key.trim() === '') throw new UnusableCredentials(`${printer} cannot be given an empty key`);

  return oneAtATime(async () => {
    const keys = await printerKeysIn(etc);
    keys.set(printer, key);

    const file = path.join(etc, PRINTER_KEYS_FILE);
    const asObject = Object.fromEntries([...keys.entries()].sort(([one], [other]) => one.localeCompare(other)));

    await writtenBesideAndRenamedOver(file, `${JSON.stringify(asObject, null, 2)}\n`);

    return keys;
  });
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
    throw new UnusableCredentials(
      `${file} can be read by somebody other than its owner (mode ${(found.mode & 0o777).toString(8)}) - it holds secrets, so it must be 0600`,
    );
  }

  try {
    return JSON.parse(await readFile(file, 'utf-8')) as unknown;
  } catch {
    throw new UnusableCredentials(`${file} is not JSON`);
  }
}
