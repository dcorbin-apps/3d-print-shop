import { callersIn, setPassword, writePrinterKey } from './credentials.js';
import type { Callers } from './credentials.js';
import type { Log } from './log.js';

/** As much of a foreman as stopping and waking need. */
export interface TheForeman {
  considerStarting(): Promise<unknown>;
  startAgain(name: string): Promise<unknown>;
  stop(): void;
  watchersSettled(): Promise<unknown>;
}

/** As much of the machines as stopping needs. */
export interface TheMachines {
  closeAll(): void;
}

export interface Stopping {
  /** Taking no more requests is what ends the process: nothing else holds the event loop open. */
  server: { close: () => void };
  /** The clock the shop reaches for lost printers on. */
  stopAsking: () => void;
  foreman: TheForeman;
  machines: TheMachines;
  releaseData: () => void;
  log: Log;
  say: (lines: string[]) => void;
}

// AIDEV-NOTE: the order is the whole of it - take no more requests, stop asking, start nothing more,
// then let the machines go, which is what settles the watchers waiting on them. Letting them go
// first would settle watchers while a request was still able to start a new print.
//
// Idempotent, because the operator can ask over the API and the supervisor can signal at the same
// moment, and a second release of the data directory is not the first one's to give away.
/** How a shop stops. Answers the function to call, which may be called any number of times. */
export function stoppingTheShop({ server, stopAsking, foreman, machines, releaseData, log, say }: Stopping): () => void {
  let stopped = false;

  return () => {
    if (stopped) return;
    stopped = true;

    server.close();
    stopAsking();
    foreman.stop();
    machines.closeAll();
    releaseData();

    void foreman.watchersSettled().then(() => {
      log.info('the shop has stopped');
      say(['3d-print-shop has stopped']);
    });
  };
}

// AIDEV-NOTE: every change the API makes is a moment something might be startable, so the foreman is
// told about all of them rather than about a chosen few. Not awaited: a client waiting on its own
// submission has no reason to wait for a printer to take a different job - and a failure to look is
// the shop's own trouble, not an answer to the request that prompted it.
/** Look for work, and say so rather than throwing if looking fails. */
export function lookingForWork(foreman: TheForeman, log: Log): () => void {
  return () => {
    void foreman.considerStarting().catch((failure: unknown) => log.error('could not look for work', { why: (failure as Error).message }));
  };
}

// AIDEV-NOTE: an operator's go, which is more than a change: it says WHICH machine, and that
// somebody has been to look at it. Looking for work does not pick a lost print back up - the printer
// is holding one already - and nothing else can tell the shop to stop waiting out a backoff.
/** Try one printer again, because a person has been to it. */
export function tryingAgain(foreman: TheForeman, log: Log): (name: string) => void {
  return (name) => {
    void foreman
      .startAgain(name)
      .catch((failure: unknown) => log.error('could not try the printer again', { printer: name, why: (failure as Error).message }));
  };
}

// AIDEV-NOTE: the one thing the shop does on a clock rather than after a change it made. A machine
// the shop cannot hear makes no changes, so nothing else would ever ask again - and what ends one of
// these happens in a room the shop cannot see.
/** Keep reaching for the printers the shop has lost. Answers how to stop asking. */
export function keepReachingForWhatIsLost(reach: () => Promise<unknown>, everyMs: number, log: Log): () => void {
  const asking = setInterval(() => {
    void reach().catch((failure: unknown) => log.error('could not reach for the printers', { why: (failure as Error).message }));
  }, everyMs);

  return () => clearInterval(asking);
}

// AIDEV-NOTE: written to the file the shop reads AND put into what this process is holding, in that
// order - so a key given while the shop runs needs no signal and no restart. Then the printer is
// tried at once, because a machine that had no key is written down as unreachable and would
// otherwise serve out a backoff before anybody found out the key was right.
//
// The one thing the shop writes to /etc, and the reason a printer can be given its key from a
// browser at all.
/** Keep a key a printer arrived with, and answer with every key the shop now holds. */
export function keepingTheKey(etc: string, log: Log, tryAgain: (printer: string) => void) {
  return async (printer: string, key: string): Promise<ReadonlyMap<string, string>> => {
    const keys = await writePrinterKey(etc, printer, key);
    log.info('a printer was given its key', { printer, etc });
    tryAgain(printer);

    return keys;
  };
}

// AIDEV-NOTE: written to the file and then READ BACK into what this process holds, in that order and
// for the same reason a printer's key is. Read back rather than patched in memory, so that what is
// in force is what the FILE says - which is what a re-read or a restart would find, and what
// `caller list` would show. A person cannot be locked out by an update that way.
/** Keep a password its owner just changed, and answer with the callers the file now names. */
export function keepingTheirPassword(etc: string) {
  return async (id: string, password: string): Promise<Callers> => {
    await setPassword(etc, id, password);

    return callersIn(etc);
  };
}
