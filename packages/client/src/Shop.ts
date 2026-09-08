import type { FilamentDemand, Job, JobDetails, JobsHeld, Verdict } from './Job.js';
import type { PrinterRecord, RegisteredPrinter } from './Printer.js';

/** Whether the shop had this printer already, which is the difference between adding and changing. */
export interface PrinterAdded {
  printer: RegisteredPrinter;
  created: boolean;
}

// AIDEV-NOTE: the whole of what a shop can be asked, in one place. There were two clients before -
// one inside the calling application for submitting, one inside the server for the operator's - which
// covered different halves of the same API, duplicated the same fetch-and-explain plumbing, and
// covered the job side between them not at all.
export interface Shop {
  /**
   * What this caller may see, and how many jobs the shop holds altogether. An admin sees a list as
   * long as the total; everybody else sees their own beside a number that says how busy it is.
   */
  jobs(): Promise<JobsHeld>;
  /** Refused as a job that is not here when it is not this caller's to read - see `jobs`. */
  job(id: number): Promise<Job>;
  /**
   * The description goes first and the gcode second, which is the shop's own rule: it refuses a job
   * no printer could take before reading a byte, so a hopeless submission costs no upload.
   */
  submit(details: JobDetails, gcode: Blob): Promise<Job>;
  /**
   * What a person made of a finished print. Answers with the job when it is back in the queue, and
   * with nothing when it has left the shop.
   */
  verdict(id: number, verdict: Verdict): Promise<Job | undefined>;

  /**
   * What the queued work is waiting for, busiest first - the operator's question rather than the
   * shop's. It counts every job the shop holds, so it is not a caller's own view of the queue.
   *
   * Named a printer, it counts only what that machine could take - which is what an operator
   * standing at one of several wants to know.
   */
  waitingOn(printer?: string): Promise<FilamentDemand[]>;

  printers(): Promise<RegisteredPrinter[]>;
  addPrinter(record: PrinterRecord): Promise<PrinterAdded>;
  removePrinter(name: string): Promise<void>;
  pause(name: string, reason: string): Promise<RegisteredPrinter>;
  resume(name: string): Promise<RegisteredPrinter>;
  load(name: string, filaments: string[]): Promise<RegisteredPrinter>;

  /** Answers once the shop has agreed to stop, which is before it has. */
  shutDown(): Promise<void>;
}
