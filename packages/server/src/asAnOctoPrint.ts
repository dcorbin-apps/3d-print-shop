import busboy from 'busboy';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Express, Request } from 'express';
import { InvalidSubmission, validateDetails } from './Job.js';
import type { Job, JobDetails } from './Job.js';
import { TooMuchToTake, WrongState } from './JobStore.js';
import type { JobStore } from './JobStore.js';
import { silent } from './log.js';
import type { Log } from './log.js';
import { READS, slicedPlate } from './slicedPlate.js';

/** What the face needs: a shop to submit into, and somewhere to put a plate while it reads it. */
export interface AnOctoPrint {
  shop: JobStore;
  // AIDEV-NOTE: an in-flight upload belongs where a claim belongs - somewhere a reboot empties. It is
  // not work the shop has taken on until `submit` has written a record, so a crash mid-upload must
  // leave nothing behind that a rescan would find.
  /** Where a plate is parked while it is read. Emptied by a reboot, and never the jobs directory. */
  spool: string;
  log?: Log;
}

// AIDEV-NOTE: what a caller is told this is. The version is a real one, and saying it is the whole
// reason this route exists: a caller asks before it will upload anything, and one that does not
// recognise the answer stops there. `shop` is said beside it because nothing else here will be
// honest about what this actually is.
const CLAIMED = { api: '0.1', server: '1.9.3', text: 'OctoPrint 1.9.3', shop: '3d-print-shop' };

// AIDEV-NOTE: 64K each end, against a measured 17K - the plate in tests/assumptions keeps its whole
// settings block within that of its last byte, and whatAPlateSays.test.ts fails if a plate ever needs
// more than this window allows. The head is nearly all thumbnail in that one and carries
// no settings at all; it is read anyway because not every tool writes its block at the end.
/** How much of each end of a plate is read looking for what it says about itself. */
export const ENDS_BYTES = 64 * 1024;

const PLATE_PART = 'file';

export function serveAsAnOctoPrint(api: Express, prefix: string, what: AnOctoPrint): void {
  const log = what.log ?? silent;

  api.get(`${prefix}/api/version`, (_request, response) => {
    response.json(CLAIMED);
  });

  api.get(`${prefix}/api/server`, (_request, response) => {
    response.json({ version: CLAIMED.server, safemode: null });
  });

  // AIDEV-NOTE: asked by callers that want to know what they are talking to before they talk to it.
  // Empty is a legal answer and the honest one - every setting a real one would list here is about a
  // machine, and this is not a machine.
  api.get(`${prefix}/api/settings`, (_request, response) => {
    response.json({});
  });

  api.post(`${prefix}/api/files/local`, async (request, response) => {
    const { job, filename } = await takeAPlate(what, request, request.caller.id);

    log.info('a plate arrived over the borrowed protocol', {
      job: job.id,
      displayName: job.displayName,
      filaments: job.filaments,
      gcodeBytes: job.gcodeBytes,
      owner: job.owner,
    });

    response.status(201).json(answerFor(request, prefix, job, filename));
  });

  // AIDEV-NOTE: the point past which this stops pretending. These commands mean START NOW and STOP
  // NOW against a machine somebody is standing at, and there is no honest translation of them into a
  // queue that decides for itself when a job may run - so they are refused, and the refusal says so.
  api.post(`${prefix}/api/job`, () => {
    throw new WrongState('this is a print shop and not a printer - it decides when a job runs, and a job cannot be commanded through this');
  });
}

// AIDEV-NOTE: the plate is spooled WHOLE before anything is decided about it, which is the opposite
// of how the shop's own submission works - that one refuses a hopeless job before reading a byte. It
// has to be this way round here: what the job needs is written INSIDE the plate, so there is nothing
// to judge until the bytes have been read. The cost is that the plate is written twice, and that a
// submission nothing can take is answered only once it has all arrived.
function takeAPlate(what: AnOctoPrint, request: Request, owner: string): Promise<Taken> {
  const parked = path.join(what.spool, `${randomUUID()}.gcode`);

  return new Promise<Taken>((resolve, reject) => {
    const parts = busboy({ headers: request.headers, limits: { files: 1, fileSize: what.shop.maxGcodeBytes } });
    let landed: Promise<string> | undefined;

    parts.on('file', (name, contents, info) => {
      if (name !== PLATE_PART) {
        contents.resume();
        return;
      }

      landed = pipeline(contents, createWriteStream(parked, { mode: 0o600 })).then(() => {
        if (contents.truncated) throw new TooMuchToTake(`a plate is at most ${what.shop.maxGcodeBytes} bytes, and this one is longer`);

        return info.filename;
      });
    });

    parts.on('error', reject);
    parts.on('close', () => {
      if (landed === undefined) {
        reject(new InvalidSubmission(`an upload needs a ${PLATE_PART} part, and this one had none`));
        return;
      }

      // AIDEV-NOTE: the parked plate goes BEFORE the promise settles, not after. `finally` waits for
      // what its callback returns, and this order is the difference between a spool directory that
      // is empty when the answer goes out and one that is empty shortly afterwards - which is a
      // shop that reports a job while still holding a second copy of it.
      landed
        .then(async (filename) => ({ job: await submitWhatArrived(what.shop, parked, filename, owner), filename }))
        .finally(() => rm(parked, { force: true }))
        .then(resolve, reject);
    });

    request.pipe(parts);
  });
}

