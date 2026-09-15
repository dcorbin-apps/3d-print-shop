import type { Job, JobDetails } from '@3d-print-shop/client';

// AIDEV-NOTE: the wire contract lives in @3d-print-shop/client, so the shop and everything that
// talks to it cannot drift apart. What stays here is what only the shop needs: the record it
// writes, and what it refuses on the way in.
export type { BuildVolume, Job, JobDetails, JobPhase, JobState, PrinterOutcome } from '@3d-print-shop/client';

// AIDEV-NOTE: written once, at submission, and never written again - the job leaves the shop rather
// than being updated. Everything that CHANGES while a job is in the shop belongs to the printer
// holding it, because a printer is the only thing whose state actually moves. See
// design/3d-print-shop.md's "What changes, and what does not".
export type JobRecord = Omit<Job, 'state' | 'heldBy' | 'lastPrinterOutcome'>;

// AIDEV-NOTE: submission order, and only used when a client offers no name of its own. It is
// deliberately not derived from anything about the job: a name built from the filament or the file
// would read as though the queue understood the content, and it does not.
export function generatedDisplayName(ordinal: number): string {
  return `Job ${ordinal}`;
}

export class InvalidSubmission extends Error {}

// AIDEV-NOTE: checked before a byte is read, because everything downstream assumes it and because
// refusing early is refusing cheaply - a job that cannot be scheduled should not cost an upload
// first. That a job actually HAS gcode cannot be known here: the stream has not run yet, so
// emptiness is caught by the store once it has.
export function validateDetails(details: JobDetails): void {
  validateFilaments(details.filaments);

  if (details.displayName !== undefined) validateDisplayName(details.displayName);
  if (details.estimatedPrintSeconds !== undefined) validateEstimate(details.estimatedPrintSeconds);
  if (details.remotePath !== undefined) validateRemotePath(details.remotePath);
  if (details.metadata !== undefined) validateMetadata(details.metadata);
}

// AIDEV-NOTE: two numbers, because a name and a value are not the same kind of thing. A name is a
// label and 255 is generous for one; a value is the client's own payload, and a client with
// structure of its own encodes it into one - a list of a dozen things is ordinary and does not fit
// in 255. Neither bounds what a submission COSTS: the description as a whole is capped where it is
// read, and both of these are a fraction of it.
const MAX_METADATA_NAME = 255;
const MAX_METADATA_VALUE = 4096;

// AIDEV-NOTE: the one field the shop carries without ever reading, so what it takes is what it can
// hand back unchanged - names against text. An object was always what the type said and a string was
// always what it took, `"hi"` included. A client with structure of its own encodes it into a value
// and decodes it again; the shop having no opinion about the content is not the same as having none
// about the shape.
function validateMetadata(metadata: unknown): void {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new InvalidSubmission(`${JSON.stringify(metadata)} is not metadata - metadata is names against text`);
  }

  for (const [name, value] of Object.entries(metadata)) {
    // The name's length first, so everything below may say which name it was without quoting a
    // kilobyte of one back at the client.
    if (name.length > MAX_METADATA_NAME) {
      throw new InvalidSubmission(`a metadata name is at most ${MAX_METADATA_NAME} characters, and one here is ${name.length}`);
    }

    if (typeof value !== 'string') {
      throw new InvalidSubmission(`metadata ${JSON.stringify(name)} is ${JSON.stringify(value)}, and metadata is text - encode what is not`);
    }

    if (value.length > MAX_METADATA_VALUE) {
      throw new InvalidSubmission(
        `metadata ${JSON.stringify(name)} is ${value.length} characters, and a metadata value is at most ${MAX_METADATA_VALUE}`,
      );
    }
  }
}

// AIDEV-NOTE: `unknown` for the reason `validateEstimate` is - `JobDetails` says what a client
// SHOULD have sent, and what arrives is whatever JSON.parse made of what it did send. Reading
// `.length` off that was a TypeError for `{}` and `.some` for `"PLA"`, which is the shop answering
// 500 and calling a client's mistake its own fault.
function validateFilaments(filaments: unknown): void {
  if (!Array.isArray(filaments) || filaments.some((filament) => typeof filament !== 'string')) {
    throw new InvalidSubmission(
      `${JSON.stringify(filaments)} is not what a job needs - filaments are a list of names, in the printer's words for them`,
    );
  }

  if (filaments.length === 0) {
    throw new InvalidSubmission('a job must say which filaments it needs');
  }

  if (filaments.some((filament: string) => filament.trim() === '')) {
    throw new InvalidSubmission('a job cannot need a filament with no name');
  }
}

// The longest name a job may be given. Not a storage limit - the name goes in the record, which has
// no such bound - but a limit on what a person is asked to read: a job list is a column, and a name
// longer than this is not a name any more.
const MAX_DISPLAY_NAME = 255;

