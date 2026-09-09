import type { FilamentDemand, Job, JobDetails, JobsHeld, Verdict } from './Job.js';
import type { PrinterRecord, RegisteredPrinter } from './Printer.js';
import type { PrinterAdded, Shop } from './Shop.js';
import { defaultToken } from './token.js';

const DESCRIPTION_PART = 'job';
const GCODE_PART = 'gcode';

/** The shop over its HTTP API, which is the only way in - it runs as its own process. */
export class HttpShop implements Shop {
  // AIDEV-NOTE: the token is taken once, here, so every request carries it without a caller
  // remembering to. Undefined is a caller that has none to present, which every shop refuses - it
  // is not a mode, it is the 401 a caller gets for not having been set up yet.
  constructor(
    private readonly url: string,
    private readonly token: string | undefined = defaultToken()
  ) {}

  async jobs(): Promise<JobsHeld> {
    const held = (await this.answered('GET', '/jobs')) as { accessibleJobs: WireJob[]; totalJobs: number };

    return { accessibleJobs: held.accessibleJobs.map(asJob), totalJobs: held.totalJobs };
  }

  async job(id: number): Promise<Job> {
    return asJob((await this.answered('GET', `/jobs/${id}`)) as WireJob);
  }

  // AIDEV-NOTE: the description part is appended FIRST because the shop requires that order - it
  // validates the description before reading a byte of gcode, which is what lets it refuse a job
  // nothing could print without being sent tens of megabytes to say so. FormData keeps the order.
  //
  // A Blob rather than a path or a stream: it is what fetch will stream without reading whole, and
  // `openAsBlob` gives a caller with a file on disk one backed by that file.
  async submit(details: JobDetails, gcode: Blob): Promise<Job> {
    const body = new FormData();
    body.append(DESCRIPTION_PART, JSON.stringify(details));
    body.append(GCODE_PART, gcode, details.remotePath ?? 'print.gcode');

    return asJob((await this.answered('POST', '/jobs', body)) as WireJob);
  }

  // One route, and a value rather than an endpoint per verdict - so the third one this shop expects
  // ("abandon": do not reprint, but it was not a success) arrives without a new way in.
  async verdict(id: number, verdict: Verdict): Promise<Job | undefined> {
    const answer = (await this.answered('PUT', `/jobs/${id}/verdict`, { verdict })) as WireJob | undefined;

    return answer && asJob(answer);
  }

  async waitingOn(printer?: string): Promise<FilamentDemand[]> {
    const forPrinter = printer === undefined ? '' : `?printer=${encodeURIComponent(printer)}`;

    return (await this.answered('GET', `/filaments${forPrinter}`)) as FilamentDemand[];
  }

  async printers(): Promise<RegisteredPrinter[]> {
    return ((await this.answered('GET', '/printers')) as WirePrinter[]).map(asPrinter);
  }

  // 201 or 200: the shop says whether it made a printer or changed one it already had, and an
  // operator correcting a typo in a name needs to be told which.
  async addPrinter(record: PrinterRecord): Promise<PrinterAdded> {
    const response = await this.reach('POST', '/printers', record);

    return { printer: asPrinter((await bodyOf(response)) as WirePrinter), created: response.status === 201 };
  }

  async removePrinter(name: string): Promise<void> {
    await this.reach('DELETE', printerPath(name));
  }

  async pause(name: string, reason: string): Promise<RegisteredPrinter> {
    return asPrinter((await this.answered('PUT', `${printerPath(name)}/status`, { stopped: true, reason })) as WirePrinter);
  }

  async resume(name: string): Promise<RegisteredPrinter> {
    return asPrinter((await this.answered('PUT', `${printerPath(name)}/status`, { stopped: false })) as WirePrinter);
  }

  async load(name: string, filaments: string[]): Promise<RegisteredPrinter> {
    return asPrinter((await this.answered('PUT', `${printerPath(name)}/filament`, { loaded: filaments })) as WirePrinter);
  }

  async shutDown(): Promise<void> {
    await this.reach('POST', '/shutdown');
  }

  private async answered(method: string, path: string, body?: unknown): Promise<unknown> {
    return bodyOf(await this.reach(method, path, body));
  }

  // AIDEV-NOTE: the shop's own words reach the caller. The far end is what knows WHY - a printer
  // that is not here, a bed nothing has room for, a job nobody has printed yet; this end knows only
  // that something was refused.
  private async reach(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.attempt(method, path, body);
    if (!response.ok) throw new Error(await refusal(response));

    return response;
  }

  private async attempt(method: string, path: string, body?: unknown): Promise<Response> {
    const sent = sending(body);

    try {
      return await fetch(`${this.url}${path}`, {
        method,
        ...sent,
        headers: { ...sent.headers, ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }) },
      });
    } catch {
      throw new Error(`Cannot reach the print shop at ${this.url}. Is it running? Start it with: 3d-print-shop serve`);
    }
  }
}

// A multipart body carries its own content type, boundary and all; JSON has to say so itself.
function sending(body: unknown): { headers?: Record<string, string>; body?: FormData | string } {
  if (body === undefined) return {};
  if (body instanceof FormData) return { body };

  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// A name is whatever an operator typed, and one carrying a `#` would otherwise make a URL whose
// path stops there.
function printerPath(name: string): string {
  return `/printers/${encodeURIComponent(name)}`;
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.status === 204 ? undefined : response.json();
}

async function refusal(response: Response): Promise<string> {
  const said = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;

  return typeof said?.error === 'string' ? said.error : `${response.status} ${response.statusText}`;
}

// AIDEV-NOTE: a time is an ISO string on the wire and a Date in hand. Converting here is the whole
// reason this is a client rather than a cast: a caller handed `submittedAt` typed as a Date and
// holding a string finds out at the first comparison, somewhere else entirely.
type WireJob = Omit<Job, 'submittedAt'> & { submittedAt: string };
type WireTrouble = { reason: string; since: string };
type WirePrinter = Omit<RegisteredPrinter, 'paused' | 'unreachable'> & { paused?: WireTrouble; unreachable?: WireTrouble };

function asJob(job: WireJob): Job {
  return { ...job, submittedAt: new Date(job.submittedAt) };
}

function asPrinter(printer: WirePrinter): RegisteredPrinter {
  return { ...printer, paused: since(printer.paused), unreachable: since(printer.unreachable) };
}

function since(trouble: WireTrouble | undefined): { reason: string; since: Date } | undefined {
  return trouble && { ...trouble, since: new Date(trouble.since) };
}
