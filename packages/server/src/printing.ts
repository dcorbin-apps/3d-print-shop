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
  /**
   * Answers, once the printer has taken the file, with where it actually FILED it - which is not
   * always the path it was asked for. Rejecting means it never started.
   */
  send(remotePath: string, gcode: Readable): Promise<string>;
  /** Answers when the print stops, however it stops. */
  awaitOutcome(remotePath: string): Promise<PrinterOutcome>;
}

// AIDEV-NOTE: what tells "I could not get to that machine" apart from every other way a printer can
// fail. It belongs to the PORT rather than to the loop above it: a send that fails because nothing
// is listening is the same fact as a login that fails for the same reason, and the difference
// between the two decides whether a whole plate is worth re-sending.
/** The machine could not be got to at all - nothing listening, no key, a login it would not grant. */
export class CouldNotReach extends Error {}

export type PrintAttempt =
  | { did: 'nothing'; because: 'unreadable' | 'paused' | 'unreachable' | 'refused' | 'busy' | 'nothing-printable' }
  | { did: 'started'; job: Job }
  | { did: 'could-not-start'; job: Job; remotePath: string; failure: Error };

// AIDEV-NOTE: a job that names no path is given one. Built from the id rather than the display
// name: ids are unique and safe in a path, display names are neither.
//
// What this answers is where the shop ASKS for a job to go. Where it ended up is what the machine
// said when it took it, which is on the printer's `holding` - see `printingAt`.
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
  // printer holds and whether it is stopped change while the shop runs.
  const onto = await shop.printerNamed(printerName);

  // Read again here like the rest of them, and FIRST: everything below is read out of the very
  // files the shop could not read, so none of it is worth acting on. Answered as nothing to do
  // rather than left to `startPrinting` to refuse - by then a client has been built and a socket
  // opened to the machine, and the refusal reaches the foreman as a fault to write down.
  if (onto.unreadable) return { did: 'nothing', because: 'unreadable' };

  if (onto.paused) return { did: 'nothing', because: 'paused' };

  // Not a stop, but the same answer: there is no point uploading to a machine the shop has just
  // found it cannot get to. Read here rather than trusted from the caller's snapshot, because both
  // this and what the printer holds change while the shop runs.
  if (onto.unreachable) return { did: 'nothing', because: 'unreachable' };

  // The machine already said no to a plate. The next one goes the same way, and finding that out
  // costs another upload.
  if (onto.refused) return { did: 'nothing', because: 'refused' };

  // Holding anything at all, including a print somebody has not judged yet: the bed is not clear.
  if (onto.holding) return { did: 'nothing', because: 'busy' };

  const job = nextToPrint(await shop.all(), onto);
  if (!job) return { did: 'nothing', because: 'nothing-printable' };

  // AIDEV-NOTE: the machine is reached only once there is something for it to print. Reaching one
  // means building a client and opening a socket, and a shop is asked to look after every change it
  // makes - so an eager reach would connect to every idle printer every time anything happened.
  const machine = await reach();

  const asked = remotePathFor(job);
  const started = await shop.startPrinting(onto, job.id);

  let storedAt: string;
  try {
    storedAt = await machine.send(asked, await shop.gcodeStream(job.id));
  } catch (failure) {
    // AIDEV-NOTE: nothing was printed, so the printer simply lets go and the job is queued again by
    // not being held. Whether the printer then STOPS is the caller's to decide: a send that fails
    // because the shop is closing the machines is not the printer's fault, and only the owner of
    // the loop knows that is what happened.
    await shop.couldNotStart(onto);

    return { did: 'could-not-start', job, remotePath: asked, failure: failure as Error };
  }

  // AIDEV-NOTE: outside the try, and after the printer has the file. A failure HERE is not a print
  // that never started - the machine is printing - so answering it by letting the printer go would
  // queue a job that is on a bed. The cost of that is a holding with no path, which is the case the
  // fallback in `recordOutcome` already covers.
  await shop.printingAt(onto, storedAt);

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

  // AIDEV-NOTE: where the machine SAID it filed it, because that is the string its completion event
  // will carry. The fallback is the shop's guess, for a print started before the shop read the
  // answer back or interrupted between the upload and the write - which is what a restart finds.
  const outcome = await machine.awaitOutcome(printer.holding.remotePath ?? remotePathFor(job));

  // Whatever the printer says, the job now waits for a person: `finished` means it ran to the end,
  // not that what came off the bed is usable. The printer keeps holding it, and the bed, until then.
  await shop.finishedPrinting(printer, outcome);

  return outcome;
}
