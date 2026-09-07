import busboy from 'busboy';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { InvalidSubmission } from './Job.js';
import type { BuildVolume, Job, JobDetails } from './Job.js';
import { NoSuchJob, NoSuchPrinter, SpoolUnavailable, WrongState } from './JobStore.js';
import type { JobStore } from './JobStore.js';
import { DEFAULT_PORT } from '@3d-print-shop/client';
import type { PrinterRecord } from './Printer.js';

/** The request was not one the shop could act on - as opposed to one it could and would not. */
export class UnusableRequest extends Error {}

const DESCRIPTION_PART = 'job';
const SHUTDOWN_PATH = '/shutdown';
const GCODE_PART = 'gcode';

// Nothing has registered this, and nothing else in the repository listens on it. A client is
// expected to be told where the shop is, so this only saves an operator typing one.
// Re-exported from the contract, so the port the shop listens on and the one its clients look for
// cannot be two different numbers.
export { DEFAULT_PORT } from '@3d-print-shop/client';

// AIDEV-NOTE: the printing loop is deliberately absent. startPrinting, couldNotStart,
// finishedPrinting and the gcode itself are the loop's own bookkeeping, and publishing them would
// invite a second writer into a store built for one - see design/3d-print-shop.md, "The API".
/** What the shop tells whoever is running it. */
export interface ShopHooks {
  /** Told after every change, so something can decide whether a print could start. */
  changed?: () => void;
  /** Told to shut the shop down. Answered before it happens, because it cannot be answered after. */
  shutDown?: () => void;
}

export function createApi(shop: JobStore, hooks: ShopHooks = {}): Express {
  const api = express();
  api.use(express.json());

  const changed = hooks.changed ?? ((): void => undefined);

  // AIDEV-NOTE: told once, here, for every request that CHANGED something - rather than from each
  // route that happens to change something. A per-route list is a list somebody forgets to add to,
  // and a missed wake-up is a job that sits queued for ever. On `finish`, so that what the change
  // prompts happens after the client has its answer and never delays it.
  api.use((request, response, next) => {
    // Shutting down is the one exception: it changes nothing the shop holds, and looking for work
    // on the way out could start a print the shop is about to stop watching.
    if (request.method !== 'GET' && request.path !== SHUTDOWN_PATH) {
      response.on('finish', () => {
        if (response.statusCode < 400) changed();
      });
    }

    next();
  });

  // AIDEV-NOTE: an action, where a verdict is a resource. A verdict is a property of a job that
  // outlives the request and can be read back; this ends the process and leaves nothing to ask
  // about. Answered 202 and acted on once the answer has gone, because a shop that has stopped
  // cannot report that it stopped.
  api.post(SHUTDOWN_PATH, (_request, response) => {
    response.status(202).json({ stopping: true });
    response.on('finish', () => hooks.shutDown?.());
  });

  api.post('/jobs', async (request, response) => {
    response.status(201).json(await submission(shop, request));
  });

  api.get('/jobs', async (_request, response) => {
    response.json(await shop.all());
  });

  api.get('/jobs/:id', async (request, response) => {
    const job = await shop.find(jobId(request.params.id));
    if (!job) throw new NoSuchJob(`no job ${request.params.id}`);

    response.json(job);
  });

  // AIDEV-NOTE: a verdict is a resource rather than an /approve and a /reject, so the third one this
  // design expects - abandon - arrives as another value instead of another route, and a verdict on a
  // job that has not finished printing is a 409 on the thing being set.
  api.put('/jobs/:id/verdict', async (request, response) => {
    const { verdict } = request.body as { verdict?: unknown };

    if (verdict === 'approved') {
      await shop.approve(jobId(request.params.id));
      response.status(204).end();
      return;
    }

    if (verdict !== 'rejected') {
      throw new UnusableRequest(`a verdict is approved or rejected, not ${JSON.stringify(verdict)}`);
    }

    response.json(await shop.reject(jobId(request.params.id)));
  });

  api.get('/printers', async (_request, response) => {
    response.json(await shop.printers());
  });

  // Created or changed is worth saying: adding a printer that is already here silently replaces what
  // the shop knew about it, and an operator correcting a typo in a name would otherwise think they
  // had added a second machine.
  api.post('/printers', async (request, response) => {
    const record = printerIn(request.body);
    const known = (await shop.printers()).some((printer) => printer.name === record.name);

    await shop.addPrinter(record);
    response.status(known ? 200 : 201).json(await shop.printerNamed(record.name));
  });

  api.delete('/printers/:name', async (request, response) => {
    await shop.printerNamed(request.params.name);
    await shop.removePrinter(request.params.name);

    response.status(204).end();
  });

  // AIDEV-NOTE: the operator's word for what is on the machine, because no printer here reports its
  // own filament. It is also a wake-up: what a shop can print changes the instant this does.
  api.put('/printers/:name/filament', async (request, response) => {
    const { loaded } = request.body as { loaded?: unknown };
    if (!Array.isArray(loaded) || loaded.some((filament) => typeof filament !== 'string' || filament.trim() === '')) {
      throw new UnusableRequest('loaded is the filaments on the machine, in order, and an empty list means none');
    }

    response.json(await shop.load(request.params.name, loaded as string[]));
  });

  api.put('/printers/:name/status', async (request, response) => {
    const { stopped, reason } = request.body as { stopped?: unknown; reason?: unknown };

    if (stopped === true) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new UnusableRequest('stopping a printer needs a reason an operator can act on');
      }
      await shop.pause(request.params.name, reason);
    } else if (stopped === false) {
      await shop.resume(request.params.name);
    } else {
      throw new UnusableRequest('a printer status says stopped true or false');
    }

    response.json(await shop.printerNamed(request.params.name));
  });

  api.use(explainRefusal);

  return api;
}

