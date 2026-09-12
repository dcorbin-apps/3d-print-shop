import busboy from 'busboy';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import * as path from 'node:path';
import { SHOP_ROUTES } from '@3d-print-shop/client';
import { InvalidSubmission } from './Job.js';
import type { BuildVolume, Job, JobDetails } from './Job.js';
import { NoSuchJob, NoSuchPrinter, DataUnavailable, TooMuchToTake, WrongState } from './JobStore.js';
import { Attempts } from './attempts.js';
import type { Callers } from './credentials.js';
import type { Caller } from './credentials.js';
import { hashPassword, isThePassword, newToken } from './secrets.js';
import { LONGEST_MS, SESSION_COOKIE, Sessions } from './sessions.js';
import { silent } from './log.js';
import type { Log } from './log.js';
import type { JobStore } from './JobStore.js';
import type { PrinterRecord } from './Printer.js';
import { waitingOn } from './selection.js';

/** The request was not one the shop could act on - as opposed to one it could and would not. */
export class UnusableRequest extends Error {}

// AIDEV-NOTE: every route names its caller, so the interface is no longer the whole of the access
// control - but a token travels in the clear over http, and the interface that cannot be listened
// to is the one with no network to listen on. Reaching further is something an operator asks for
// with `serve --listen`.
export const LOOPBACK = '127.0.0.1';

// AIDEV-NOTE: NOTHING here stops a large upload - there is no fileSize among these deliberately.
// The store caps the gcode itself, at the byte it is already counting, and what that protects is the
// data directory: it IS the recovery model, so filling it loses every job the shop holds and not only
// that overflowed. A second cap here would be a second place to get an off-by-one wrong, and busboy
// raises 'limit' on REACHING fileSize rather than passing it - exactly that mistake waiting to
// happen. The one size in this list is fieldSize, which bounds the description and nothing else.
//
// What these bound is how many PARTS a submission may cost, and busboy discards what is past them
// rather than raising - which is what is wanted. A part beyond the count is ignored the same way a
// part with an unknown name already is. What is deliberately NOT done is refusing the request when
// one of them is hit: a count is reached after the gcode part has been read, and by then the job may
// be committed, so a refusal would answer 413 with the job it denies sitting in the data directory.
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

/** Too many wrong passwords, too quickly. Says how long rather than what was wrong with them. */
export class TooManyGuesses extends Error {}

/** Where a browser logs in and out. The one route a caller reaches before the shop knows them. */
export const SESSIONS_PATH = '/sessions';

// AIDEV-NOTE: a role is AUTHORITY, and ownership is what is THEIRS - two different questions, and
// this list answers only the first. Whether a caller may see a particular job is `theirs()` below,
// asked inside the routes that name one, because it depends on the job rather than on the route.
//
// AIDEV-NOTE: the USER-permitted routes are the list, not the admin ones - so a route nobody
// classified needs admin, and forgetting makes the shop stricter rather than looser. The same
// worry as the `changed` hook below (a list somebody forgets to add to), answered the other way:
// there, a miss costs a wake-up; here, a miss would hand a submitting client the shutdown button.
const OPEN_TO_EVERY_CALLER: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/jobs$/ },
  { method: 'GET', path: /^\/jobs$/ },
  { method: 'GET', path: /^\/jobs\/[^/]+$/ },
  // A verdict is the owner's to give, which is a thing about the JOB rather than about the caller's
  // role - so the route is open here and the ownership of it is decided in the route itself.
  { method: 'PUT', path: /^\/jobs\/[^/]+\/verdict$/ },
  { method: 'GET', path: /^\/printers$/ },
  // Themselves, and nobody else. See the route.
  { method: 'GET', path: /^\/me$/ },
  // Their OWN password, which is the whole point of it - it is open to everybody because it can only
  // ever change the caller making the request. Changing somebody else's is an operator's, at a
  // terminal, and has no route at all.
  { method: 'PUT', path: /^\/me\/password$/ },
];

// AIDEV-NOTE: matched against the request the way EXPRESS routed it, not the way it was typed.
// Express has non-strict, case-insensitive routing and serves HEAD from a GET route, so `/jobs/`,
// `/JOBS` and a HEAD all reach the same handler - and comparing the raw path meant a user was
// refused a read they were entitled to while an admin sailed through. It failed closed, which is
// why it was invisible: the bug only appeared for the LESS privileged caller.
function needsAdmin(method: string, urlPath: string): boolean {
  const asRouted = method === 'HEAD' ? 'GET' : method;
  const withoutTrailingSlash = urlPath.replace(/\/+$/, '') || '/';

  return !OPEN_TO_EVERY_CALLER.some((open) => open.method === asRouted && new RegExp(open.path.source, 'i').test(withoutTrailingSlash));
}

