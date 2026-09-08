import busboy from 'busboy';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import { InvalidSubmission } from './Job.js';
import type { BuildVolume, Job, JobDetails } from './Job.js';
import { NoSuchJob, NoSuchPrinter, SpoolUnavailable, TooMuchToTake, WrongState } from './JobStore.js';
import type { Caller } from './credentials.js';
import type { JobStore } from './JobStore.js';
import { DEFAULT_PORT } from '@3d-print-shop/client';
import type { PrinterRecord } from './Printer.js';

/** The request was not one the shop could act on - as opposed to one it could and would not. */
export class UnusableRequest extends Error {}

// AIDEV-NOTE: nothing here is authenticated, so whoever can reach the port can submit work, delete a
// printer, or stop the shop mid-print. Until there is a token, the interface it binds is the whole
// of the access control - so it is loopback, and reaching further is something an operator asks for
// with `serve --listen`.
export const LOOPBACK = '127.0.0.1';

// AIDEV-NOTE: NOTHING here stops a large upload - there is no fileSize among these deliberately.
// The store caps the gcode itself, at the byte it is already counting, and what that protects is the
// spool: it IS the recovery model, so filling it loses every job the shop holds and not only the one
// that overflowed. A second cap here would be a second place to get an off-by-one wrong, and busboy
// raises 'limit' on REACHING fileSize rather than passing it - exactly that mistake waiting to
// happen. The one size in this list is fieldSize, which bounds the description and nothing else.
//
// What these bound is how many PARTS a submission may cost, and busboy discards what is past them
// rather than raising - which is what is wanted. A part beyond the count is ignored the same way a
// part with an unknown name already is. What is deliberately NOT done is refusing the request when
// one of them is hit: a count is reached after the gcode part has been read, and by then the job may
// be committed, so a refusal would answer 413 with the job it denies sitting in the spool.
const SUBMISSION_LIMITS = {
  files: 1,
  fields: 4,
  parts: 8,
  fieldSize: 1024 * 1024,
  fieldNameSize: 100,
};

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
/** Nobody presented a token this shop knows. */
export class NotAKnownCaller extends Error {}

/** A caller this shop knows, asking for something their role does not cover. */
export class NotTheirs extends Error {}

// AIDEV-NOTE: the USER-permitted routes are the list, not the admin ones - so a route nobody
// classified needs admin, and forgetting makes the shop stricter rather than looser. The same
// worry as the `changed` hook below (a list somebody forgets to add to), answered the other way:
// there, a miss costs a wake-up; here, a miss would hand a submitting client the shutdown button.
const OPEN_TO_EVERY_CALLER: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/jobs$/ },
  { method: 'GET', path: /^\/jobs$/ },
  { method: 'GET', path: /^\/jobs\/[^/]+$/ },
  { method: 'GET', path: /^\/printers$/ },
];

function needsAdmin(method: string, urlPath: string): boolean {
  return !OPEN_TO_EVERY_CALLER.some((open) => open.method === method && open.path.test(urlPath));
}

// AIDEV-NOTE: `Bearer` because it is what every HTTP client already knows how to send, and because
// a header keeps the token out of a URL - which is where things get logged, cached and pasted.
function tokenIn(header: string | undefined): string | undefined {
  const said = /^Bearer (.+)$/.exec(header ?? '');

  return said?.[1];
}

/** What the shop tells whoever is running it. */
export interface ShopHooks {
  /** Told after every change, so something can decide whether a print could start. */
  changed?: () => void;
  /** Told to shut the shop down. Answered before it happens, because it cannot be answered after. */
  shutDown?: () => void;
  /** Who may talk to this shop, by their token. Absent means anyone reaching the port may. */
  callers?: ReadonlyMap<string, Caller>;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Who is asking, once a token has said so. Absent when the shop has no callers configured. */
    caller?: Caller;
  }
}

