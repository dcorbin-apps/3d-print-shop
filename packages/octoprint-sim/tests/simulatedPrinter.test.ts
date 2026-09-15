import { describe, it, expect, beforeEach } from '@jest/globals';
import { Busy, SimulatedPrinter, parseAuthFrame } from '../src/simulatedPrinter';
import type { CompletionEventType } from '../src/simulatedPrinter';

// AIDEV-NOTE: what octo-sim REFUSES, which is the one thing its strictness exists for. If it quietly
// started accepting a bad auth frame or a second job while one was printing, every suite that drives
// a client at it would still pass and would simply have stopped proving anything - so these are the
// traps nothing else springs.
describe('the auth frame a push socket presents', () => {
  it('is a name and a session when it is the two parts OctoPrint wants', () => {
    expect(parseAuthFrame(JSON.stringify({ auth: 'operator:sess-7' }))).toEqual({ name: 'operator', session: 'sess-7' });
  });

  // AIDEV-NOTE: sockjs.py splits on ':' and requires EXACTLY two parts. Nothing tested this rule
  // until now: every refusal the acceptance suite checked was refused by some other rule first, so
  // taking the count check out was caught by nothing at all.
  it.each([['justone'], ['a:b:c'], [':has-no-name'], ['has-no-session:'], [':'], ['']])('is nobody for %j, which is not two parts', (auth) => {
    expect(parseAuthFrame(JSON.stringify({ auth }))).toBeUndefined();
  });

  it.each([[JSON.stringify({ subscribe: 'everything' })], [JSON.stringify({ auth: 7 })], [JSON.stringify({ auth: null })], ['{']])(
    'is nobody for %j, which is not an auth frame at all',
    (raw) => {
      expect(parseAuthFrame(raw)).toBeUndefined();
    },
  );
});

