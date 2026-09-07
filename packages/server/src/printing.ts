import type { Readable } from 'node:stream';
import type { Job, PrinterOutcome } from './Job.js';
import type { JobStore } from './JobStore.js';
import { WrongState } from './JobStore.js';
import { nextToPrint } from './selection.js';

/**
 * A machine that will take a file and print it. Keyed on the path the job is pushed to rather than
 * on a job, so the port knows nothing of the shop's model - and OctoPrint already identifies a job
 * by its path, so there is no separate handle to invent.
 */
export interface Printer {
  /** Answers once the printer has taken the file. Rejecting means it never started. */
  send(remotePath: string, gcode: Readable): Promise<void>;
  /** Answers when the print stops, however it stops. */
  awaitOutcome(remotePath: string): Promise<PrinterOutcome>;
}

export type PrintAttempt =
  | { did: 'nothing'; because: 'paused' | 'busy' | 'nothing-printable' }
  | { did: 'started'; job: Job }
  | { did: 'could-not-start'; job: Job; failure: Error };

// AIDEV-NOTE: a job that names no path is given one. Built from the id rather than the display
// name: ids are unique and safe in a path, display names are neither.
export function remotePathFor(job: Job): string {
  return job.remotePath ?? `3d-print-shop/job-${job.id}.gcode`;
}

/**
 * Start the next thing this printer can print with what is loaded on it, and answer as soon as the
 * machine has taken the file.
 *
 * The machine is reached lazily, and only when there is something to send it.
 *
 * It does NOT wait for the print. A print runs for hours, and holding a caller for that long makes
 * the outcome something only a live stack frame knows - lost to a restart, and impossible to ask
 * about. What the printer is holding is written down instead, and `recordOutcome` is what watches
 * it to the end.
 */
export async function startNextPrint(shop: JobStore, reach: () => Promise<Printer>, printerName: string): Promise<PrintAttempt> {
  // AIDEV-NOTE: looked up rather than passed in. A RegisteredPrinter is a snapshot, and both what a
  // printer holds and whether it is stopped change while the shop runs - including inside this very
  // function, which stops one when an upload fails.
  const onto = await shop.printerNamed(printerName);

  if (onto.paused) return { did: 'nothing', because: 'paused' };

  // Holding anything at all, including a print somebody has not judged yet: the bed is not clear.
  if (onto.holding) return { did: 'nothing', because: 'busy' };

  const job = nextToPrint(await shop.all(), onto);
  if (!job) return { did: 'nothing', because: 'nothing-printable' };

  // AIDEV-NOTE: the machine is reached only once there is something for it to print. Reaching one
  // means building a client and opening a socket, and a shop is asked to look after every change it
  // makes - so an eager reach would connect to every idle printer every time anything happened.
  const machine = await reach();

  const remotePath = remotePathFor(job);
  const started = await shop.startPrinting(printerName, job.id);

  try {
    await machine.send(remotePath, await shop.gcodeStream(job.id));
  } catch (failure) {
    // AIDEV-NOTE: nothing was printed, so the printer simply lets go and the job is queued again by
    // not being held. THIS printer then stops: whatever stopped the upload will stop the next one,
    // and a fault worth one message would otherwise produce one per job held. Only this one -
    // another printer that is working has no reason to stand idle.
    await shop.couldNotStart(printerName);
    await shop.pause(printerName, `could not send ${remotePath} to the printer: ${(failure as Error).message}`);

    return { did: 'could-not-start', job, failure: failure as Error };
  }

  return { did: 'started', job: started };
}

/**
 * Watch a print this printer is already holding through to its end, and write down how it ended.
 *
 * Started fresh after a restart, from the printer's own status: a print that was running when the
 * shop went down is still running, and its outcome is still worth having.
 */
export async function recordOutcome(shop: JobStore, machine: Printer, printerName: string): Promise<PrinterOutcome> {
  const printer = await shop.printerNamed(printerName);
  if (printer.holding?.phase !== 'printing') {
    throw new WrongState(`${printerName} is not printing anything to watch`);
  }

  const job = await shop.find(printer.holding.job);
  if (!job) throw new WrongState(`${printerName} is holding job ${printer.holding.job}, which is not here`);

  const outcome = await machine.awaitOutcome(remotePathFor(job));

  // Whatever the printer says, the job now waits for a person: `finished` means it ran to the end,
  // not that what came off the bed is usable. The printer keeps holding it, and the bed, until then.
  await shop.finishedPrinting(printerName, outcome);

  return outcome;
}
