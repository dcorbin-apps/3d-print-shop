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
