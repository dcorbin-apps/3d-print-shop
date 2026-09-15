import { rereadCallers, rereadPrinterKeys, whosePasswordChanged } from './credentials.js';
import type { Callers } from './credentials.js';
import type { Log } from './log.js';
import type { Sessions } from './sessions.js';

/** Everything a running shop holds that a file can change under it. */
export interface Held {
  callers: Callers;
  printerKeys: ReadonlyMap<string, string>;
}

/** As much of a process as answering a signal needs. */
export interface Signalled {
  on(signal: 'SIGTERM' | 'SIGINT' | 'SIGHUP', handler: () => void): unknown;
}

export interface Answers {
  /** What a supervised service is stopped with. */
  stop: () => void;
  /** What it is told to read its configuration again with. */
  reread: () => void;
}

// AIDEV-NOTE: SIGTERM and SIGINT are what `launchd` and `systemd` stop a service with, and one that
// ignored them would be killed with prints still being watched. SIGHUP is how a credential is
// changed without stopping at all - and node ENDS a process that has no handler for it, so a shop
// under a terminal that closed used to die where it now re-reads.
//
// A function over something with `on`, so that what is registered and what each one does can be
// asked without spawning a process. `theRunningShop` proves a real signal arrives; this proves what
// happens when one does.
export function answerSignals(on: Signalled, { stop, reread }: Answers): void {
  on.on('SIGTERM', stop);
  on.on('SIGINT', stop);
  on.on('SIGHUP', reread);
}

// AIDEV-NOTE: each file independently: a callers file somebody has just broken is no reason to leave
// a corrected printer key unread. `rereadCallers` and `rereadPrinterKeys` each keep what the shop
// already had when what they are told to read is unusable, and say so - which is why neither can
// throw here and why what comes back is always something to hold.
/** Read again everything the shop was given, and answer with what it now holds. */
export async function rereadEverything(etc: string, held: Held, sessions: Sessions, log: Log): Promise<Held> {
  const [callers, printerKeys] = await Promise.all([rereadCallers(etc, held.callers, log), rereadPrinterKeys(etc, held.printerKeys, log)]);

  // AIDEV-NOTE: the other half of what a new password is for. `caller password` says every browser
  // logged in as them is logged out once the shop has re-read this, and this is the sentence that
  // makes it true - without it a stolen password went on working in whatever browser already had a
  // session, which is the one place it was certain to be.
  for (const id of whosePasswordChanged(held.callers, callers)) {
    sessions.endEveryOneOf(id);
    log.info('a changed password logged out every browser it was logged in on', { caller: id });
  }

  return { callers, printerKeys };
}
