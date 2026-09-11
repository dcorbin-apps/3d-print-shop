import * as path from 'node:path';

// AIDEV-NOTE: three paths rather than one root, because the three things the shop keeps are three
// KINDS of thing and every system says so: work waiting to be done, state that outlives a restart,
// and a claim that must not. The store is handed all three and computes none of them, so the one
// place that knows a Linux from a Mac is `systemLayout` below - at the edge, called once, and
// testable without a filesystem.
/** Where a shop keeps each of the three things it has. */
export interface DataLayout {
  /** A directory per job: what was submitted, and the gcode. Work waiting to be done. */
  jobs: string;
  /** The printers, the id counter, the sessions - what has to still be there tomorrow. */
  state: string;
  /** The claim on all of it, held by the shop serving it. Meant not to survive a boot. */
  run: string;
}

// `3D_` is not a legal start for an environment variable, so the digit is dropped rather than
// spelled out.
export const DATA_ROOT_ENV = 'PRINT_SHOP_DATA';

// AIDEV-NOTE: the one branch, and it produces different SHAPES rather than one formula with a
// different prefix - which is the whole reason the store takes a layout. On Linux the three kinds
// have three homes and a sysadmin knows each of them; on macOS they have one, because that is what
// a Mac does with a system daemon's files and there is no /var/lib to put state in. The claim is
// under /var/run on both: it is the one directory that is meant to be emptied by a reboot, and both
// platforms have it.
const LINUX: DataLayout = {
  jobs: '/var/spool/3d-print-shop/jobs',
  state: '/var/lib/3d-print-shop',
  run: '/var/run/3d-print-shop',
};

const MACOS: DataLayout = {
  jobs: '/Library/Application Support/3d-print-shop/jobs',
  state: '/Library/Application Support/3d-print-shop/state',
  run: '/var/run/3d-print-shop',
};

/** Where this system keeps each kind, which is not the same question on every system. */
export function systemLayout(on: NodeJS.Platform = process.platform): DataLayout {
  return on === 'darwin' ? MACOS : LINUX;
}

// AIDEV-NOTE: everything under one directory, which is what somebody who names a place is asking
// for - a checkout, a Homebrew prefix, a test. The system layout is for an install that did not say;
// this is for one that did, and it keeps the three kinds apart inside the one place so that nothing
// about the store changes between them.
/** The three kinds, kept apart, inside one directory somebody named. */
export function layoutUnder(parent: string): DataLayout {
  return { jobs: path.join(parent, 'jobs'), state: path.join(parent, 'state'), run: path.join(parent, 'run') };
}

/**
 * What a shop uses when nobody says otherwise: this system's own layout, or one directory if the
 * environment names a place.
 */
export function defaultLayout(): DataLayout {
  const said = process.env[DATA_ROOT_ENV];

  return said === undefined || said.trim() === '' ? systemLayout() : layoutUnder(said);
}
