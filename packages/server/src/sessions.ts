import { readFile, rename, writeFile } from 'node:fs/promises';
import { digestOf, newToken } from './secrets.js';
import { silent } from './log.js';
import type { Log } from './log.js';

/** The cookie a browser carries. Nothing else in this shop is named by anything a client sends. */
export const SESSION_COOKIE = 'print-shop-session';

// AIDEV-NOTE: two clocks, because they answer two different questions. IDLE is "has this person
// walked away from the machine" - a workshop screen somebody stopped looking at. ABSOLUTE is "has
// this been going on long enough that a stolen cookie is still working weeks later", which no
// amount of activity should excuse. A session that fails either is gone.
export const IDLE_MS = 12 * 60 * 60 * 1000;
export const LONGEST_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the file is allowed to learn that somebody is still there. */
export const KEPT_AT_MOST_EVERY_MS = 5 * 60 * 1000;

/** What the sessions are kept in, inside the shop's state. */
export const SESSIONS_FILE = 'sessions.json';

interface Held {
  caller: string;
  began: number;
  lastSeen: number;
}

// AIDEV-NOTE: kept in a file of their own, in the shop's STATE - not in callers.json, which is a
// file a person hand-edits and the shop re-reads on a signal, and not in memory only, which made a
// restart at 2am a wall display asking to be logged in to in the morning.
//
// Keyed by DIGEST, like everything else here: what is held is not what a browser presents. That is
// what makes the file safe to write at all - a stolen copy is a list of who was logged in and when,
// which is worth 0600, but it cannot be replayed into a working cookie.
export class Sessions {
  private readonly held = new Map<string, Held>();

  private readonly now: () => number;
  private readonly keptIn: string | undefined;
  private readonly log: Log;

  private wroteAt = 0;

  // AIDEV-NOTE: one write at a time, chained. Two of these in flight would be two renames over the
  // same path from two half-written files, and the one that landed second would not be the one that
  // knew the most. It is also what `settled` can be handed to a caller that wants to be sure.
  private writing: Promise<void> = Promise.resolve();

  constructor({ now, keptIn, log }: { now?: () => number; keptIn?: string; log?: Log } = {}) {
    this.now = now ?? ((): number => Date.now());
    this.keptIn = keptIn;
    this.log = log ?? silent;
  }

  /**
   * Pick up what a previous run left, dropping anything already past either clock.
   *
   * Throws at a file it cannot read rather than starting empty quietly: everybody having to log in
   * again is the safe direction, and the caller decides that - but silently is how a shop ends up
   * logging everybody out every morning with nobody knowing why.
   */
  async pickUp(): Promise<number> {
    if (this.keptIn === undefined) return 0;

    const written = await readFile(this.keptIn, 'utf-8').catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return '[]';
      throw failure;
    });

    for (const held of JSON.parse(written) as (Held & { digest: string })[]) {
      const { digest, ...was } = held;
      if (!this.hasExpired(was)) this.held.set(digest, was);
    }

    return this.held.size;
  }

  get size(): number {
    return this.held.size;
  }

  /**
   * Begin one for this caller, and answer with what their browser must present.
   *
   * A new secret every time and never a reused one: logging in again is a new session, so a cookie
   * taken from a machine somebody has since logged in on again is not the cookie in use.
   */
  begin(caller: string): string {
    this.forgetTheExpired();

    const secret = newToken();
    const at = this.now();
    this.held.set(digestOf(secret), { caller, began: at, lastSeen: at });
    this.keep();

    return secret;
  }

  /** Whose session this is, or nobody - which is what an expired one is too. */
  whose(secret: string): string | undefined {
    const key = digestOf(secret);
    const held = this.held.get(key);
    if (held === undefined) return undefined;

    if (this.hasExpired(held)) {
      this.held.delete(key);
      this.keep();

      return undefined;
    }

    held.lastSeen = this.now();

    // AIDEV-NOTE: NOT written every time, which would be a write per request. Written at most every
    // few minutes, which bounds two things at once: how often this touches the disk, and how wrong
    // the idle clock can be after a restart. Leaving it out altogether was the other option and it
    // is worse than it looks - a session in constant use would come back looking untouched since it
    // began, and be thrown away as idle.
    if (this.now() - this.wroteAt > KEPT_AT_MOST_EVERY_MS) this.keep();

    return held.caller;
  }

  /** End it, which is what logging out IS - the cookie is cleared at the same time. */
  end(secret: string): void {
    this.held.delete(digestOf(secret));
    this.keep();
  }

  /**
   * End every session this caller holds, except the one presenting `keeping` - for a person changing
   * their own password, who should not be thrown off the screen they are standing at to do it.
   *
   * What a changed password means: somebody either forgot theirs or believes somebody else has it,
   * and in both cases every OTHER browser logged in as them is a browser that should not be.
   */
  endEveryOneOf(caller: string, keeping?: string): void {
    const kept = keeping === undefined ? undefined : digestOf(keeping);

    for (const [key, held] of this.held) {
      if (held.caller === caller && key !== kept) this.held.delete(key);
    }

    this.keep();
  }

  // AIDEV-NOTE: not awaited by anything that answers a request - a session that outlives a restart
  // is worth less than a login that waits on a disk. A write that fails says so and is otherwise
  // survivable: what is lost is the surviving, not the session.
  //
  // Written beside and renamed over, at 0600, the way every other file the shop writes is: a crash
  // part way through would otherwise leave a file that logs everybody out AND cannot be read.
  private keep(): void {
    if (this.keptIn === undefined) return;

    const kept = this.keptIn;
    const written = [...this.held.entries()].map(([digest, held]) => ({ digest, ...held }));
    this.wroteAt = this.now();

    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        const being = `${kept}.new`;
        await writeFile(being, `${JSON.stringify(written, null, 2)}\n`, { mode: 0o600 });
        await rename(being, kept);
      })
      .catch((failure: unknown) => {
        this.log.error('could not write down who is logged in, so a restart will ask them again', {
          kept,
          why: (failure as Error).message,
        });
      });
  }

  /** Settles once what is known has reached the disk - for whoever has a reason to be sure. */
  async settled(): Promise<void> {
    await this.writing;
  }

  private hasExpired(held: Held): boolean {
    const at = this.now();

    return at - held.lastSeen > IDLE_MS || at - held.began > LONGEST_MS;
  }

  // Swept when one is begun rather than on a timer: nothing else here holds the event loop open,
  // and a session nobody asks about again costs a map entry until the next login.
  private forgetTheExpired(): void {
    for (const [key, held] of this.held) {
      if (this.hasExpired(held)) this.held.delete(key);
    }
  }
}
