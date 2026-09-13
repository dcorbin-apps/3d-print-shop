import { claimData } from './dataLock.js';
import { callersIn, defaultEtc, printerKeysIn } from './credentials.js';
import { defaultLayout, layoutUnder } from './dataLayout.js';
import { JobStore } from './JobStore.js';
import { SESSIONS_FILE, Sessions } from './sessions.js';
import { redacting, toStdout } from './log.js';
import type { Callers } from './credentials.js';
import type { DataLayout } from './dataLayout.js';
import type { Log } from './log.js';
import * as path from 'node:path';

/** What a shop must have before it serves anything, and what it holds once it does. */
export interface Foundations {
  where: DataLayout;
  store: JobStore;
  etc: string;
  callers: Callers;
  printerKeys: ReadonlyMap<string, string>;
  log: Log;
  /** Lets the data directory go, so another shop may have it. */
  releaseData: () => void;
  // AIDEV-NOTE: the log redacts every key this process HOLDS, and a key can arrive while it runs -
  // from a SIGHUP, or from a printer added over the API. So what it redacts is whatever it was last
  // told, and telling it is how a key that arrived late cannot reach a line written after it.
  /** Tell the log which keys the shop is holding now. */
  holding: (keys: ReadonlyMap<string, string>) => void;
}

export interface Groundwork {
  data?: string;
  etc?: string;
  maxGcode?: number;
  // AIDEV-NOTE: where the log's lines go. A service writes them to stdout, which is what a
  // supervisor captures; a test reads them back, which is the only way to ask what a shop did NOT
  // say - and keeping a key out of a line is a claim about exactly that.
  /** Where each line of the log goes. Stdout unless something else is asked for. */
  writing?: (line: string) => void;
}

// AIDEV-NOTE: everything that has to be true before a single request is answered, in the order it
// has to be true in - and a function, so that each refusal can be asked for directly rather than by
// spawning a shop and reading its exit code.
//
// Credentials FIRST. Every route names its caller, so there is nothing for a shop with no callers to
// answer - and reading a missing file as "nobody configured yet" is how a fresh machine ends up
// serving anybody who reaches the port. A file that is THERE and wrong stops it for the same reason:
// answering a typo in the security file by removing the security is the failure nobody notices.
//
// Then the data directory, which must be there and must be nobody else's to write, and then the
// claim on it - two shops over one would both hand out the same job id.
export async function layTheFoundations({ data, etc: said, maxGcode, writing }: Groundwork): Promise<Foundations> {
  const etc = said ?? defaultEtc();
  const callers = await callersIn(etc);
  const printerKeys = await printerKeysIn(etc);

  // AIDEV-NOTE: built from every secret this process HOLDS, which is the printer keys and nothing
  // else - a caller's token is kept as a digest and a session as a digest of one. Asked for afresh
  // on each line, because a key given while the shop runs is one this process did not hold when the
  // log was made, which is why this reads a variable rather than taking the keys.
  let held: ReadonlyMap<string, string> = printerKeys;
  const log = redacting(toStdout(undefined, writing), () => held.values());

  // AIDEV-NOTE: named a place, everything goes under it; named none, each kind goes where this
  // system keeps that kind. The branch is in dataLayout.ts and this is its first caller rather than
  // its home - the server is a library too, and an embedder needs the same answer.
  const where = data === undefined ? defaultLayout() : layoutUnder(data);
  const store = new JobStore(where, { maxGcodeBytes: maxGcode });

  // A data directory that is not there, or is already being served, is a shop that must refuse to
  // start rather than start and do damage.
  await store.ready();
  const releaseData = await claimData(where.run);

  return {
    where,
    store,
    etc,
    callers,
    printerKeys,
    log,
    releaseData,
    holding: (keys) => {
      held = keys;
    },
  };
}

// AIDEV-NOTE: picked up rather than started empty, so an update at 2am is not a wall display asking
// to be logged in to in the morning. A file it cannot read logs everybody out and says why - the
// safe direction, taken out loud rather than quietly, because a shop that silently forgot everybody
// looks exactly like one that was restarted on purpose.
//
// Kept with the STATE and not among the jobs: the jobs directory is one directory per job and the
// store reads every name in it, so a file of its own there is something the shop would have to know
// not to read, for ever.
/** The sessions a shop carries over from the last time it ran, and how many it found. */
export async function sessionsKeptIn(where: DataLayout, log: Log): Promise<{ sessions: Sessions; pickedUp: number }> {
  const sessions = new Sessions({ keptIn: path.join(where.state, SESSIONS_FILE), log });

  const pickedUp = await sessions.pickUp().catch((failure: unknown) => {
    log.error('could not read who was logged in, so everybody logs in again', { why: (failure as Error).message });

    return 0;
  });

  return { sessions, pickedUp };
}
