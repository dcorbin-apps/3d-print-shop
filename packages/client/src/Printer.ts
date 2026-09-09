import type { BuildVolume, JobPhase, PrinterOutcome } from './Job.js';

/** Which protocol a printer speaks, and so which client the shop builds to reach it. */
export type PrinterApi = 'octoprint';

/** What the operator says a machine IS. It changes when the shop's machines change. */
export interface PrinterRecord {
  name: string;
  buildVolume: BuildVolume;
  api: PrinterApi;
  /** Where the machine answers, e.g. `http://octopi.local`. */
  address: string;
}

/** What a printer is holding, and what for. */
export interface Holding {
  job: number;
  phase: JobPhase;
  /**
   * Where the machine said it filed the gcode, which is not always where it was asked to.
   *
   * Recorded once the upload has been answered, so a print started before the shop read that answer
   * back - or interrupted between the upload and the write - has none.
   */
  remotePath?: string;
  /** What the machine said when it stopped. Present once it has stopped. */
  outcome?: PrinterOutcome;
}

/** What a printer is DOING. It changes as the shop runs. */
export interface PrinterStatus {
  /** What is on the machine now, positionally by extruder. Empty when nothing is. */
  loaded: string[];
  /**
   * An OPERATOR stopped this printer, with the reason they gave and when. Only an operator lifts
   * it: a reason given by a person is a fact about the room, and no machine can contradict it.
   */
  paused?: { reason: string; since: Date };
  /**
   * The shop could not get to the machine, with what it saw and when.
   *
   * Kept apart from `paused` because it is the shop's own reading of a machine rather than
   * anybody's instruction: nobody is asked to clear it, and the shop clears it itself once it can
   * reach the machine again.
   */
  unreachable?: { reason: string; since: Date };
  /**
   * The machine would not take the file, with what it said and when.
   *
   * Its own fact rather than a stop, because nobody stopped anything: the machine answered and gave
   * a considered no. Nothing about that changes by asking again - and asking costs a whole plate -
   * so this is the one thing the shop writes that waits for a person, and `printer start` is how a
   * person says they have dealt with it.
   */
  refused?: { reason: string; since: Date };
  /**
   * The shop is holding a print it can no longer hear about, with what took the watch and when.
   *
   * Not a stop and not a fault of the machine's: as far as anyone knows it is still printing, and
   * nothing is idled by this that the print was not idling already. The shop listens again on a
   * backoff, and the machine's own status settles what happened while nobody was there.
   */
  outOfContact?: { reason: string; since: Date };
  /** The job it has, or undefined when the bed is clear and it can take another. */
  holding?: Holding;
}

/** A printer as the shop reports it: what it is, and what it is doing. */
export interface RegisteredPrinter extends PrinterRecord, PrinterStatus {}