describe('the printer octo-sim pretends to be', () => {
  let printer: SimulatedPrinter;
  let issued: number;

  beforeEach(() => {
    issued = 0;
    printer = new SimulatedPrinter(
      () => 1_700_000_000_000,
      () => `sess-${++issued}`,
    );
  });

  const presenting = (auth: string): string => JSON.stringify({ auth });

  describe('who it lets listen', () => {
    it('lets in a session it issued, under the name it issued it to', () => {
      const { name, session } = printer.logIn();

      expect(printer.authenticates(presenting(`${name}:${session}`))).toBe(true);
    });

    it('issues a different session every time, so an old one is not the one in use', () => {
      expect(printer.logIn().session).not.toBe(printer.logIn().session);
    });

    // AIDEV-NOTE: the shape this codebase really sent until 2026-08-26. OctoPrint rejects it - the
    // second part must be a session from a login call, not the api key - and a simulator that waved
    // it through is what let the mistake stand for months without anything noticing.
    it('keeps out an api key presented in place of a session', () => {
      printer.logIn();

      expect(printer.authenticates(presenting('apikey:test-key'))).toBe(false);
    });

    it('keeps out a session it never issued', () => {
      printer.logIn();

      expect(printer.authenticates(presenting('operator:sess-invented'))).toBe(false);
    });

    // The session is real but the name is not the one it was issued to.
    it('keeps out a session presented under the wrong name', () => {
      const { session } = printer.logIn();

      expect(printer.authenticates(presenting(`somebody-else:${session}`))).toBe(false);
    });

    it.each([[JSON.stringify({ subscribe: 'everything' })], ['not json at all'], [JSON.stringify({ auth: 'a:b:c' })]])('keeps out %j', (raw) => {
      printer.logIn();

      expect(printer.authenticates(raw)).toBe(false);
    });
  });

  describe('the one job it can have on the bed', () => {
    it('is free to begin with', () => {
      expect(printer.busyWith()).toBeNull();
    });

    // The path the CLIENT asked for, which is what real OctoPrint files an upload under.
    it('is filed under the folder the client named', () => {
      expect(printer.take('tray.gcode', 'plates')).toBe('plates/tray.gcode');
    });

    it('is filed at the root when the client named no folder', () => {
      expect(printer.take('tray.gcode', '')).toBe('tray.gcode');
    });

    it('is what it says it is running', () => {
      printer.take('tray.gcode', 'plates');

      expect(printer.busyWith()).toBe('plates/tray.gcode');
    });

    // AIDEV-NOTE: a real printer runs one job at a time. Refused HERE rather than left to callers,
    // so a scheduling bug that submits out of turn gets a hard refusal instead of two jobs quietly
    // overlapping. Nothing that drives this submits two at once, so no other test springs the trap.
    it('takes no second job while the first is still printing', () => {
      printer.take('first.gcode', 'plates');

      expect(() => printer.take('second.gcode', 'plates')).toThrow(Busy);
    });

    it('says which job is in the way', () => {
      printer.take('first.gcode', 'plates');

      expect(() => printer.take('second.gcode', 'plates')).toThrow('Printer is busy: plates/first.gcode is still printing');
    });

    it('takes another once the first has ended', () => {
      printer.take('first.gcode', 'plates');
      printer.finished('plates/first.gcode', 'PrintDone');

      expect(printer.take('second.gcode', 'plates')).toBe('plates/second.gcode');
    });

    // A job handler that threw rather than completing must not wedge the printer for good.
    it('takes another once a job has been given up on', () => {
      printer.take('first.gcode', 'plates');
      printer.gaveUp();

      expect(printer.busyWith()).toBeNull();
    });
  });

  describe('what it remembers of a file', () => {
    it('knows nothing of one it never had', () => {
      expect(printer.filed('plates/never.gcode')).toBeUndefined();
    });

    // Real OctoPrint leaves `prints` out entirely for a file it has never printed.
    it('says nothing of the prints of one it has not printed yet', () => {
      printer.take('tray.gcode', 'plates');

      expect(printer.filed('plates/tray.gcode')).toEqual({ name: 'tray.gcode', path: 'plates/tray.gcode', type: 'machinecode' });
    });

    it('counts a print that finished', () => {
      printer.take('tray.gcode', 'plates');
      printer.finished('plates/tray.gcode', 'PrintDone');

      expect(printer.filed('plates/tray.gcode')?.prints).toMatchObject({ success: 1, failure: 0, last: { success: true } });
    });

    // AIDEV-NOTE: OctoPrint records a cancelled print as a FAILURE, not a third outcome - so does
    // this. A client reconciling after the fact genuinely cannot tell the two apart, and pretending
    // otherwise here would let a test pass that the real server would fail.
    it.each<[CompletionEventType]>([['PrintFailed'], ['PrintCancelled']])('counts %s as a failure, the way OctoPrint does', (type) => {
      printer.take('tray.gcode', 'plates');
      printer.finished('plates/tray.gcode', type);

      expect(printer.filed('plates/tray.gcode')?.prints).toMatchObject({ success: 0, failure: 1, last: { success: false } });
    });

    it('adds a second print of the same file to the first', () => {
      printer.take('tray.gcode', 'plates');
      printer.finished('plates/tray.gcode', 'PrintDone');
      printer.take('tray.gcode', 'plates');
      printer.finished('plates/tray.gcode', 'PrintFailed');

      expect(printer.filed('plates/tray.gcode')?.prints).toMatchObject({ success: 1, failure: 1 });
    });
  });

  describe('what it says about itself', () => {
    const flagsOf = (printing: SimulatedPrinter): { printing: boolean; ready: boolean } =>
      (printing.statusPayload() as { state: { flags: { printing: boolean; ready: boolean } } }).state.flags;
    const jobPathIn = (printing: SimulatedPrinter): string | null =>
      (printing.statusPayload() as { job: { file: { path: string | null } } }).job.file.path;

    it('is operational and ready with nothing on the bed', () => {
      expect(flagsOf(printer)).toMatchObject({ printing: false, ready: true });
    });

    it('is printing and not ready while a job runs', () => {
      printer.take('tray.gcode', 'plates');

      expect(flagsOf(printer)).toMatchObject({ printing: true, ready: false });
    });

    // AIDEV-NOTE: real OctoPrint goes on naming the last job after it ends - `state.flags` is the
    // only thing that says whether it is still running. Clearing this to null on completion made the
    // path harmless to ignore, which let a client reading the wrong field look correct here and fail
    // against a real printer.
    it('goes on naming the last job after it has ended', () => {
      printer.take('tray.gcode', 'plates');
      printer.finished('plates/tray.gcode', 'PrintDone');

      expect(jobPathIn(printer)).toBe('plates/tray.gcode');
      expect(flagsOf(printer).printing).toBe(false);
    });

    it('names no job at all before it has had one', () => {
      expect(jobPathIn(printer)).toBeNull();
    });
  });
});
