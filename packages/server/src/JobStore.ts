import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidSubmission, generatedDisplayName, validateDetails } from './Job.js';
import type { BuildVolume, Job, JobDetails, JobRecord, PrinterOutcome } from './Job.js';
import { canTake } from './Printer.js';
import type { Holding, PrinterRecord, PrinterStatus, RegisteredPrinter } from './Printer.js';
import { defaultSpoolRoot } from './spoolRoot.js';

// AIDEV-NOTE: the largest gcode this shop will take, and so also the room it insists on having
// before it takes any. A kit runs to tens of megabytes, so the default is several times the biggest
// thing expected rather than a number anyone should meet - an operator whose slicer outgrows it
// raises it, and the spool's filesystem is what has to afford it.
const DEFAULT_MAX_GCODE_MB = 128;

export const MAX_GCODE_ENV = 'PRINT_SHOP_MAX_GCODE_MB';

/**
 * The largest gcode this shop takes, in bytes. Said in whole megabytes because that is the unit a
 * gcode file is discussed in, and an operator raising it should not have to count zeroes.
 *
 * OctoPrint itself takes 1GB by default (`server.uploads.maxSize`), so this is the binding limit
 * until it is raised past that.
 */
export function defaultMaxGcodeBytes(): number {
  const said = process.env[MAX_GCODE_ENV];
  const megabytes = said !== undefined && /^\d+$/.test(said) && Number(said) > 0 ? Number(said) : DEFAULT_MAX_GCODE_MB;

  return megabytes * 1024 * 1024;
}

/** What a shop will hold, and how it finds out. Overridden by tests, which have neither the disk nor the patience. */
export interface SpoolLimits {
  maxGcodeBytes?: number;
  freeBytes?: (root: string) => Promise<number>;
}

async function spaceFreeOn(root: string): Promise<number> {
  const room = await statfs(root);
  return room.bavail * room.bsize;
}

// AIDEV-NOTE: the spool is the shop's alone, and integrity is the reason before secrecy. A spool
// another user can WRITE is one where a job's gcode can be swapped for different gcode, and the shop
// sends whatever is there to a printer without question. The ROOT's own mode is the installer's to
// set and `ready()`'s to refuse - these are the entries the shop creates itself.
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const JOBS_DIR = 'jobs';
const PRINTERS_DIR = 'printers';
const NEXT_ID_FILE = 'next-id';
const RECORD_FILE = 'job.json';
const GCODE_FILE = 'print.gcode';
const PRINTER_FILE = 'printer.json';
const STATUS_FILE = 'status.json';

type StoredJob = Omit<JobRecord, 'submittedAt'> & { submittedAt: string };
type StoredStatus = Omit<PrinterStatus, 'paused'> & { paused?: { reason: string; since: string } };

export class NoSuchJob extends Error {}
export class NoSuchPrinter extends Error {}
export class NoPrinterCanTakeIt extends InvalidSubmission {}
export class WrongState extends Error {}
export class SpoolUnavailable extends Error {}

/** More than the shop will hold. Not a malformed request - just a bigger one than it takes. */
export class TooMuchToTake extends Error {}

/**
 * Everything the shop is holding, on disk. One directory per job and one per printer, so reading it
 * back is a scan and surviving a restart costs nothing - there is no index to keep in step.
 */
export class JobStore {
  // AIDEV-NOTE: writes are serialised because allocating an id, and changing a printer's status, are
  // read-modify-writes with an await in the middle - two concurrent ones would interleave and lose
  // a change. This guards a single process only; two processes over one spool would still collide,
  // and nothing here supports that.
  private changing: Promise<unknown> = Promise.resolve();

  /** The largest gcode this shop takes. Read by whatever is receiving an upload, so it can stop one. */
  readonly maxGcodeBytes: number;

  private readonly freeBytes: (root: string) => Promise<number>;

