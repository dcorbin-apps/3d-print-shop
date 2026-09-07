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
  displayName: string;
  submittedAt: Date;
  gcodeBytes: number;
  state: JobState;
  /** The printer holding it, when one is. */
  heldBy?: string;
  /** What the printer said when it stopped, which is not a verdict. */
  lastPrinterOutcome?: PrinterOutcome;
}
