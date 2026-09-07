import type { Job, JobDetails, Verdict } from './Job.js';
import type { PrinterRecord, RegisteredPrinter } from './Printer.js';

/** Whether the shop had this printer already, which is the difference between adding and changing. */
export interface PrinterAdded {
  printer: RegisteredPrinter;
  created: boolean;
}

// AIDEV-NOTE: the whole of what a shop can be asked, in one place. There were two clients before -
// one inside gamebox for submitting, one inside the server for the operator's commands - which
// covered different halves of the same API, duplicated the same fetch-and-explain plumbing, and
// covered the job side between them not at all.
export interface Shop {
  /** Everything the shop is holding. */
  jobs(): Promise<Job[]>;
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

  printers(): Promise<RegisteredPrinter[]>;
  addPrinter(record: PrinterRecord): Promise<PrinterAdded>;
  removePrinter(name: string): Promise<void>;
  pause(name: string, reason: string): Promise<RegisteredPrinter>;
  resume(name: string): Promise<RegisteredPrinter>;
  load(name: string, filaments: string[]): Promise<RegisteredPrinter>;

  /** Answers once the shop has agreed to stop, which is before it has. */
  shutDown(): Promise<void>;
}