// AIDEV-NOTE: `Bearer` because it is what every HTTP client already knows how to send, and because
// a header keeps the token out of a URL - which is where things get logged, cached and pasted.
// AIDEV-NOTE: the owner, or any admin. A job with NO owner belongs to nobody - its submitter was
// revoked, their entry gone from callers.json and the id it carried nobody's, or it was written
// before the shop recorded an owner at all. An admin is then the only one left who can read it or
// judge it, which is what keeps a printer's bed from being held for good by a job nobody may end.
function theirs(caller: Caller, job: Job): boolean {
  return caller.role === 'admin' || job.owner === caller.id;
}

// AIDEV-NOTE: parsed here rather than by a dependency, because it is one header and one name, and
// what a cookie parser would add is a place for a second opinion about what a cookie is.
function cookieIn(header: string | undefined, name: string): string | undefined {
  for (const said of (header ?? '').split(';')) {
    const at = said.indexOf('=');
    if (at > 0 && said.slice(0, at).trim() === name) return decodeURIComponent(said.slice(at + 1).trim());
  }

  return undefined;
}

// AIDEV-NOTE: a browser sends `Origin` on every request that is not a plain navigation, so a write
// carrying a session and no origin is not a browser doing what browsers do - which is what makes
// refusing it safe. Compared against the Host the request arrived at rather than anything
// configured: the shop does not know its own name, and whatever reached it is what a page served by
// it would say.
function requireItCameFromHere(request: Request): void {
  const origin = request.header('origin');
  if (origin === undefined) throw new NotTheirs('a write carrying a session has to say where it came from');

  const host = request.header('host');
  if (host === undefined || new URL(origin).host !== host) {
    throw new NotTheirs(`${origin} is not this shop, so a session from it is not one to act on`);
  }
}

function tokenIn(header: string | undefined): string | undefined {
  const said = /^Bearer (.+)$/.exec(header ?? '');

  return said?.[1];
}

/** What the shop tells whoever is running it. */
export interface ShopHooks {
  /** Told after every change, so something can decide whether a print could start. */
  changed?: () => void;
  // AIDEV-NOTE: apart from `changed` because it says WHICH printer and that a PERSON asked. Looking
  // for work does not pick a lost print back up - the printer is holding one already - and nothing
  // else can tell the shop to stop waiting out a backoff it decided on by itself.
  /** Told when an operator starts a printer, which is the shop's cue to try everything again. */
  started?: (name: string) => void;
  /** Told to shut the shop down. Answered before it happens, because it cannot be answered after. */
  shutDown?: () => void;
  // AIDEV-NOTE: a hook rather than something the API does, because the keys are the running shop's
  // rather than the store's - they reach OctoPrintMachines and the log's redactor, and neither is
  // anything this layer holds. Absent is a shop that will not take one, which is what an API served
  // without one should be.
  /** Give a printer its key: written where the shop keeps them, and in force from that moment. */
  keyGiven?: (printer: string, key: string) => Promise<void>;
  // AIDEV-NOTE: the same reasoning as `keyGiven` - the credentials are the running shop's file and
  // not the store's, and what is in force is what this process holds. Absent is a shop that will not
  // take one, which is what an API served without anywhere to write should be.
  /** Write a caller's new password where the shop keeps them, and put it in force at once. */
  passwordChanged?: (id: string, password: string) => Promise<void>;
  // Asked per request rather than handed over once: the shop re-reads its callers on SIGHUP, so a
  // credential added or revoked while it runs is the one the next request is judged against.
  /** Who may talk to this shop. Every request names one of them, or is refused. */
  callers: () => Callers;
  // AIDEV-NOTE: handed in only so that a test can hold a clock. A session belongs to the process
  // that is serving, not to anything outside it - there is nowhere else for one to live.
  /** Where the sessions a browser holds are kept. Its own, unless a caller wants to watch the time. */
  sessions?: Sessions;
  // AIDEV-NOTE: a DIRECTORY, and the server is told nothing else about it. What is in there is the
  // browser page, and the page is a CLIENT of this shop - it reaches the API through
  // @3d-print-shop/client like any other. So the server resolving those files through the ui package
  // would be the server depending on a client, which is the direction that may never run. It serves
  // files at a path; whoever installed it knows which files those are.
  /** A directory of files to serve beside the API, for a browser that has to get the page somewhere. */
  page?: string;
  /** Where the running service writes down what it did. Silent unless somebody supplies one. */
  log?: Log;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Who is asking. Set before any route is reached, because no route answers a caller without one. */
    caller: Caller;
    /** The session they carried, when it was a session rather than a token that named them. */
    session?: string;
  }
}

