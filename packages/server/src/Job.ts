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
  if (details.filaments.length === 0) {
    throw new InvalidSubmission('a job must say which filaments it needs');
  }

  if (details.filaments.some((filament) => filament.trim() === '')) {
    throw new InvalidSubmission('a job cannot need a filament with no name');
  }

  if (details.estimatedPrintSeconds !== undefined) validateEstimate(details.estimatedPrintSeconds);
  if (details.remotePath !== undefined) validateRemotePath(details.remotePath);
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
// ones - brackets, parentheses, '#', '&', an apostrophe are all legal on the printer and stay legal
// here. See docs.octoprint.org/en/master/api/files.html and octoprint.filemanager.storage:
// sanitize_name() raises on '/' and '\\' and strips a leading '.', and sanitize_filename() defers to
// pathvalidate, which removes what is illegal on any OS.
//
// AIDEV-TODO: confirm against a real OctoPrint when one is reachable - the API docs show a filename
// transliterated on upload ('20mm-ümläut-böx' stored as '20mm-umlaut-box') without saying what does
// it, so a non-ASCII name may still be rewritten. See PLAN.md.
const ILLEGAL_ON_SOME_FILESYSTEM = /[:*?"<>|\\]/;

// By code point rather than by regex, because a control character written into one is the mistake
// `no-control-regex` exists to catch and this file would be the only place suppressing it.
function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function validateRemotePath(remotePath: string): void {
  const refuse = (why: string): never => {
    throw new InvalidSubmission(`${JSON.stringify(remotePath)} is not a path this shop will ask a printer for: ${why}`);
  };

  if (remotePath === '') refuse('it is empty');
  if (remotePath.length > MAX_REMOTE_PATH) refuse(`it is longer than ${MAX_REMOTE_PATH} characters`);
  if (remotePath.startsWith('/')) refuse('it starts at the root of the printer rather than inside its uploads');
  if (ILLEGAL_ON_SOME_FILESYSTEM.test(remotePath) || hasControlCharacter(remotePath)) {
    refuse('a printer would not store it under this name');
  }

  for (const segment of remotePath.split('/')) {
    if (segment === '') refuse('it has an empty folder or file name in it');
    if (segment === '.' || segment === '..') refuse('it names a folder relative to another one');
    if (segment.startsWith('.')) refuse('a printer strips a leading dot, so the name would not be the one stored');
    if (segment !== segment.trim()) refuse('a name padded with spaces is not the name it would be stored under');
    if (segment.endsWith('.')) refuse('a name ending in a dot is not the name it would be stored under');
  }
}