  constructor(
    private readonly root: string = defaultSpoolRoot(),
    limits: SpoolLimits = {}
  ) {
    this.maxGcodeBytes = limits.maxGcodeBytes ?? defaultMaxGcodeBytes();
    this.freeBytes = limits.freeBytes ?? spaceFreeOn;
  }

  /**
   * The details are checked before a byte is read; the gcode is streamed straight to disk, never
   * held whole. Nothing incomplete is ever visible: the record is written last, and a stream that
   * fails or delivers nothing takes the whole job directory with it.
   */
  async submit(details: JobDetails, gcode: Readable, owner: string): Promise<Job> {
    validateDetails(details);
    await this.requireSpool();
    await this.requireRoomForOne();
    await this.requireSomePrinterCouldTakeIt(details);

    const id = await this.serialised(() => this.allocateId());
    const directory = this.jobDir(id);
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

    try {
      const gcodeBytes = await streamToFile(gcode, path.join(directory, GCODE_FILE), this.maxGcodeBytes);
      if (gcodeBytes === 0) {
        throw new InvalidSubmission('a job needs gcode, and the stream delivered none');
      }

      const record: JobRecord = {
        ...details,
        id,
        // AIDEV-NOTE: said by the shop rather than by the submission - a client cannot claim to be
        // somebody else, because this is the caller the request was already authenticated as. It is
        // written here and nowhere again: the record is written once, so an owner is for the life of
        // the job, which is why what is stored is a caller's ID and never their name.
        owner,
        displayName: details.displayName ?? generatedDisplayName(id),
        submittedAt: new Date(),
        gcodeBytes,
      };

      await this.writeRecord(record);

      // Queued because nothing is holding it. Nothing was written to say so.
      return { ...record, state: 'queued' };
    } catch (error) {
      // AIDEV-NOTE: the id is spent rather than reclaimed. Reusing it would mean a number that once
      // named a job naming a different one later, which is exactly what the never-reuse rule is for.
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  // AIDEV-NOTE: refused on the way in rather than left to sit. A job too big for every printer here,
  // or naming a printer that does not exist, will never print - and a client told so at submission
  // can do something about it, where a client whose job silently starves cannot.
  //
  // A shop with no printers takes nothing. That reads harshly and is honest: nothing can print.
  private async requireSomePrinterCouldTakeIt(details: JobDetails): Promise<void> {
    const asJob = { ...details, id: 0, displayName: '', submittedAt: new Date(), gcodeBytes: 0 };
    const printers = await this.printers();

    if (!printers.some((printer) => canTake(printer, asJob))) {
      throw new NoPrinterCanTakeIt(describeWhyNothingCanTakeIt(details, printers));
    }
  }

  /** Answers when the spool is usable, so a service can refuse to start rather than to serve. */
  async ready(): Promise<void> {
    await this.requireSpool();
    await this.requireNobodyElseCanWriteIt();
  }

  /** Everything outstanding. Order is not meaningful - what to print next is decided elsewhere. */
  async all(): Promise<Job[]> {
    await this.requireSpool();

    const printers = await this.printers();
    const entries = await readdir(path.join(this.root, JOBS_DIR)).catch(() => [] as string[]);
    const records = await Promise.all(entries.map((entry) => this.readRecord(Number(entry))));

    return records
      .filter((record): record is JobRecord => record !== undefined)
      .map((record) => asJob(record, printers))
      .sort((one, another) => one.id - another.id);
  }

  async find(id: number): Promise<Job | undefined> {
    await this.requireSpool();

    const record = await this.readRecord(id);
    return record && asJob(record, await this.printers());
  }

  /**
   * Opened only when something is about to print it - see why a job record carries no gcode. A
   * stream, not a Buffer, for the reason it arrived as one: the caller is about to push tens of
   * megabytes at a printer and has no reason to hold them first.
   */
  async gcodeStream(id: number): Promise<Readable> {
    await this.require(id);
    return createReadStream(path.join(this.jobDir(id), GCODE_FILE));
  }

  // AIDEV-NOTE: ONE write, to the printer. A job is printing because a printer says it is holding it
  // to print - there is no second record of that to disagree with this one, and no instant at which
  // the two could be found saying different things.
  async startPrinting(printerName: string, id: number): Promise<Job> {
    const job = await this.require(id);
    const printer = await this.printerNamed(printerName);

    if (printer.paused) throw new WrongState(`${printerName} is stopped: ${printer.paused.reason}`);
    if (printer.holding) throw new WrongState(`${printerName} is already holding job ${printer.holding.job}`);
    if (job.state !== 'queued') throw new WrongState(`job ${id} is ${job.state}, so it cannot be started`);
    if (!canTake(printer, job)) throw new WrongState(`${printerName} cannot take job ${id}`);

    await this.changeStatus(printerName, (status) => ({ ...status, holding: { job: id, phase: 'printing' } }));

    return { ...job, state: 'printing', heldBy: printerName };
  }

  /**
   * Where the printer said it filed the gcode, which is not always where it was asked to.
   *
   * A second write rather than part of `startPrinting`, because until the machine has answered the
   * upload nobody knows the answer - and the printer has to be claimed BEFORE the upload, or two
   * passes over the queue would both send it the same job.
   */
  async printingAt(printerName: string, remotePath: string): Promise<void> {
    const holding = await this.requireHolding(printerName, 'printing');

    await this.changeStatus(printerName, (status) => ({ ...status, holding: { ...holding, remotePath } }));
  }

  /**
   * The printer never took it - the upload failed, the connection was down. Nothing was printed, so
   * the printer simply lets go and the job is queued again by not being held.
   */
  async couldNotStart(printerName: string): Promise<void> {
    await this.letGo(printerName, 'printing');
  }

  /**
   * The printer stopped. `finished` is not approval: it says the machine reached the end, not that
   * what came off the bed is usable - so it keeps holding the job, and the bed, until a person says.
   */
  async finishedPrinting(printerName: string, outcome: PrinterOutcome): Promise<Job> {
    const holding = await this.requireHolding(printerName, 'printing');

    await this.changeStatus(printerName, (status) => ({ ...status, holding: { ...holding, phase: 'awaiting-approval', outcome } }));

    return { ...(await this.require(holding.job)), state: 'awaiting-approval', heldBy: printerName, lastPrinterOutcome: outcome };
  }

  /** The operator says the print is good. The job leaves the shop, gcode and record together. */
  async approve(id: number): Promise<void> {
    await this.leaveTheShop(id);
  }

  // AIDEV-NOTE: the same as approving, and named apart from it because the difference is real to the
  // person giving it and the shop is what forgets it. A shop that could tell them apart afterwards
  // would be keeping a history of work done, which is the one thing it does not hold.
  /** The operator gives up on it. No reprint, and it leaves the shop as an approved job does. */
  async abandon(id: number): Promise<void> {
    await this.leaveTheShop(id);
  }

  /** The operator says it failed. Back to the queue, to be printed again from the same gcode. */
  async reject(id: number): Promise<Job> {
    const printerName = await this.requireAwaitingApproval(id);
    await this.letGo(printerName, 'awaiting-approval');

    return { ...(await this.require(id)), state: 'queued' };
  }

  /** Adds a printer, or changes what the shop knows about one already here. */
  async addPrinter(record: PrinterRecord): Promise<void> {
    await this.requireSpool();
    await mkdir(this.printerDir(record.name), { recursive: true, mode: DIRECTORY_MODE });
    await writeAtomically(this.printerFile(record.name), asJson(record));

    // Only when there is none. Re-adding a printer must not forget what is loaded on it, or that it
    // is stopped, or the job it is holding.
    if ((await this.readStatus(record.name)) === undefined) {
      await this.writeStatus(record.name, { loaded: [] });
    }
  }

  async removePrinter(name: string): Promise<void> {
    const printer = await this.printerNamed(name);
    if (printer.holding) {
      throw new WrongState(`${name} is holding job ${printer.holding.job} - it cannot be taken out of the shop while it has work`);
    }

    await rm(this.printerDir(name), { recursive: true, force: true });
  }

  async printers(): Promise<RegisteredPrinter[]> {
    await this.requireSpool();

    // Sorted, because readdir's order is the filesystem's and an operator reading a list twice
    // should not find it rearranged.
    const names = (await readdir(path.join(this.root, PRINTERS_DIR)).catch(() => [] as string[])).sort();
    const printers = await Promise.all(names.map((name) => this.readPrinter(name)));

    return printers.filter((printer): printer is RegisteredPrinter => printer !== undefined);
  }

  async printerNamed(name: string): Promise<RegisteredPrinter> {
    await this.requireSpool();

    const printer = await this.readPrinter(name);
    if (!printer) throw new NoSuchPrinter(`no printer called ${name} - the operator adds one before it can print`);

    return printer;
  }

  // AIDEV-NOTE: stopping is a property of the PRINTER, not of the shop. A machine that cannot be
  // reached has no business idling one that is working, and whatever prevented one upload will
  // prevent the next - so working down the queue would turn one fault into one failure per job held.
  //
  // Remembered across a restart. Restarting is not evidence the fault is gone, and coming back up
  // working would hide the reason somebody needs to see.
  async pause(name: string, reason: string): Promise<void> {
    await this.changeStatus(name, (status) => ({ ...status, paused: { reason, since: new Date() } }));
  }

  async resume(name: string): Promise<void> {
    await this.changeStatus(name, ({ paused: _paused, ...status }) => status);
  }

  /**
   * What is on the machine now. Nothing else knows it: the printers here do not report their own
   * filament, so the shop asks the operator and believes the answer.
   */
  async load(name: string, filaments: string[]): Promise<RegisteredPrinter> {
    await this.changeStatus(name, (status) => ({ ...status, loaded: filaments }));

    return this.printerNamed(name);
  }

  private async leaveTheShop(id: number): Promise<void> {
    const printerName = await this.requireAwaitingApproval(id);

    // AIDEV-NOTE: let go FIRST, delete second. A crash between them leaves a job nothing is holding,
    // which reads as queued and can be printed again. The other order leaves a printer holding a job
    // that is not there, which is a machine that looks busy for ever.
    await this.letGo(printerName, 'awaiting-approval');
    await rm(this.jobDir(id), { recursive: true, force: true });
  }

  private async letGo(printerName: string, phase: Holding['phase']): Promise<void> {
    await this.requireHolding(printerName, phase);
    await this.changeStatus(printerName, ({ holding: _holding, ...status }) => status);
  }

  private async requireHolding(printerName: string, phase: Holding['phase']): Promise<Holding> {
    const printer = await this.printerNamed(printerName);
    if (!printer.holding) throw new WrongState(`${printerName} is not holding anything`);
    if (printer.holding.phase !== phase) {
      throw new WrongState(`${printerName} is holding job ${printer.holding.job} ${printer.holding.phase}, not ${phase}`);
    }

    return printer.holding;
  }

  private async requireAwaitingApproval(id: number): Promise<string> {
    const job = await this.require(id);
    if (job.state !== 'awaiting-approval' || !job.heldBy) {
      throw new WrongState(`job ${id} is ${job.state}, so there is no print to judge`);
    }

    return job.heldBy;
  }

  private async changeStatus(name: string, change: (status: PrinterStatus) => PrinterStatus): Promise<void> {
    await this.printerNamed(name);

    await this.serialised(async () => {
      const status = (await this.readStatus(name)) ?? { loaded: [] };
      await this.writeStatus(name, change(status));
    });
  }

  private async readPrinter(name: string): Promise<RegisteredPrinter | undefined> {
    const contents = await readFile(this.printerFile(name), 'utf-8').catch(() => undefined);
    if (contents === undefined) return undefined;

    const record = JSON.parse(contents) as PrinterRecord;
    return { ...record, ...((await this.readStatus(name)) ?? { loaded: [] }) };
  }

  private async readStatus(name: string): Promise<PrinterStatus | undefined> {
    const contents = await readFile(this.statusFile(name), 'utf-8').catch(() => undefined);
    if (contents === undefined) return undefined;

    const stored = JSON.parse(contents) as StoredStatus;
    return { ...stored, paused: stored.paused ? { reason: stored.paused.reason, since: new Date(stored.paused.since) } : undefined };
  }

  private async writeStatus(name: string, status: PrinterStatus): Promise<void> {
    await writeAtomically(this.statusFile(name), asJson(status));
  }

  private async require(id: number): Promise<Job> {
    const job = await this.find(id);
    if (!job) throw new NoSuchJob(`no job ${id}`);

    return job;
  }

  // AIDEV-NOTE: the spool root is made at install time and owned by the service's user, the way
  // /var/spool/cups is - so a missing one is a machine that was never set up, not something to
  // quietly create. Creating it would put the shop's work somewhere nobody is looking.
  private async requireSpool(): Promise<void> {
    const usable = await stat(this.root).then(
      (entry) => entry.isDirectory(),
      () => false
    );
    if (!usable) {
      throw new SpoolUnavailable(`${this.root} is not there - it is created when the shop is installed`);
    }
  }

  // AIDEV-NOTE: asked at ready() rather than in requireSpool(), which every call already goes
  // through. A mode is set when the machine is installed and does not change under a running shop,
  // so this is a question about the install - and a stat per request to keep asking it would be a
  // cost paid for nothing.
  //
  // WRITE, and deliberately not read. What a wide root defeats is the 0700 the shop puts on
  // everything it creates: a whole job directory can be renamed away, or a new one put in its place,
  // whatever the modes inside it are. A root somebody else can READ gives up the ids of the jobs
  // held and no more - every record and every gcode is 0600 - and refusing that would stop a shop
  // installed 0750 for an operators' group, which is a working install rather than a fault.
  private async requireNobodyElseCanWriteIt(): Promise<void> {
    const found = await stat(this.root);

    if ((found.mode & 0o022) !== 0) {
      throw new SpoolUnavailable(
        `${this.root} can be written by somebody other than its owner (mode ${(found.mode & 0o777).toString(8)}) - ` +
          'a job could be swapped or taken out of it, so it may not be writable by its group or by anybody else'
      );
    }
  }

  // AIDEV-NOTE: room for the BIGGEST job it would accept, not for this one - the size of an upload
  // is not known until it has arrived, and by then it is already on the disk. Refusing early keeps
  // the shop from filling the spool it recovers from, which would lose every job it is holding and
  // not only the one that overflowed. A full disk is the machine's problem, so a client is told to
  // come back later rather than told it did something wrong.
  private async requireRoomForOne(): Promise<void> {
    const free = await this.freeBytes(this.root);

    if (free < this.maxGcodeBytes) {
      throw new SpoolUnavailable(`${this.root} has ${free} bytes free, and the shop keeps ${this.maxGcodeBytes} spare for a job`);
    }
  }

  private async allocateId(): Promise<number> {
    const file = path.join(this.root, NEXT_ID_FILE);
    const next = await readFile(file, 'utf-8')
      .then((contents) => Number.parseInt(contents.trim(), 10))
      .catch(() => 1);
    const id = Number.isSafeInteger(next) && next > 0 ? next : 1;

    await writeAtomically(file, `${id + 1}\n`);
    return id;
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const done = this.changing.then(work, work);
    this.changing = done.catch(() => undefined);
    return done;
  }

  private async readRecord(id: number): Promise<JobRecord | undefined> {
    const contents = await readFile(path.join(this.jobDir(id), RECORD_FILE), 'utf-8').catch(() => undefined);
    if (contents === undefined) return undefined;

    const stored = JSON.parse(contents) as StoredJob;
    return { ...stored, submittedAt: new Date(stored.submittedAt) };
  }

  private async writeRecord(record: JobRecord): Promise<void> {
    await writeAtomically(path.join(this.jobDir(record.id), RECORD_FILE), asJson(record));
  }

  private jobDir(id: number): string {
    return path.join(this.root, JOBS_DIR, String(id));
  }

  private printerDir(name: string): string {
    return path.join(this.root, PRINTERS_DIR, name);
  }

  private printerFile(name: string): string {
    return path.join(this.printerDir(name), PRINTER_FILE);
  }

  private statusFile(name: string): string {
    return path.join(this.printerDir(name), STATUS_FILE);
  }
}

// AIDEV-NOTE: a job's state is READ from the printers, never from the job. Held by one, it is
// printing or awaiting a verdict; held by none, it is queued. There is nowhere for a second answer
// to be written, so there is nothing to reconcile.
function asJob(record: JobRecord, printers: RegisteredPrinter[]): Job {
  const holder = printers.find((printer) => printer.holding?.job === record.id);
  if (!holder?.holding) return { ...record, state: 'queued' };

  return { ...record, state: holder.holding.phase, heldBy: holder.name, lastPrinterOutcome: holder.holding.outcome };
}

// AIDEV-NOTE: piped rather than buffered - a kit's gcode runs to tens of megabytes, and pipeline()
// gives back-pressure for free. Written under a scratch name and renamed, so a stream that dies
// half way leaves nothing that looks like a finished file.
//
// Counting here rather than trusting a Content-Length: the bytes that arrived are what was stored.
async function streamToFile(source: Readable, file: string, limit: number): Promise<number> {
  const scratch = `${file}.writing`;
  let bytes = 0;

  // AIDEV-NOTE: the cap is enforced where the bytes are already being counted, and enforced by
  // failing the stream the write is reading - so the failure lands inside the pipeline below and
  // unwinds the half-written job with everything else. Refusing it any earlier does not work: a
  // stream destroyed before pipeline() is attached leaves it neither resolved nor rejected, and the
  // request simply never answers. Measured, and it cost an afternoon.
  source.on('data', (chunk: Buffer | string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > limit) {
      source.destroy(new TooMuchToTake(`gcode is longer than the ${limit} bytes this shop takes`));
    }
  });

  await pipeline(source, createWriteStream(scratch, { mode: FILE_MODE }));
  await rename(scratch, file);

  return bytes;
}

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// AIDEV-NOTE: written beside and renamed over, because a rename is atomic and a write is not. A
// restart during a plain write leaves a truncated file, which the next scan cannot parse - and what
// it described is then invisible while the rest of its directory still sits there.
async function writeAtomically(file: string, contents: string): Promise<void> {
  const scratch = `${file}.writing`;
  await writeFile(scratch, contents, { mode: FILE_MODE });
  await rename(scratch, file);
}

// AIDEV-NOTE: says which of the two reasons it was, because "no printer can take this" is useless
// to a client that cannot tell whether it named a printer that is not here or asked for a bed
// nobody has.
function describeWhyNothingCanTakeIt(details: JobDetails, printers: RegisteredPrinter[]): string {
  if (printers.length === 0) {
    return 'this shop has no printers - the operator adds one before anything can be printed';
  }

  if (details.printer !== undefined && !printers.some((printer) => printer.name === details.printer)) {
    const names = printers.map((printer) => printer.name).join(', ');
    return `no printer called ${details.printer} - this shop has ${names}`;
  }

  const needs = details.requiredBuildVolume;
  const sizes = printers.map((printer) => `${printer.name} ${describeVolume(printer.buildVolume)}`).join(', ');

  return `nothing here has room for ${needs ? describeVolume(needs) : 'this job'} - ${sizes}`;
}

function describeVolume(volume: BuildVolume): string {
  return `${volume.x}x${volume.y}x${volume.z}mm`;
}
