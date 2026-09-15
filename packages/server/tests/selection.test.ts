import { describe, it, expect } from '@jest/globals';
import { nextToPrint, printableNow, waitingOn } from '../src/selection';
import type { Job } from '../src/Job';
import type { RegisteredPrinter } from '../src/Printer';

// AIDEV-NOTE: plain objects, no store and no directory. Deciding what to print next is arithmetic
// over what is held, not something that touches disk - which is why it lives apart from JobStore.
describe('choosing what to print', () => {
  function job(id: number, filaments: string[], overrides: Partial<Job> = {}): Job {
    return {
      id,
      displayName: `Job ${id}`,
      filaments,
      submittedAt: new Date('2026-09-05T12:00:00Z'),
      state: 'queued',
      gcodeBytes: 1024,
      ...overrides,
    };
  }

  const ids = (jobs: Job[]): number[] => jobs.map((printable) => printable.id);

  function printer(loaded: string[], overrides: Partial<RegisteredPrinter> = {}): RegisteredPrinter {
    return { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4', loaded, ...overrides };
  }

  describe('printableNow', () => {
    it('offers a job whose filament is loaded', () => {
      expect(ids(printableNow([job(1, ['red'])], printer(['red'])))).toEqual([1]);
    });

    it('holds back a job whose filament is not', () => {
      expect(printableNow([job(1, ['red'])], printer(['blue']))).toEqual([]);
    });

    // AIDEV-NOTE: every printer here has ONE extruder, so what a job waits for is the filament it
    // STARTS with. It may name more - a single head sliced for several virtual extruders swaps the
    // rest in as it runs - and those are carried without being scheduled on.
    it('offers a job whose first filament is loaded, whatever else it names', () => {
      expect(ids(printableNow([job(1, ['red', 'blue'])], printer(['red'])))).toEqual([1]);
    });

    it('holds back a job whose first filament is not loaded, though a later one is', () => {
      expect(printableNow([job(1, ['red', 'blue'])], printer(['blue']))).toEqual([]);
    });

    it('is not troubled by filaments loaded that nothing needs', () => {
      expect(ids(printableNow([job(1, ['red'])], printer(['red', 'blue', 'white'])))).toEqual([1]);
    });

    // Ids are submission order, and nothing here knows enough to be cleverer.
    it('offers them in the order they were submitted, whatever order they are held in', () => {
      const held = [job(3, ['red']), job(1, ['red']), job(2, ['red'])];

      expect(ids(printableNow(held, printer(['red'])))).toEqual([1, 2, 3]);
    });

    it.each<[Job['state']]>([['printing'], ['awaiting-approval']])('does not offer a job that is already %s', (state) => {
      expect(printableNow([job(1, ['red'], { state })], printer(['red']))).toEqual([]);
    });

    // AIDEV-NOTE: axis for axis, no rotation. Gcode carries absolute coordinates, so turning a job
    // to make it fit would mean slicing it again - which the shop cannot do.
    it('holds back a job that will not fit the bed', () => {
      const tall = job(1, ['red'], { requiredBuildVolume: { x: 100, y: 100, z: 400 } });

      expect(printableNow([tall], printer(['red']))).toEqual([]);
    });

    it('holds back a job that would fit only if it were turned', () => {
      const sideways = job(1, ['red'], { requiredBuildVolume: { x: 210, y: 250, z: 100 } });

      expect(printableNow([sideways], printer(['red']))).toEqual([]);
    });

    // Two printers, because one would be satisfied by ignoring the volume altogether.
    it('offers a big job to the machine with room and not to the one without', () => {
      const big = job(1, ['red'], { requiredBuildVolume: { x: 240, y: 200, z: 100 } });

      expect(ids(printableNow([big], printer(['red'])))).toEqual([1]);
      expect(printableNow([big], printer(['red'], { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 } }))).toEqual([]);
    });

    it('offers a job that asked for no particular room to anything', () => {
      expect(ids(printableNow([job(1, ['red'])], printer(['red'], { name: 'mini', buildVolume: { x: 180, y: 180, z: 180 } })))).toEqual([1]);
    });

    it('offers nothing when nothing is loaded', () => {
      expect(printableNow([job(1, ['red']), job(2, ['blue'])], printer([]))).toEqual([]);
    });

    describe('with more than one printer', () => {
      const held = [job(1, ['red']), job(2, ['red'], { printer: 'mk4' }), job(3, ['red'], { printer: 'mini' })];

      it('offers a printer its own jobs and the ones claimed by nobody', () => {
        expect(ids(printableNow(held, printer(['red'], { name: 'mk4' })))).toEqual([1, 2]);
      });

      // Two printers, because one would be satisfied by ignoring the name altogether.
      it('offers a different printer a different set', () => {
        expect(ids(printableNow(held, printer(['red'], { name: 'mini' })))).toEqual([1, 3]);
      });

      // A printer with no claim on it takes only what nobody has claimed.
      it('offers a third printer only the unclaimed jobs', () => {
        expect(ids(printableNow(held, printer(['red'], { name: 'xl' })))).toEqual([1]);
      });
    });
  });

  describe('nextToPrint', () => {
    it('takes the first of what could be printed', () => {
      expect(nextToPrint([job(2, ['red']), job(1, ['red'])], printer(['red']))?.id).toBe(1);
    });

    it('answers with nothing when what is loaded cannot print anything', () => {
      expect(nextToPrint([job(1, ['red'])], printer(['blue']))).toBeUndefined();
    });
  });

  describe('waitingOn', () => {
    it('counts what is waiting for each filament', () => {
      const held = [job(1, ['red']), job(2, ['red']), job(3, ['blue'])];

      expect(waitingOn(held)).toEqual([
        { filament: 'red', jobs: 2 },
        { filament: 'blue', jobs: 1 },
      ]);
    });

    // The operator is deciding what to load, so the most work first.
    it('puts the busiest filament first however the jobs are held', () => {
      const held = [job(1, ['blue']), job(2, ['red']), job(3, ['red']), job(4, ['red'])];

      expect(waitingOn(held)[0]).toEqual({ filament: 'red', jobs: 3 });
    });

    // Otherwise the answer wanders between asks for no reason.
    it('breaks a tie alphabetically', () => {
      expect(waitingOn([job(1, ['red']), job(2, ['blue'])])).toEqual([
        { filament: 'blue', jobs: 1 },
        { filament: 'red', jobs: 1 },
      ]);
    });

    // What an operator has to load is the one it starts with; the rest are the printer's problem
    // once it is running.
    it('counts a job by the filament it starts with', () => {
      expect(waitingOn([job(1, ['red', 'blue']), job(2, ['red'])])).toEqual([{ filament: 'red', jobs: 2 }]);
    });

    // Work already under way is not work waiting to start.
    it('counts only what is queued', () => {
      const held = [job(1, ['red'], { state: 'printing' }), job(2, ['red'], { state: 'awaiting-approval' })];

      expect(waitingOn(held)).toEqual([]);
    });

    it('answers with nothing for an empty shop', () => {
      expect(waitingOn([])).toEqual([]);
    });

    // AIDEV-NOTE: what an operator decides by is how much WORK is waiting, not how many jobs are -
    // four quick ones should not send them for a spool ahead of one long one. What keeps that
    // honest is that a total is all-or-nothing: see workIn().
    describe('how much work is waiting', () => {
      const timed = (id: number, filament: string, seconds: number): Job => job(id, [filament], { estimatedPrintSeconds: seconds });

      it('totals what every job waiting on a filament says it takes', () => {
        expect(waitingOn([timed(1, 'red', 3600), timed(2, 'red', 1800)])).toEqual([{ filament: 'red', jobs: 2, estimatedPrintSeconds: 5400 }]);
      });

      it('says nothing of the total when one of them did not say', () => {
        expect(waitingOn([timed(1, 'red', 3600), job(2, ['red'])])).toEqual([{ filament: 'red', jobs: 2 }]);
      });

      it('puts the most work first, though it is the fewest jobs', () => {
        const held = [timed(1, 'red', 36_000), timed(2, 'blue', 600), timed(3, 'blue', 600)];

        expect(waitingOn(held).map((demand) => demand.filament)).toEqual(['red', 'blue']);
      });

      // One job that said how long it takes must not outrank several that did not - which is what
      // ranking a half-known answer by work would do.
      it('goes back to counting jobs when any filament has no total', () => {
        const held = [timed(1, 'red', 36_000), job(2, ['blue']), job(3, ['blue'])];

        expect(waitingOn(held).map((demand) => demand.filament)).toEqual(['blue', 'red']);
      });
    });

    // AIDEV-NOTE: the question is asked AT a machine - "what do I load next" - and a job that
    // machine could never take is not work it is waiting on. printableNow has always filtered on
    // this and counting demand did not, so an operator at the mini could be sent for a filament
    // only the XL had a use for.
    describe('at one machine rather than for the shop', () => {
      const held = [
        job(1, ['red']),
        job(2, ['blue'], { printer: 'xl' }),
        job(3, ['green'], { requiredBuildVolume: { x: 400, y: 400, z: 400 } }),
      ];

      it('counts only what the named printer could take', () => {
        expect(waitingOn(held, printer([]))).toEqual([{ filament: 'red', jobs: 1 }]);
      });

      // Two machines, because one would be satisfied by dropping every job with a condition on it.
      it('counts a different set at a different machine', () => {
        expect(waitingOn(held, printer([], { name: 'xl', buildVolume: { x: 400, y: 400, z: 400 } }))).toEqual([
          { filament: 'blue', jobs: 1 },
          { filament: 'green', jobs: 1 },
          { filament: 'red', jobs: 1 },
        ]);
      });

      it('counts the whole queue when no machine is named', () => {
        expect(waitingOn(held).map((demand) => demand.filament)).toEqual(['blue', 'green', 'red']);
      });

      // What is loaded is the very thing being asked about, so it cannot be a reason to leave
      // something out - the answer includes the filament already on the machine.
      it('counts what the machine is already loaded with', () => {
        expect(waitingOn([job(1, ['red'])], printer(['red']))).toEqual([{ filament: 'red', jobs: 1 }]);
      });
    });
  });

  // AIDEV-NOTE: (UT) a held job is queued in every other respect - nothing holds it, its gcode is
  // where it was - and the ONLY thing different about it is that the shop was told to leave it. So
  // this is the one place that has to know, and it is what a pause in the queue actually means.
  describe('a job somebody held back', () => {
    const held = { heldBack: new Date('2026-09-15T12:00:00Z') };

    it('is not offered, even with its filament loaded and a printer free', () => {
      expect(ids(printableNow([job(1, ['PLA-Red'], held)], printer(['PLA-Red'])))).toEqual([]);
    });

    it('does not keep the jobs behind it waiting', () => {
      const jobs = [job(1, ['PLA-Red'], held), job(2, ['PLA-Red'])];

      expect(ids(printableNow(jobs, printer(['PLA-Red'])))).toEqual([2]);
    });

    it('is offered again once it is let through', () => {
      expect(ids(printableNow([job(1, ['PLA-Red'])], printer(['PLA-Red'])))).toEqual([1]);
    });
  });
});
