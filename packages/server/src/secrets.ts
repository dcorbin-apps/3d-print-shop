import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { atMostAtOnce } from './turns.js';

const onAThread = promisify(scrypt) as (
  secret: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// AIDEV-NOTE: scrypt runs on the libuv threadpool, and so does every fs call the shop makes - so
// hashing a password and reading a job record compete for the same four threads. MEASURED, against a
// shop holding 25 jobs: below the pool size a login flood costs it nothing, AT the pool size a
// `GET /jobs` goes from 1.4ms to 60ms, and at four times the pool it goes to 3.4 seconds. That last
// one is the print queue stopping, because looking for work to start is the same kind of file read.
//
// So half the pool, leaving the other half to read a job record with. It bounds the MEMORY too,
// which is the half that bites hardest: 32MB of scrypt state per hash in flight. Raising the pool
// instead was measured and is worse - a pool of 64 turned a 112MB shop into a 2.1GB one under the
// same flood, which on a workshop machine is the OOM killer rather than a slow login.
const THREADPOOL = Number(process.env.UV_THREADPOOL_SIZE) || 4;

// AIDEV-NOTE: `POST /sessions` is the one route reachable WITHOUT a credential that does real work,
// which is why the bound is here and not left to a proxy - no proxy can know the right number for it,
// because the right number is the threadpool's size and nothing outside the process can see that
// coupling. What this does NOT answer, and cannot: a login flood still makes LOGGING IN slow, since
// there is no way to check a password without hashing one. The shop keeps printing through it, which
// is the whole of what it can do about it. A flood of connections is the deployment's too. Loopback
// is the default for both reasons.
/** How many passwords this process will hash at once. The rest wait, in the order they arrived. */
export const HASHES_AT_ONCE = Math.max(1, Math.floor(THREADPOOL / 2));

// AIDEV-NOTE: wrapped around `derive` rather than around either caller, so that the two below and
// anything added later are bounded without having to remember - the same reasoning as the log's
// redactor. This is the ONLY way scrypt is reached in the shop.
const inTurn = atMostAtOnce(HASHES_AT_ONCE);

const derive = (secret: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> =>
  inTurn(() => onAThread(secret, salt, length, options));

// AIDEV-NOTE: two kinds of secret, hashed two different ways, and the difference is where the
// entropy came from. A TOKEN is 32 random bytes this shop generated - guessing one is not a thing
// that happens, so the only job of its hash is that the file cannot be read back into a working
// credential, and a plain digest does that while staying a MAP LOOKUP. A PASSWORD is whatever a
// person chose, which is guessable, so it gets a memory-hard function and a salt of its own and
// costs the attacker the same 50ms it costs us.
//
// Doing it the other way round is the trap: scrypt on every token would put a memory-hard function
// in front of every single request, and a plain digest on a password would make the file a wordlist
// away from being a set of passwords.

/** What a token hashes to. Deterministic and fast on purpose: it is looked up, not searched for. */
export function digestOf(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

// 32 random bytes, which is the whole of what a token is. Hex so that a token copied out of a
// terminal cannot pick up a character whose case or punctuation matters on the way.
const TOKEN_BYTES = 32;

/** A token nobody will guess, said once to whoever it belongs to and never stored as it is. */
export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

// AIDEV-NOTE: written into the hash rather than assumed, so that raising them later leaves every
// password already stored still readable - each one carries the cost it was made with, and is
// rewritten at the next `caller password`. 32768 * 8 * 128 is 32MB per attempt; maxmem is said
// explicitly because node's default is exactly that and would refuse its own parameters.
const COST = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** What a password is stored as: the function, what it cost, the salt, and the result. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hashed = await derive(password, salt, KEY_BYTES, COST);

  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('hex'), hashed.toString('hex')].join('$');
}

/**
 * Whether this password is the one that hash was made from.
 *
 * False for anything it cannot make sense of, rather than throwing: a credential nobody can read is
 * a credential nobody can present, and a hash mangled by an editor must not become a way in.
 */
export async function isThePassword(password: string, hash: string): Promise<boolean> {
  const [named, n, r, p, salt, expected] = hash.split('$');
  if (named !== 'scrypt' || expected === undefined) return false;

  const cost = { N: Number(n), r: Number(r), p: Number(p), maxmem: COST.maxmem };
  if (![cost.N, cost.r, cost.p].every((said) => Number.isInteger(said) && said > 0)) return false;

  const was = Buffer.from(expected, 'hex');
  const now = await derive(password, Buffer.from(salt, 'hex'), was.length, cost).catch(() => undefined);

  return now !== undefined && sameSecret(now, was);
}

// AIDEV-NOTE: length first, because timingSafeEqual THROWS on a mismatch rather than answering
// false - and the length of a stored hash is not a secret.
/** Whether two secrets are the same, in time that does not depend on how much of them matches. */
export function sameSecret(one: Buffer, other: Buffer): boolean {
  return one.length === other.length && timingSafeEqual(one, other);
}
