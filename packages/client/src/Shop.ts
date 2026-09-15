import type { Caller } from './Caller.js';
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
  // AIDEV-NOTE: the only route that answers with a NAME, which is safe because it is the name of
  // whoever asked. It exists because a client showing a person what they may do has to know what
  // that is, and the alternative - offer everything, let the refusal teach them - is a UI that
  // hands an operator a button and then says no.
  /** Who the shop takes this caller to be, by what they presented. */
  whoAmI(): Promise<Caller>;

  // AIDEV-NOTE: a person logs in; a program presents a token and never touches these. Two kinds of
  // credential for two kinds of caller, both hanging off one identity - a slicer and the person who
  // owns it are the same owner, and the jobs either submits belong to the same id.
  /** Log in with a password, for a caller who is a person rather than a program. */
  logIn(id: string, password: string): Promise<Caller>;
  /** End the session, at the shop rather than only in the browser holding it. */
  logOut(): Promise<void>;

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
  /** Call a job something else. What was submitted is untouched; only what it is called changes. */
  rename(id: number, displayName: string): Promise<Job>;
  /**
   * Hold a queued job back, so the shop passes it over until somebody lets it through.
   *
   * Refused on a job a printer is holding: a hold keeps a job from STARTING, and that one started.
   * What stops a running print is `remove`.
   */
  hold(id: number): Promise<Job>;
  /** Let a held job through. It is queued like any other from that moment. */
  letThrough(id: number): Promise<Job>;
  /**
   * Be rid of a job, which is a different act depending on what it is doing.
   *
   * A QUEUED one is forgotten - the record, the gcode, all of it. A PRINTING one is cancelled on the
   * machine, and does NOT leave: the bed still has plastic on it, so the job lands where a finished
   * one does and waits for somebody's verdict. One already waiting for a verdict is refused, because
   * a verdict is how that one leaves and it already has that route.
   */
  remove(id: number): Promise<void>;

  /**
   * Change your own password, presenting the one you have now.
   *
   * The one this asks for is asked for even though the shop already knows who is asking: a session
   * is a screen somebody walked away from, and a password nobody has to know to change is a password
   * the next person at that screen owns. Every OTHER session this caller holds ends with it.
   */
  changeMyPassword(current: string, password: string): Promise<void>;

  /**
   * What the queued work is waiting for, busiest first - the operator's question rather than the
   * shop's. It counts every job the shop holds, so it is not a caller's own view of the queue.
   *
   * Named a printer, it counts only what that machine could take - which is what an operator
   * standing at one of several wants to know.
   */
  waitingOn(printer?: string): Promise<FilamentDemand[]>;

  printers(): Promise<RegisteredPrinter[]>;
  // AIDEV-NOTE: the key is a second ARGUMENT and not a field of the record, because it is not part
  // of what a printer IS - the shop keeps it in a different file, and one that reached a record
  // would reach the data directory with it. One call rather than two, so a printer cannot land without
  // the key it is reached by; write-only, and there is nothing here that reads one back.
  /**
   * Add a printer, or change what the shop knows about one it already has.
   *
   * The key is what the shop reaches the machine with. Given, it is in force at once - nothing has
   * to be signalled and nothing restarted. Left out, whatever key the shop already had is kept.
   */
  addPrinter(record: PrinterRecord, key?: string): Promise<PrinterAdded>;
  removePrinter(name: string): Promise<void>;
  pause(name: string, reason: string): Promise<RegisteredPrinter>;
  resume(name: string): Promise<RegisteredPrinter>;
  load(name: string, filaments: string[]): Promise<RegisteredPrinter>;

  /** Answers once the shop has agreed to stop, which is before it has. */
  shutDown(): Promise<void>;
}