// AIDEV-NOTE: what a slicer calls a file is not what a person calls a job. The default output name
// is a template - the model, and then the settings it was sliced with - which is exactly right on a
// disk full of variants and noise in a queue, where the printer and the filament are already columns
// of their own.
//
// The templated part is recognised by its NOZZLE or LAYER HEIGHT segment (`0.4n`, `0.2mm`), which is
// the part of that template no ordinary name has in it. Recognised, everything from the first
// underscore goes; not recognised, the name is left whole and its underscores become spaces, because
// a person who named a file `Player_Box` meant two words. Doing the first to every name would cut
// `Player_Box_v2` down to `Player`.
const SLICED_WITH = /^\d+(\.\d+)?(n|mm)$/;

/** What to call a job that arrived as a file, in the words a person would use for it. */
export function whatToCallIt(filename: string): string | undefined {
  const withoutSuffix = filename.replace(/\.gcode$/i, '');
  const [first, ...rest] = withoutSuffix.split('_');

  const named = rest.some((segment) => SLICED_WITH.test(segment)) ? (first ?? '') : withoutSuffix.replace(/_/g, ' ');

  // Nothing left to call it by - a file named `.gcode`, or `_0.4n_...` with no model in front of it.
  // Undefined rather than empty, so the shop names it the way it names anything else it was not told.
  return named.trim() === '' ? undefined : named.trim();
}

async function submitWhatArrived(shop: JobStore, parked: string, filename: string, owner: string): Promise<Job> {
  const plate = slicedPlate(await endsOf(parked));

  // AIDEV-NOTE: two refusals and not one, because they are two different things to have got wrong and
  // a person can act only on the one that is true. A plate the shop cannot READ may well say what it
  // needs, in a spelling nobody here has measured - telling somebody it named no filament would send
  // them hunting through their own settings for a fault that is this shop's.
  if (!plate.read) {
    const what = plate.generatedBy === undefined ? 'does not say what wrote it' : `says it was written by ${plate.generatedBy}`;

    throw new InvalidSubmission(
      `this plate ${what}, and the shop reads only what ${READS} writes - submit it through the shop's own route and say what it needs`,
    );
  }

  if (plate.filaments.length === 0) {
    throw new InvalidSubmission(
      "this plate names no filament, so the shop cannot know when it could ever run - submit it through the shop's own route and say what it needs",
    );
  }

  const details: JobDetails = {
    filaments: plate.filaments,
    displayName: whatToCallIt(filename),
    estimatedPrintSeconds: plate.estimatedPrintSeconds,
    requiredBuildVolume: plate.requiredBuildVolume,
  };

  // AIDEV-NOTE: judged here for the reason a description sent as JSON is judged where it is parsed -
  // this is the layer that turned somebody else's bytes into a description, so it answers for it
  // rather than handing the store something the store would have to doubt.
  validateDetails(details);

  return shop.submit(details, createReadStream(parked), owner);
}

// AIDEV-NOTE: both ends, because the same setting is written in a short block at the top by one tool
// and in a long one at the bottom by another, and a plate can be tens of megabytes of neither. What
// this cannot do is find a setting in the middle, which nothing is known to write.
export async function endsOf(plate: string): Promise<string> {
  const handle = await open(plate, 'r');

  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, Math.min(size, ENDS_BYTES));
    if (size <= ENDS_BYTES) return head;

    const from = Math.max(ENDS_BYTES, size - ENDS_BYTES);

    return `${head}\n${await readAt(handle, from, size - from)}`;
  } finally {
    await handle.close();
  }
}

async function readAt(handle: Awaited<ReturnType<typeof open>>, from: number, length: number): Promise<string> {
  const into = Buffer.alloc(length);
  await handle.read(into, 0, length, from);

  return into.toString('utf8');
}

/** A plate taken in: the job it became, and the name the caller sent it under. */
interface Taken {
  job: Job;
  filename: string;
}

// AIDEV-NOTE: built from what reached the shop rather than from a name it was configured with, for
// the reason every other absolute URL here is - the shop does not know its own name. The PREFIX has
// to be in them or a caller following one lands on the page instead of on this.
//
// The FILENAME and not the job's name. This half of the answer is the borrowed protocol describing
// the file a caller just sent, which is the name it sent it under; what the shop decided to call the
// job is a different fact and is in `job` below, where a caller that cares can see both.
function answerFor(request: Request, prefix: string, job: Job, filename: string): unknown {
  const at = `${request.protocol}://${request.get('host') ?? ''}${prefix}/api/files/local/${encodeURIComponent(filename)}`;

  return {
    done: true,
    files: {
      local: { name: filename, path: filename, origin: 'local', refs: { resource: at, download: at } },
    },
    // Said beside the answer a caller expects, because what actually happened is not what the shape
    // above can say: the plate is queued, and the shop starts it when something can.
    job: { id: job.id, displayName: job.displayName, state: job.state, filaments: job.filaments },
  };
}