// AIDEV-NOTE: `unknown` for the reason the two below are. Nothing in the shop calls a string method
// on a display name - it is interpolated into the operator's list, logged, and rendered - so what a
// non-string breaks is whatever is READING it, which is the one place the shop cannot answer for.
// Counted in UTF-16 units, as `MAX_REMOTE_PATH` is, so an emoji in a name costs two.
function validateDisplayName(displayName: unknown): void {
  if (typeof displayName !== 'string') {
    throw new InvalidSubmission(`${JSON.stringify(displayName)} is not a name for a job - a name is text`);
  }

  // The length is said rather than the name, which by here is at least 256 characters of it.
  if (displayName.length > MAX_DISPLAY_NAME) {
    throw new InvalidSubmission(`a job's name is at most ${MAX_DISPLAY_NAME} characters, and this one is ${displayName.length}`);
  }
}

// AIDEV-NOTE: a number the shop ADDS UP, so what is refused is what arithmetic would not survive -
// anything that is not a number, a NaN, an infinity - and a print that takes no time at all, which
// is a client that meant to say nothing. Taken as `unknown` because it arrives from JSON.parse and
// the type it was cast to on the way in proves nothing about what was sent.
//
// Nothing here has an opinion about how LONG is too long: a plate that runs for two days is a plate.
function validateEstimate(seconds: unknown): void {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return;

  // A number says itself, because JSON.stringify writes both NaN and Infinity as `null`.
  const said = typeof seconds === 'number' ? String(seconds) : JSON.stringify(seconds);

  throw new InvalidSubmission(`${said} is not how long a print takes - it is a number of seconds, above zero`);
}

// The longest name a single path component may have on every filesystem this could land on. Applied
// to the whole path, which bounds how deep it can nest without a separate rule about depth.
const MAX_REMOTE_PATH = 255;

// AIDEV-NOTE: what OctoPrint would REWRITE, refused rather than accepted and quietly changed. This
// is not only a path-traversal guard: the stored path is what a print's completion event is matched
// against, so a name the printer alters is a print whose outcome never arrives and a bed held for
// ever. Refusing here keeps "what the shop accepted" and "what the printer stored" the same string.
//
// Deliberately a blocklist. A client names its own files and an allowlist would refuse ordinary
// ones - brackets, parentheses, '#', an apostrophe, a space are all kept by the printer and stay
// legal here. See docs.octoprint.org/en/master/api/files.html and octoprint.filemanager.storage:
// sanitize_name() raises on '/' and '\\' and strips a leading '.', and sanitize_filename() defers to
// pathvalidate, which removes what is illegal on any OS.
const ILLEGAL_ON_SOME_FILESYSTEM = /[:*?"<>|\\]/;

// AIDEV-NOTE: MEASURED, against OctoPrint 1.11.8 on a real machine, one character at a time in an
// otherwise boring name. These three are taken out silently - `a&b.gcode` is stored as `ab.gcode` -
// and a name the printer alters is a print whose completion event matches nothing and a bed held for
// ever. Every other character this shop allows came back verbatim.
//
// The same run settled what the API docs had left open: a NON-ASCII name is not transliterated.
// `20mm-ümläut-böx.gcode`, `ärger-straße.gcode` and a name with an emoji in it were each stored
// exactly as given, so the docs' example does not describe this version and there is no rule here
// for it. If that ever changes, this is the comment it changes under.
const REMOVED_BY_A_PRINTER = /[&;$]/;

// By code point rather than by regex, because a control character written into one is the mistake
// `no-control-regex` exists to catch and this file would be the only place suppressing it.
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function validateRemotePath(remotePath: unknown): void {
  // Ahead of `refuse`, and thrown rather than routed through it, because everything below reads this
  // as a string - `.startsWith` on a number was the same 500 the filaments were.
  if (typeof remotePath !== 'string') {
    throw new InvalidSubmission(`${JSON.stringify(remotePath)} is not a path this shop will ask a printer for: it is not text`);
  }

  const refuse = (why: string): never => {
    throw new InvalidSubmission(`${JSON.stringify(remotePath)} is not a path this shop will ask a printer for: ${why}`);
  };

  if (remotePath === '') refuse('it is empty');
  if (remotePath.length > MAX_REMOTE_PATH) refuse(`it is longer than ${MAX_REMOTE_PATH} characters`);
  if (remotePath.startsWith('/')) refuse('it starts at the root of the printer rather than inside its uploads');
  if (ILLEGAL_ON_SOME_FILESYSTEM.test(remotePath) || hasControlCharacter(remotePath)) {
    refuse('a printer would not store it under this name');
  }
  if (REMOVED_BY_A_PRINTER.test(remotePath)) refuse('a printer takes "&", ";" and "$" out of a name, so it would be stored under another');

  for (const segment of remotePath.split('/')) {
    if (segment === '') refuse('it has an empty folder or file name in it');
    if (segment === '.' || segment === '..') refuse('it names a folder relative to another one');
    if (segment.startsWith('.')) refuse('a printer strips a leading dot, so the name would not be the one stored');
    if (segment !== segment.trim()) refuse('a name padded with spaces is not the name it would be stored under');
    if (segment.endsWith('.')) refuse('a name ending in a dot is not the name it would be stored under');
  }
}
