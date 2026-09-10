import { describe, it, expect } from '@jest/globals';
import type { Job, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { stateOf, summarise } from '../src/shopSummary';

describe('what the shop is doing', () => {
  function printer(overrides: Partial<RegisteredPrinter> = {}): RegisteredPrinter {
    return {
      name: 'mk4',
      buildVolume: { x: 250, y: 210, z: 220 },
      api: 'octoprint',
      address: 'http://mk4',
      loaded: [],
      ...overrides,
    };
  }

  function job(overrides: Partial<Job> = {}): Job {
    return {
      id: 1,
      displayName: 'Player Box',
      filaments: ['PLA-Red'],
      submittedAt: new Date('2026-09-09T12:00:00Z'),
      gcodeBytes: 1024,
      state: 'queued',
      ...overrides,
    };
  }

  const trouble = { reason: 'the door is open', since: new Date('2026-09-09T11:00:00Z') };

  describe('a machine, in one word', () => {
    it('is idle when nothing is wrong and nothing is on the bed', () => {
      expect(stateOf(printer())).toEqual({ condition: 'idle' });
    });

    it('is printing when it is holding a print', () => {
      expect(stateOf(printer({ holding: { job: 1, phase: 'printing' } }))).toEqual({ condition: 'printing' });
    });

    it.each<[keyof RegisteredPrinter, string]>([
      ['paused', 'stopped'],
      ['refused', 'refused'],
      ['unreachable', 'unreachable'],
      ['outOfContact', 'out-of-contact'],
    ])('reads %s as %s, and says why', (field, condition) => {
      expect(stateOf(printer({ [field]: trouble }))).toEqual({ condition, why: 'the door is open' });
    });

    // AIDEV-NOTE: the order matters and is not the order the fields are declared in. A person said
    // something about the room, and no machine can contradict that - so a stopped printer holding a
    // print reads as stopped rather than as printing.
    it('is stopped rather than printing when an operator stopped it mid-print', () => {
      expect(stateOf(printer({ paused: trouble, holding: { job: 1, phase: 'printing' } })).condition).toBe('stopped');
    });

    // The bed is what is actually held, and clearing it is the thing a person can do about it -
    // where a machine nobody can reach is the shop's own problem and it is already trying again.
    it('is waiting for a verdict rather than unreachable when a print is on the bed', () => {
      const waiting = printer({ unreachable: trouble, holding: { job: 1, phase: 'awaiting-approval' } });

      expect(stateOf(waiting).condition).toBe('awaiting-approval');
    });
  });

  describe('the whole shop, counted', () => {
    it('counts nothing for a shop with nothing', () => {
      expect(summarise([], [])).toEqual({ printers: 0, printing: 0, needingSomebody: 0, queued: 0, awaitingApproval: 0 });
    });

    it('counts the machines and the ones actually printing', () => {
      const printers = [printer({ holding: { job: 1, phase: 'printing' } }), printer({ name: 'mini' })];

      expect(summarise(printers, [])).toMatchObject({ printers: 2, printing: 1 });
    });

    // The number an operator is looking for: what will not move until somebody does something.
    it.each<[string, Partial<RegisteredPrinter>]>([
      ['an operator stopped', { paused: trouble }],
      ['the machine would not take a file', { refused: trouble }],
      ['a print is waiting for a verdict', { holding: { job: 1, phase: 'awaiting-approval' } }],
    ])('counts a machine %s as needing somebody', (_why, state) => {
      expect(summarise([printer(state)], []).needingSomebody).toBe(1);
    });

    // Nobody makes a machine answer sooner by standing at it, and the shop is already listening.
    it.each<[string, Partial<RegisteredPrinter>]>([
      ['out of reach', { unreachable: trouble }],
      ['out of contact', { outOfContact: trouble }],
    ])('does not count a machine %s as needing somebody', (_why, state) => {
      expect(summarise([printer(state)], []).needingSomebody).toBe(0);
    });

    it('counts the work by where it has got to', () => {
      const jobs = [job(), job({ id: 2 }), job({ id: 3, state: 'printing' }), job({ id: 4, state: 'awaiting-approval' })];

      expect(summarise([], jobs)).toMatchObject({ queued: 2, awaitingApproval: 1 });
    });
  });
});
