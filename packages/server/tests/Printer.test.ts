import { describe, it, expect } from '@jest/globals';
import { canTake, expectedDone, fitsInside, whereToWatch } from '../src/Printer';
import type { JobRecord } from '../src/Job';
import type { Holding, PrinterRecord } from '../src/Printer';

const MK4: PrinterRecord = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, address: 'http://octopi.local', api: 'octoprint' };

const aJob = (job: Partial<JobRecord> = {}): JobRecord => ({
  id: 1,
  filaments: ['PLA-Red'],
  displayName: 'Player Box',
  submittedAt: new Date('2026-09-12T09:00:00Z'),
  gcodeBytes: 100,
  ...job,
});

// AIDEV-NOTE: axis for axis, and no rotation. Gcode carries absolute coordinates, so a job needing
// 210x250 does not fit a 250x210 bed by being turned - turning it would mean slicing it again, and
// the shop has no slicer and no business having one.
describe('whether a job fits a bed', () => {
  it('fits when every side has room', () => {
    expect(fitsInside({ x: 100, y: 100, z: 100 }, MK4.buildVolume)).toBe(true);
  });

  it('fits when it is exactly the bed', () => {
    expect(fitsInside({ x: 250, y: 210, z: 220 }, MK4.buildVolume)).toBe(true);
  });

  it.each([
    ['x', { x: 251, y: 210, z: 220 }],
    ['y', { x: 250, y: 211, z: 220 }],
    ['z', { x: 250, y: 210, z: 221 }],
  ])('does not fit when %s is over by a millimetre', (_axis, required) => {
    expect(fitsInside(required, MK4.buildVolume)).toBe(false);
  });

  // The one that would be wrong if this rotated: 210x250 is the bed's own numbers the other way up.
  it('does not fit a job that would only fit if it were turned', () => {
    expect(fitsInside({ x: 210, y: 250, z: 100 }, MK4.buildVolume)).toBe(false);
  });

  // A client that did not say how big it is gets the benefit of the doubt: the shop does not read
  // gcode, so it has no other way to know.
  it('fits anything when the job did not say how big it is', () => {
    expect(fitsInside(undefined, MK4.buildVolume)).toBe(true);
  });
});

describe('whether a printer could take a job at all', () => {
  it('could take one that names no printer and fits', () => {
    expect(canTake(MK4, aJob())).toBe(true);
  });

  it('could take one that names this printer', () => {
    expect(canTake(MK4, aJob({ printer: 'mk4' }))).toBe(true);
  });

  it('could not take one that names a different printer, however well it fits', () => {
    expect(canTake(MK4, aJob({ printer: 'mini' }))).toBe(false);
  });

  it('could not take one that needs a bigger bed', () => {
    expect(canTake(MK4, aJob({ requiredBuildVolume: { x: 400, y: 400, z: 400 } }))).toBe(false);
  });

  // Both have to hold: naming the machine does not make it bigger.
  it('could not take one that names this printer and still does not fit', () => {
    expect(canTake(MK4, aJob({ printer: 'mk4', requiredBuildVolume: { x: 400, y: 400, z: 400 } }))).toBe(false);
  });

  // What is LOADED is a different question, decided in selection.ts - this one is about the machine.
  it('says nothing about what is loaded on the machine', () => {
    expect(canTake(MK4, aJob({ filaments: ['a filament nobody has'] }))).toBe(true);
  });
});

// AIDEV-NOTE: the ADAPTER's knowledge rather than the shop's - where a camera lives is part of what a
// protocol says, so it is answered per api rather than configured per machine. Nothing fetches it.
describe('where a person can watch a machine', () => {
  it('is the camera the protocol says, off the address the shop already talks to it at', () => {
    expect(whereToWatch(MK4)).toBe('http://octopi.local/webcam/?action=stream');
  });

  it('does not double the separator when the address was given with a trailing slash', () => {
    expect(whereToWatch({ ...MK4, address: 'http://octopi.local/' })).toBe('http://octopi.local/webcam/?action=stream');
  });
});

// (UT) A pause the machine took is time the print did not move, so it pushes the end out by as long.
describe('when a print should be done', () => {
  const STARTED = new Date('2026-09-12T09:00:00Z');
  const NOW = new Date('2026-09-12T10:00:00Z');
  const HOUR = 3600;

  const printing = (holding: Partial<Holding> = {}): Holding => ({ job: 1, phase: 'printing', printingSince: STARTED, ...holding });

  it('is its start and its estimate', () => {
    expect(expectedDone(printing(), 2 * HOUR, NOW)).toEqual(new Date('2026-09-12T11:00:00Z'));
  });

  it('is later by every pause that has ended', () => {
    expect(expectedDone(printing({ pausedSeconds: 900 }), 2 * HOUR, NOW)).toEqual(new Date('2026-09-12T11:15:00Z'));
  });

  it('is later by as long as the pause still going has lasted', () => {
    const pausedAtHalfPast = printing({ pausedSeconds: 900, machinePausedSince: new Date('2026-09-12T09:30:00Z') });

    expect(expectedDone(pausedAtHalfPast, 2 * HOUR, NOW)).toEqual(new Date('2026-09-12T11:45:00Z'));
  });

  it.each([
    ['nobody said how long it takes', printing(), undefined],
    ['the shop never learned when it started', printing({ printingSince: undefined }), 2 * HOUR],
    ['it has stopped printing', printing({ phase: 'awaiting-approval', outcome: 'finished' }), 2 * HOUR],
  ])('is not known when %s', (_why, holding, estimate) => {
    expect(expectedDone(holding, estimate, NOW)).toBeUndefined();
  });
});