export function createApi(shop: JobStore, hooks: ShopHooks): Express {
  const api = express();
  api.use(express.json());

  const changed = hooks.changed ?? ((): void => undefined);
  const started = hooks.started ?? ((): void => undefined);
  const callers = hooks.callers;
  const keyGiven = hooks.keyGiven;
  const passwordChanged = hooks.passwordChanged;
  const page = hooks.page;
  const sessions = hooks.sessions ?? new Sessions();
  const attempts = new Attempts();

  // AIDEV-NOTE: a hash of something nobody knows, to be checked against when there is nobody of the
  // name somebody logged in with - so that an unknown name costs the same 50ms as a wrong password
  // and the fast refusals are not a list of which names exist. Made once per shop and never
  // written down, because nothing ever has to match it.
  const nobody = hashPassword(newToken());
  const log = hooks.log ?? silent;

  // AIDEV-NOTE: first, so it covers the requests the next middleware REFUSES - a shop being asked
  // for things by somebody it cannot name is the most interesting line it will ever write, and a
  // logger installed after the guard would be the one thing that never sees it.
  //
  // The same `finish` seam the `changed` hook uses, and deliberately not the same middleware: that
  // one runs after the guard and only for requests that changed something.
  api.use((request, response, next) => {
    const began = Date.now();

    response.on('finish', () => {
      const about = {
        method: request.method,
        path: request.path,
        status: response.statusCode,
        ms: Date.now() - began,
        // Whoever it turned out to be, which is nobody when the guard refused them.
        caller: request.caller?.name,
      };

      if (response.statusCode >= 500) log.error('request failed', about);
      else log.info('request', about);
    });

    next();
  });

  // AIDEV-NOTE: BEFORE the guard, deliberately: the page nobody is logged in to yet is the page
  // somebody logs in ON. There is nothing in it worth a credential - a bundle and a stylesheet,
  // which every visitor needs before they can present anything - and requiring one would be a login
  // screen that cannot be fetched without having logged in.
  if (page !== undefined) servePageFrom(api, path.resolve(page));

  // AIDEV-NOTE: BEFORE the guard, and the only ROUTE that is - there is nowhere else for somebody
  // with a password and no session to start. Everything about it is deliberately slow and vague: one
  // answer for a name nobody has and for a password that is wrong, a wait that widens with every
  // miss, and scrypt in the middle whatever happens, so that "how long did it take" says nothing
  // either.
  api.post(SESSIONS_PATH, async (request, response) => {
    const { id, password } = bodyOf(request);
    if (typeof id !== 'string' || typeof password !== 'string') throw new UnusableRequest('a login is an id and a password');

    const from = request.ip ?? 'nowhere';
    const waiting = attempts.mustWait(id);
    if (waiting > 0) {
      log.info('a login was turned away for asking too often', { id, from, seconds: Math.ceil(waiting / 1000) });
      throw new TooManyGuesses(`too many tries - wait ${Math.ceil(waiting / 1000)} seconds`);
    }

    const known = callers().named(id);

    // AIDEV-NOTE: hashed even when there is nobody of that name, against a hash of nothing - so that
    // a name this shop does not know takes exactly as long to refuse as a password that is wrong.
    // Without it, the fast refusals are a list of which names exist.
    const right = known?.password !== undefined && (await isThePassword(password, known.password));

    if (!right) {
      if (known?.password === undefined) await isThePassword(password, await nobody);
      attempts.wasWrong(id);
      log.info('a login was refused', { id, from });

      throw new NotAKnownCaller('that is not a name and a password this shop knows');
    }

    attempts.wasRight(id);
    const secret = sessions.begin(known.caller.id);
    log.info('somebody logged in', { caller: known.caller.name, from });

    // AIDEV-NOTE: HttpOnly so that a script on the page cannot read it, which is the whole reason
    // this is a cookie rather than something the page keeps - an XSS that can read a token has the
    // token. SameSite=Strict so that a form on another site cannot post here carrying it, which is
    // most of what CSRF is. Secure only when the request actually arrived over TLS, because a shop
    // on loopback http would otherwise set a cookie the browser refuses to send back.
    response.cookie(SESSION_COOKIE, secret, {
      httpOnly: true,
      sameSite: 'strict',
      secure: request.secure,
      path: '/',
      maxAge: LONGEST_MS,
    });

    response.status(201).json(known.caller);
  });

  // AIDEV-NOTE: before everything else, so no route has to remember. There is no anonymous mode, not
  // even on loopback: a shop that answered an unnamed request is one where a job has no submitter to
  // belong to, so the case is removed rather than handled - `callersIn` refuses to read a shop into
  // existence without callers. Who asked is put on the request rather than used here: the log has
  // nowhere to write it yet, and a name in an ANSWER would tell a stranger which names exist.
  //
  // Two ways in, and they are not the same kind of thing. A SESSION is a browser's, issued by this
  // shop and expiring; a TOKEN is a machine's, configured by a person and lasting until somebody
  // takes it away. A session is looked at first because a browser carrying both is a browser that
  // logged in.
  api.use((request, _response, next) => {
    const session = cookieIn(request.header('cookie'), SESSION_COOKIE);
    const whose = session === undefined ? undefined : sessions.whose(session);
    const caller = whose === undefined ? callers().presenting(tokenIn(request.header('authorization')) ?? '') : callers().named(whose)?.caller;

    if (caller === undefined) throw new NotAKnownCaller('this shop does not know that token');

    // AIDEV-NOTE: the second half of what SameSite is for, and it is here because SameSite is a
    // rule the BROWSER keeps - this is the shop keeping it too. A cookie is sent by whatever page
    // asked, so a write that arrived with one has to have come from this shop's own page; a token
    // is not sent by a browser on anybody's behalf and needs none of this.
    if (whose !== undefined && request.method !== 'GET') requireItCameFromHere(request);

    if (needsAdmin(request.method, request.path) && caller.role !== 'admin') {
      throw new NotTheirs(`${request.method} ${request.path} is for an admin, and ${caller.name} is not one`);
    }

    request.caller = caller;
    request.session = session;
    next();
  });

  /** Logging out, which is the session ending rather than the browser forgetting it. */
  api.delete(SESSIONS_PATH, (request, response) => {
    if (request.session !== undefined) sessions.end(request.session);
    response.clearCookie(SESSION_COOKIE, { path: '/' });

    response.status(204).end();
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
    const job = await submission(shop, request, request.caller.id);

    log.info('job submitted', {
      job: job.id,
      displayName: job.displayName,
      filaments: job.filaments,
      gcodeBytes: job.gcodeBytes,
      owner: job.owner,
    });

    response.status(201).json(job);
  });

  // AIDEV-NOTE: the only route that answers with a NAME, and safe for that reason alone - it is the
  // name of whoever asked, which they already know. Nothing is looked up: the guard above resolved
  // this caller before any route was reached, so this says back what the token was worth.
  //
  // It exists so that a client can show a person what they may do rather than offering everything
  // and letting the refusal teach them, which is a UI that hands an operator a button and says no.
  api.get('/me', (request, response) => {
    response.json(request.caller);
  });

  // AIDEV-NOTE: a caller's own, and only their own - the id is taken from who the request turned out
  // to be and never read out of the body, so there is no shape of request that changes somebody
  // else's. An operator changing another person's is `caller password` at a terminal, which is a
  // different act by a different person and has no route here.
  //
  // The password they have NOW is asked for even though the shop already knows who is asking,
  // because a session is a screen somebody walked away from - and a password nobody has to know to
  // change is a password the next person to sit down owns. Throttled against the same counts as a
  // login, because it is the same oracle: something that says whether a guess was right.
  api.put('/me/password', async (request, response) => {
    if (passwordChanged === undefined) throw new UnusableRequest('this shop was not given anywhere to keep a password');

    const { current, password } = bodyOf(request);
    if (typeof current !== 'string' || typeof password !== 'string') {
      throw new UnusableRequest('changing a password is the one you have now and the one you want');
    }

    const who = request.caller;
    const from = request.ip ?? 'nowhere';
    const waiting = attempts.mustWait(who.id);
    if (waiting > 0) throw new TooManyGuesses(`too many tries - wait ${Math.ceil(waiting / 1000)} seconds`);

    // A caller with no password is a machine's token, and there is nothing here for it to prove.
    // Giving one their first password is an operator's act, at the terminal, like taking one away.
    const held = callers().named(who.id)?.password;
    if (held === undefined || !(await isThePassword(current, held))) {
      attempts.wasWrong(who.id);
      log.info('a password change was refused', { caller: who.name, from });

      // Not 401: the session is perfectly good, and a client that read this as an expired one would
      // throw somebody off the page for mistyping.
      throw new NotTheirs('that is not the password this caller has now');
    }

    if (await isThePassword(password, held)) throw new UnusableRequest('that is the password already in use');

    attempts.wasRight(who.id);
    await passwordChanged(who.id, password);

    // AIDEV-NOTE: every other one, and this one kept. Somebody changing their password either forgot
    // it or believes somebody else has it, so the browsers already logged in as them are what this
    // is for - but throwing the person doing it off the screen they are standing at would be a page
    // that asks them to log in again for having just proved who they are.
    sessions.endEveryOneOf(who.id, request.session);
    log.info('somebody changed their own password', { caller: who.name, from });

    response.status(204).end();
  });

  api.get('/jobs', async (request, response) => {
    const held = await shop.all();

    response.json({ accessibleJobs: held.filter((job) => theirs(request.caller, job)), totalJobs: held.length });
  });

  api.get('/jobs/:id', async (request, response) => {
    const job = await shop.find(jobId(request.params.id));

    // AIDEV-NOTE: not this caller's is answered as not here, deliberately - a 403 would tell a
    // stranger that job 7 exists, which is the one thing a caller who may not read it is not to
    // learn. A bare total is what they get instead, and that is on GET /jobs.
    if (!job || !theirs(request.caller, job)) throw new NoSuchJob(`no job ${request.params.id}`);

    response.json(job);
  });

  // AIDEV-NOTE: a verdict is a resource rather than an /approve, a /reject and an /abandon, so each
  // one is a value on the same route, and a verdict on a job that has not finished printing is a 409
  // on the thing being set. Only rejecting answers with a job - the other two leave nothing to say.
  api.put('/jobs/:id/verdict', async (request, response) => {
    const { verdict } = bodyOf(request);

    if (verdict !== 'approved' && verdict !== 'rejected' && verdict !== 'abandoned') {
      throw new UnusableRequest(`a verdict is approved, rejected or abandoned, not ${JSON.stringify(verdict)}`);
    }

    const id = jobId(request.params.id);

    // AIDEV-NOTE: after the body and before the shop is asked to do anything. Not this caller's is
    // answered as not here, for the reason GET /jobs/:id is - a 403 would say that job 7 exists. The
    // body is judged FIRST because a complaint about the body reveals nothing either way, and a
    // request that brought none is a client's mistake worth naming as one.
    const judging = await shop.find(id);
    if (!judging || !theirs(request.caller, judging)) throw new NoSuchJob(`no job ${id}`);

    // AIDEV-NOTE: the one place a verdict is recorded at all. The job leaves the shop when it is
    // approved and the store keeps no history, so without this line nothing afterwards can say what
    // was decided about job 7 - or that an ADMIN decided it rather than the person who asked for it.
    log.info('verdict given', { job: id, verdict, by: request.caller.name, owner: judging.owner });

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
  // forgotten here is a recursive delete outside the data directory. Mounted on the path, so `POST /printers`
  // (which names a printer in its body, and is checked there) is not caught by it.
  //
  // AIDEV-NOTE: a name arrives three ways, and this mount is only one of them - a path segment here,
  // a body on `POST /printers` (`printerIn`), and a query string on `GET /filaments`
  // (`onePrinterName`). The query string was the one this list forgot; all three are checked now.
  // A fourth arrival is the thing to watch for, and the store building the path is where it would
  // stop being possible to forget - see PLAN.md.
  api.use('/printers/:name', (request, _response, next) => {
    requireUsablePrinterName(request.params.name);
    next();
  });

  // AIDEV-NOTE: a top-level resource rather than anything under /jobs, which would collide with
  // GET /jobs/{id} and be resolved by whichever route express happened to see first - a trap that
  // moves the moment somebody reorders these. It is what the QUEUE is waiting for, seen by filament.
  //
  // Admin, by not being on the open list above: it is an aggregate over everybody's work, which is
  // more than the bare total a caller who owns none of it may learn - and the person who acts on it
  // is the one who loads the machine, which is already an admin's to do.
  api.get('/filaments', async (request, response) => {
    const named = onePrinterName(request.query.printer);
    const printer = named === undefined ? undefined : await shop.printerNamed(named);

    response.json(waitingOn(await shop.all(), printer));
  });

  api.get('/printers', async (_request, response) => {
    response.json(await shop.printers());
  });

  // Created or changed is worth saying: adding a printer that is already here silently replaces what
  // the shop knew about it, and an operator correcting a typo in a name would otherwise think they
  // had added a second machine.
  // AIDEV-NOTE: the key comes in HERE rather than through a route of its own, because adding a
  // printer is ONE act - two calls would let a machine land without the key it is reached by, and
  // leave a client to unpick which half happened. It is read out of the body and never reaches the
  // record: `printerIn` builds a fresh object of the four fields a printer IS, so a key cannot
  // follow it into printer.json however the body was shaped.
  //
  // Both are judged before either is written, which is as close to one act as two files get. The
  // record goes first: a key kept for a printer that was refused would be a key for nothing.
  api.post('/printers', async (request, response) => {
    const record = printerIn(request.body);
    const key = keyIn(request.body);
    if (key !== undefined && keyGiven === undefined) throw new UnusableRequest('this shop was not given anywhere to keep a printer key');

    const known = (await shop.printers()).some((printer) => printer.name === record.name);

    await shop.addPrinter(record);
    if (key !== undefined) await keyGiven?.(record.name, key);

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
    const { loaded } = bodyOf(request);
    if (!Array.isArray(loaded) || loaded.some((filament) => typeof filament !== 'string' || filament.trim() === '')) {
      throw new UnusableRequest('loaded is the filaments on the machine, in order, and an empty list means none');
    }

    const printer = await shop.load(request.params.name, loaded as string[]);
    log.info('filament loaded', { printer: printer.name, loaded: printer.loaded });

    response.json(printer);
  });

  api.put('/printers/:name/status', async (request, response) => {
    const { stopped, reason } = bodyOf(request);

    if (stopped === true) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new UnusableRequest('stopping a printer needs a reason an operator can act on');
      }
      await shop.pause(request.params.name, reason);
      log.info('printer stopped', { printer: request.params.name, why: reason, by: request.caller.name });
    } else if (stopped === false) {
      await shop.resume(request.params.name);
      log.info('printer started', { printer: request.params.name, by: request.caller.name });
      started(request.params.name);
    } else {
      throw new UnusableRequest('a printer status says stopped true or false');
    }

    response.json(await shop.printerNamed(request.params.name));
  });

  api.use((error: unknown, request: Request, response: Response, next: NextFunction) => explainRefusal(log, error, request, response, next));

  return api;
}

