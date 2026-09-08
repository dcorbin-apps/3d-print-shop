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
  /** Carried by the shop and never interpreted - how a client keeps its own meaning attached. */
  metadata?: Record<string, unknown>;
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
 */
export interface FilamentDemand {
  filament: string;
  jobs: number;
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