export function createApi(shop: JobStore, hooks: ShopHooks = {}): Express {
  const api = express();
  api.use(express.json());

  const changed = hooks.changed ?? ((): void => undefined);
  const callers = hooks.callers;

  // AIDEV-NOTE: before everything, so no route has to remember. A shop given no callers at all is
  // one nobody has set up credentials for - it answers on loopback and refuses nothing, which is
  // what makes a bare `serve` work on a fresh machine; cli.ts is what refuses to open that to the
  // network. Who asked is put on the request rather than used here: the log has nowhere to write it
  // yet, and a name in an ANSWER would tell an unauthenticated caller which names exist.
  api.use((request, _response, next) => {
    if (callers === undefined) return next();

    const caller = callers.get(tokenIn(request.header('authorization')) ?? '');
    if (caller === undefined) throw new NotAKnownCaller('this shop does not know that token');
    if (needsAdmin(request.method, request.path) && caller.role !== 'admin') {
      throw new NotTheirs(`${request.method} ${request.path} is for an admin, and ${caller.name} is not one`);
    }

    request.caller = caller;
    next();
  });

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

  // AIDEV-NOTE: a verdict is a resource rather than an /approve, a /reject and an /abandon, so each
  // one is a value on the same route, and a verdict on a job that has not finished printing is a 409
  // on the thing being set. Only rejecting answers with a job - the other two leave nothing to say.
  api.put('/jobs/:id/verdict', async (request, response) => {
    const { verdict } = request.body as { verdict?: unknown };

    if (verdict !== 'approved' && verdict !== 'rejected' && verdict !== 'abandoned') {
      throw new UnusableRequest(`a verdict is approved, rejected or abandoned, not ${JSON.stringify(verdict)}`);
    }

    const id = jobId(request.params.id);

    if (verdict === 'rejected') {
      response.json(await shop.reject(id));
      return;
    }

    if (verdict === 'approved') {
      await shop.approve(id);
    } else {
      await shop.abandon(id);
    }

    response.status(204).end();
  });

  // Once, where a name ARRIVES, rather than at each route that takes one - the same reasoning as the
  // `changed` hook above. A per-route list is a list somebody forgets to add to, and what would be
  // forgotten here is a recursive delete outside the spool. Mounted on the path, so `POST /printers`
  // (which names a printer in its body, and is checked there) is not caught by it.
  api.use('/printers/:name', (request, _response, next) => {
    requireUsablePrinterName(request.params.name);
    next();
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
export function serve(shop: JobStore, port: number = DEFAULT_PORT, hooks?: ShopHooks, address: string = LOOPBACK): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createApi(shop, hooks).listen(port, address, () => resolve(server));
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
    const parts = busboy({ headers: request.headers, limits: SUBMISSION_LIMITS });
    let details: JobDetails | undefined;
    let taken = false;

    parts.on('field', (name, value, info) => {
      if (name !== DESCRIPTION_PART) return;

      // Truncated JSON would fail to parse anyway, and be reported as a client that sent something
      // malformed rather than something too long.
      if (info.valueTruncated) {
        reject(new TooMuchToTake(`the ${DESCRIPTION_PART} part is longer than ${SUBMISSION_LIMITS.fieldSize} bytes`));
        return;
      }

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

// AIDEV-NOTE: a printer's name becomes a DIRECTORY under the spool, and removePrinter() deletes that
// directory recursively - so a name from a request is a path fragment a client chose. Express hands
// over what the URL decoded to, and `..%2F..%2Fetc` arrives as `../../etc` (measured, not assumed),
// as does a name carrying a NUL.
//
// Refused rather than mangled: the operator chose the name and can choose another. Until this, only
// `add` checked, and the routes taking `:name` were safe only because no printer.json happened to
// exist up the path they built - a property of the filesystem rather than of this code.
export function requireUsablePrinterName(name: string): void {
  const unusable =
    name.trim() === '' ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    [...name].some((character) => {
      const code = character.codePointAt(0) ?? 0;

      return code < 0x20 || code === 0x7f;
    });

  if (unusable) {
    throw new UnusableRequest(`${JSON.stringify(name)} is not a name a printer can have - it becomes a directory`);
  }
}

// AIDEV-NOTE: the shop UPLOADS to this address, with that printer's API key attached, so what it is
// pointed at decides where a key and a plate's gcode end up. What is checked here is the shape: a
// URL it can actually build requests from, over a protocol it speaks, carrying nothing that has no
// business in a base URL.
//
// What is NOT checked is where the address points. A printer reached over a VPN is legitimate, a
// hostname resolves at connect time rather than here so an add-time range check is defeated by
// rebinding, and only an admin may add a printer at all - which is close to what admin means. The
// residual risk is written down in PLAN.md rather than half-answered here.
//
// Credentials and a query are refused rather than dropped: silently ignoring half of what an
// operator typed is how a shop ends up talking to something other than what they meant.
function addressIn(address: string): string {
  const refuse = (why: string): never => {
    throw new UnusableRequest(`${JSON.stringify(address)} is not an address this shop can reach a printer at: ${why}`);
  };

  let reached;
  try {
    reached = new URL(address);
  } catch {
    return refuse('it is not a URL - it needs a scheme, as in http://octopi.local');
  }

  if (reached.protocol !== 'http:' && reached.protocol !== 'https:') refuse(`this shop speaks http and https, not ${reached.protocol.replace(':', '')}`);
  if (reached.username !== '' || reached.password !== '') refuse('it carries a username and password, and a printer is reached with its API key');
  if (reached.search !== '' || reached.hash !== '') refuse('a printer is a host and a path, with nothing after them');

  // Every request appends its own path, so a trailing slash here would double the separator.
  return address.replace(/\/+$/, '');
}

function printerIn(body: unknown): PrinterRecord {
  const { name, buildVolume, address, api } = (body ?? {}) as {
    name?: unknown;
    buildVolume?: unknown;
    address?: unknown;
    api?: unknown;
  };
  if (typeof name !== 'string' || name.trim() === '') throw new UnusableRequest('a printer needs a name');
  requireUsablePrinterName(name);
  if (typeof address !== 'string' || address.trim() === '') throw new UnusableRequest('a printer needs an address to be reached at');
  const reachedAt = addressIn(address.trim());
  if (api !== undefined && api !== 'octoprint') throw new UnusableRequest(`${JSON.stringify(api)} is not a protocol this shop speaks`);

  const { x, y, z } = (buildVolume ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
  if (![x, y, z].every((side) => typeof side === 'number' && Number.isFinite(side) && side > 0)) {
    throw new UnusableRequest('a build volume is x, y and z in mm, each greater than zero');
  }

  return { name, buildVolume: { x, y, z } as BuildVolume, address: reachedAt, api: 'octoprint' };
}

// The message is the answer. Every refusal here is one a client can read and act on, and a stack
// would only tell it about the shop's insides.
// AIDEV-NOTE: a refusal the shop MEANT says why - a printer that is not here, a bed nothing has room
// for. A 500 is the one it did not mean, and its message is written by whatever actually broke:
// node's filesystem errors carry the path they failed on, so a client asking for job 7 would be
// handed the spool's location. Out goes a sentence saying where to look; the real one goes to
// stderr, which is what launchd and systemd capture.
//
// AIDEV-TODO: console.error until there is a Log port to hand this to. See PLAN.md.
function explainRefusal(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const status = statusFor(error);

  if (status === 500) {
    console.error(`3d-print-shop failed to answer a request: ${(error as Error).stack ?? (error as Error).message}`);
    response.status(500).json({ error: 'the shop could not do that, and why is in its log' });

    return;
  }

  response.status(status).json({ error: (error as Error).message });
}

function statusFor(error: unknown): number {
  if (error instanceof NoSuchJob || error instanceof NoSuchPrinter) return 404;
  if (error instanceof WrongState) return 409;
  // A shop whose spool is not there was never installed. That is the machine's fault, not the
  // client's, and a client that retries later is doing the right thing.
  if (error instanceof SpoolUnavailable) return 503;
  if (error instanceof NotAKnownCaller) return 401;
  if (error instanceof NotTheirs) return 403;
  if (error instanceof TooMuchToTake) return 413;
  if (error instanceof InvalidSubmission || error instanceof UnusableRequest) return 400;
  // What express.json() throws at a body that is not JSON; it carries the offending body.
  if (error instanceof SyntaxError && 'body' in error) return 400;

  return 500;
}