// AIDEV-NOTE: serving answers the API and no more. What starts a print is the `changed` hook above,
// which cli.ts's `serve` gives to a Foreman - so a job submitted over HTTP is started as soon as
// there is a free printer with its filament loaded, and sits queued only while there is not.
// Nothing here reaches a machine itself, which is what keeps the store's one writer one writer.
// AIDEV-NOTE: static first, then everything the static did not have - which is how a page a browser
// navigated INTO rather than loaded at the root survives a reload. What it must never swallow is one
// of the shop's own paths: those are the client's list, so a route added there cannot quietly start
// being answered with a page.
function servePageFrom(api: Express, page: string): void {
  api.use(express.static(page, { index: false }));

  api.use((request, response, next) => {
    if (request.method !== 'GET' || isTheShops(request.path)) {
      next();
      return;
    }

    response.sendFile(path.join(page, 'index.html'));
  });
}

function isTheShops(asked: string): boolean {
  return SHOP_ROUTES.some((route) => asked === route || asked.startsWith(`${route}/`));
}

export function serve(shop: JobStore, port: number, hooks: ShopHooks, address: string = LOOPBACK): Promise<Server> {
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
function submission(shop: JobStore, request: Request, owner: string): Promise<Job> {
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

      shop.submit(details, contents, owner).then(resolve, (refusal: unknown) => {
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

// AIDEV-NOTE: a printer's name becomes a DIRECTORY under the data root, and removePrinter() deletes that
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

  if (reached.protocol !== 'http:' && reached.protocol !== 'https:')
    refuse(`this shop speaks http and https, not ${reached.protocol.replace(':', '')}`);
  if (reached.username !== '' || reached.password !== '')
    refuse('it carries a username and password, and a printer is reached with its API key');
  if (reached.search !== '' || reached.hash !== '') refuse('a printer is a host and a path, with nothing after them');

  // Every request appends its own path, so a trailing slash here would double the separator.
  return address.replace(/\/+$/, '');
}

// AIDEV-NOTE: express.json() leaves `body` undefined when there was none, or when it did not say it
// was JSON - and destructuring that throws a TypeError, which reaches the client as a 500. A request
// with no body is the CLIENT's mistake, and the route's own check is what should name it.
function bodyOf(request: Request): Record<string, unknown> {
  const body = request.body as unknown;

  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

// AIDEV-NOTE: read apart from the record and never folded into it - a key is not what a printer IS,
// it is what the shop reaches one with, and the two are kept in different files for that reason.
// Absent is a printer whose key the shop already has, or one nobody has given a key to yet; empty is
// somebody who meant to give one and did not, which is worth saying rather than storing.
function keyIn(body: unknown): string | undefined {
  const { key } = (body ?? {}) as { key?: unknown };
  if (key === undefined) return undefined;
  if (typeof key !== 'string' || key.trim() === '') throw new UnusableRequest('a key is the string the shop reaches the printer with');

  return key;
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
// handed the data directory's location. Out goes a sentence saying where to look; the real one goes to the
// shop's log, which is what launchd and systemd capture.
function explainRefusal(log: Log, error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const status = statusFor(error);

  if (status === 500) {
    // The one the shop did NOT mean, so the whole of what broke goes down - and the client is told
    // nothing but where to look, because a message written by node carries paths and arguments.
    log.error('the shop could not answer a request', { why: (error as Error).stack ?? (error as Error).message });
    response.status(500).json({ error: 'the shop could not do that, and why is in its log' });

    return;
  }

  // AIDEV-NOTE: every DataUnavailable names the directory - it is not there, it has N bytes free, it is
  // one somebody else could write - and that path is the whole of what an OPERATOR needs and none of
  // what a client does. Same split as the 500 above, for the same reason: the sentence goes to the
  // log, and what goes out is that the machine cannot answer just now. The exception keeps the path,
  // because the other reader of these is `serve` refusing to start, where it is all there is to say.
  if (error instanceof DataUnavailable) {
    log.error('the shop cannot use where it keeps its work', { why: (error as Error).message });
    response.status(status).json({ error: 'the shop cannot get at the work it keeps, and why is in its log' });

    return;
  }

  response.status(status).json({ error: (error as Error).message });
}

// AIDEV-NOTE: express parses `?printer=a&printer=b` into an array and `?printer[x]=y` into an
// object, so what arrives here is not a string because a caller wrote one. Answering for the shop
// when a caller asked about a machine would be the wrong answer said confidently, so it is refused.
//
// AIDEV-NOTE: and then checked as a NAME, because this is the second way one arrives. The mount on
// `/printers/:name` catches every name that comes in a path and cannot catch this one, which comes
// in a query string - so `?printer=../../../somewhere` reached `printerNamed` and read a
// printer.json outside the data directory. What it gave back was an oracle: a file that parses
// answered 200, one that is not there 404, one that is not JSON 500.
export function onePrinterName(asked: unknown): string | undefined {
  if (asked === undefined) return undefined;

  if (typeof asked !== 'string' || asked.trim() === '') {
    throw new UnusableRequest('printer names one machine to answer for, and the whole shop answers when it is left out');
  }

  requireUsablePrinterName(asked);

  return asked;
}

function statusFor(error: unknown): number {
  if (error instanceof NoSuchJob || error instanceof NoSuchPrinter) return 404;
  if (error instanceof WrongState) return 409;
  // A shop whose data directory is not there was never installed. That is the machine's fault, not the
  // client's, and a client that retries later is doing the right thing.
  if (error instanceof DataUnavailable) return 503;
  if (error instanceof NotAKnownCaller) return 401;
  if (error instanceof TooManyGuesses) return 429;
  if (error instanceof NotTheirs) return 403;
  if (error instanceof TooMuchToTake) return 413;
  if (error instanceof InvalidSubmission || error instanceof UnusableRequest) return 400;
  // What express.json() throws at a body that is not JSON; it carries the offending body.
  if (error instanceof SyntaxError && 'body' in error) return 400;

  return 500;
}
