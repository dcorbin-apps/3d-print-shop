import type { BuildVolume, JobRecord } from './Job.js';
import { octoPrintCamera } from './OctoPrint.js';
import type { PrinterRecord } from '@3d-print-shop/client';

// The wire contract, so the shop and everything that talks to it cannot drift apart.
export type { Holding, PrinterApi, PrinterRecord, PrinterStatus, RegisteredPrinter } from '@3d-print-shop/client';

// AIDEV-NOTE: axis for axis, and no rotation. Gcode carries absolute coordinates, so a job needing
// 210x250 does not fit a 250x210 bed by being turned - turning it would mean slicing it again, and
// the shop has no slicer and no business having one.
export function fitsInside(required: BuildVolume | undefined, volume: BuildVolume): boolean {
  if (!required) return true;

  return required.x <= volume.x && required.y <= volume.y && required.z <= volume.z;
}

// AIDEV-NOTE: the ADAPTER's knowledge, not the shop's - where a camera lives is part of what a
// protocol says, the way an upload path is, so it is answered per api rather than configured per
// machine. Nothing here fetches it: it is a URL handed to whoever is looking at the shop.
/** Where a person can watch this machine, if what it speaks says where that is. */
export function whereToWatch(printer: PrinterRecord): string | undefined {
  switch (printer.api) {
    case 'octoprint':
      return octoPrintCamera(printer.address);
  }
}

/** Whether this printer could take this job at all, leaving aside what is loaded and what it holds. */
export function canTake(printer: PrinterRecord, job: JobRecord): boolean {
  const claimed = job.printer === undefined || job.printer === printer.name;

  return claimed && fitsInside(job.requiredBuildVolume, printer.buildVolume);
}