// AIDEV-NOTE: serving answers the API and no more. What starts a print is the `changed` hook above,
// which cli.ts's `serve` gives to a Foreman - so a job submitted over HTTP is started as soon as
// there is a free printer with its filament loaded, and sits queued only while there is not.
// Nothing here reaches a machine itself, which is what keeps the store's one writer one writer.
export function serve(shop: JobStore, port: number = DEFAULT_PORT, hooks?: ShopHooks): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createApi(shop, hooks).listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

// AIDEV-NOTE: the description part has to arrive BEFORE the gcode part, and that is the contract
// rather than something to accommodate. submit() refuses a job no printer could take before reading
// a byte, so this order is what lets a hopeless submission be answered without first receiving tens
// of megabytes in order to answer it - and accommodating the other order means buffering.
//
// busboy rather than multer: multer lands the file in memory or a temp file first, where this hands
// the part to the store as the stream the store exists to take.
function submission(shop: JobStore, request: Request): Promise<Job> {
  return new Promise<Job>((resolve, reject) => {
    const parts = busboy({ headers: request.headers });
    let details: JobDetails | undefined;
    let taken = false;

    parts.on('field', (name, value) => {
      if (name !== DESCRIPTION_PART) return;

      try {
        details = JSON.parse(value) as JobDetails;
      } catch {
        reject(new UnusableRequest(`the ${DESCRIPTION_PART} part is not JSON`));
      }
    });

    parts.on('file', (name, contents) => {
      if (name !== GCODE_PART) {
        contents.resume();
        return;
      }

      if (details === undefined) {
        contents.resume();
        reject(new UnusableRequest(`the ${DESCRIPTION_PART} part has to come before the ${GCODE_PART} part, and did not`));
        return;
      }

      taken = true;
      shop.submit(details, contents).then(resolve, (refusal: unknown) => {
        // The answer is already decided, but a client part way through an upload has to stay
        // connected long enough to read it - so what is still arriving is drained, not dropped.
        contents.resume();
        reject(refusal);
      });
    });

    parts.on('error', reject);
    parts.on('close', () => {
      if (!taken) reject(new UnusableRequest(`a submission needs a ${GCODE_PART} part`));
    });

    request.pipe(parts);
  });
}

function jobId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new NoSuchJob(`no job ${raw}`);

  return id;
}

function printerIn(body: unknown): PrinterRecord {
  const { name, buildVolume, address, api } = (body ?? {}) as {
    name?: unknown;
    buildVolume?: unknown;
    address?: unknown;
    api?: unknown;
  };
  if (typeof name !== 'string' || name.trim() === '') throw new UnusableRequest('a printer needs a name');
  // AIDEV-NOTE: a name becomes a DIRECTORY under the spool, so one carrying a separator would put a
  // printer somewhere the scan does not look and lose it silently. Refused rather than mangled: the
  // operator chose the name and can choose another.
  if (/[/\\]/.test(name) || name === '.' || name === '..') {
    throw new UnusableRequest(`${JSON.stringify(name)} is not a name a printer can have - it becomes a directory`);
  }
  if (typeof address !== 'string' || address.trim() === '') throw new UnusableRequest('a printer needs an address to be reached at');
  if (api !== undefined && api !== 'octoprint') throw new UnusableRequest(`${JSON.stringify(api)} is not a protocol this shop speaks`);

  const { x, y, z } = (buildVolume ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
  if (![x, y, z].every((side) => typeof side === 'number' && Number.isFinite(side) && side > 0)) {
    throw new UnusableRequest('a build volume is x, y and z in mm, each greater than zero');
  }

  return { name, buildVolume: { x, y, z } as BuildVolume, address, api: 'octoprint' };
}

// The message is the answer. Every refusal here is one a client can read and act on, and a stack
// would only tell it about the shop's insides.
function explainRefusal(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  response.status(statusFor(error)).json({ error: (error as Error).message });
}

function statusFor(error: unknown): number {
  if (error instanceof NoSuchJob || error instanceof NoSuchPrinter) return 404;
  if (error instanceof WrongState) return 409;
  // A shop whose spool is not there was never installed. That is the machine's fault, not the
  // client's, and a client that retries later is doing the right thing.
  if (error instanceof SpoolUnavailable) return 503;
  if (error instanceof InvalidSubmission || error instanceof UnusableRequest) return 400;
  // What express.json() throws at a body that is not JSON; it carries the offending body.
  if (error instanceof SyntaxError && 'body' in error) return 400;

  return 500;
}
