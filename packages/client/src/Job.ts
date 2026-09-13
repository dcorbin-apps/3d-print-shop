/** Millimetres, as the printer measures its bed and its height. */
export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

/**
 * What a client says about a job. NOT the gcode - that is sent beside this, because a kit's gcode
 * runs to tens of megabytes and holding one in memory to describe it is backwards.
 */
export interface JobDetails {
  /**
   * What this needs, in the PRINTER's names for materials. A client with its own vocabulary resolves
   * it before submitting.
   *
   * The FIRST is the one that must be loaded before it can start; every printer has one extruder.
   * More may be named, and they are carried but not scheduled on.
   */
  filaments: string[];
  /** What a human should see. Absent, the shop names it. */
  displayName?: string;
  /** Where to push it on the printer. Absent, the shop chooses. */
  remotePath?: string;
  /** Which printer, by name. Absent, any printer it fits will do. */
  printer?: string;
  /** The room the SLICED result needs, compared axis for axis with no rotation. */
  requiredBuildVolume?: BuildVolume;
  /**
   * How long printing this is expected to take, in seconds, as whatever sliced it estimated. The
   * shop never measures one and never corrects one; it only adds them up.
   *
   * A field of its own rather than something in `metadata`, because the shop RANKS demand by it and
   * metadata is carried without ever being interpreted. Absent is a client that does not know, which
   * costs a total rather than counting as no work - see `FilamentDemand`.
   */
  estimatedPrintSeconds?: number;
  /**
   * Carried by the shop and never interpreted - how a client keeps its own meaning attached.
   *
   * Names against text, and nothing nested: the shop stores this and hands it back, so what it will
   * take is what it can hand back unchanged. A client with structure of its own encodes it into one
   * of these values and decodes it again on the way out.
   */
  metadata?: Record<string, string>;
}

/**
 * What a caller may see of the work a shop is holding, and how much of it there is altogether.
 *
 * One answer rather than a list and a count asked for separately: a submission landing between two
 * questions would give a caller three jobs and a total of two, and the two have to agree. `totalJobs`
 * is every job the shop holds, whoever owns them - enough to see that the queue is busy, and
 * nothing about whose work it is.
 */
export interface JobsHeld {
  accessibleJobs: Job[];
  totalJobs: number;
}

/**
 * What queued work is waiting for, and how much of it there is - the answer to "what should I load
 * next". Counted by the filament each job STARTS with, because that is the one that has to be on the
 * machine before it can begin.
 *
 * Busiest first, which is by WORK when the shop knows all of it and by count when it does not.
 */
export interface FilamentDemand {
  filament: string;
  jobs: number;
  /**
   * How much printing is waiting on this filament, in seconds - present only when EVERY job counted
   * here said how long it takes. A total summed over the ones that did would understate the queue,
   * and a number that is quietly short is worse to choose by than no number at all.
   */
  estimatedPrintSeconds?: number;
}

/** Where a job is. Derived by the shop from what its printers are holding. */
export type JobState = 'queued' | 'printing' | 'awaiting-approval';

/** What a printer is holding a job FOR. */
export type JobPhase = Exclude<JobState, 'queued'>;

/** How the printer stopped. None of these is a verdict on whether the print is usable. */
export type PrinterOutcome = 'finished' | 'failed' | 'cancelled';

/**
 * What a person says about a print that has finished. `abandoned` is the one that is neither: the
 * print was no good and it is not worth another - the job leaves the shop as an approved one does.
 */
export type Verdict = 'approved' | 'rejected' | 'abandoned';

/** A job as the shop reports it. */
export interface Job extends JobDetails {
  id: number;
  /**
   * The id of the caller who submitted it, written with the record and never rewritten.
   *
   * Absent is a job that belongs to nobody: its submitter was revoked - their entry left the shop's
   * callers and the id it carried is nobody's - or it was submitted before the shop recorded this
   * at all. An admin is then who is left to read and judge it.
   */
  owner?: string;
  displayName: string;
  submittedAt: Date;
  gcodeBytes: number;
  state: JobState;
  /** The printer holding it, when one is. */
  heldBy?: string;
  /** What the printer said when it stopped, which is not a verdict. */
  lastPrinterOutcome?: PrinterOutcome;
}
