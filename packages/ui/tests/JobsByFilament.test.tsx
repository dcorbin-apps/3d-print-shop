import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Job, RegisteredPrinter, Verdict } from '@3d-print-shop/client/browser';
import { JobsByFilament } from '../src/components/JobsByFilament';

describe('the work the shop is holding', () => {
  afterEach(cleanup);

  function job(id: number, filaments: string[], overrides: Partial<Job> = {}): Job {
    return {
      id,
      displayName: `Job ${id}`,
      filaments,
      submittedAt: new Date('2026-09-09T12:00:00Z'),
      gcodeBytes: 1024,
      state: 'queued',
      ...overrides,
    };
  }

  const mk4: RegisteredPrinter = {
    name: 'mk4',
    buildVolume: { x: 250, y: 210, z: 220 },
    api: 'octoprint',
    address: 'http://mk4',
    loaded: ['PLA-Red'],
  };

  const judged = jest.fn<(id: number, verdict: Verdict) => Promise<void>>();

  const showing = (jobs: Job[], totalJobs = jobs.length, selected?: RegisteredPrinter): void => {
    render(<JobsByFilament jobs={jobs} totalJobs={totalJobs} selected={selected} />);
  };

  const judging = (jobs: Job[]): void => {
    judged.mockReset();
    judged.mockResolvedValue(undefined);
    render(<JobsByFilament jobs={jobs} totalJobs={jobs.length} onVerdict={judged} />);
  };

  const printed = (id: number): Job => job(id, ['PLA-Red'], { state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'finished' });

  it('says so when there is nothing outstanding', () => {
    showing([]);

    expect(screen.getByText('Nothing outstanding.')).toBeDefined();
  });

  it('gives every job a heading of the filament it waits on', () => {
    showing([job(1, ['PLA-Red']), job(2, ['PLA-Blue'])]);

    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['PLA-Blue', 'PLA-Red']);
  });

  it('shows a picture of every job', () => {
    showing([job(1, ['PLA-Red']), job(2, ['PLA-Blue'])]);

    expect(screen.getByRole('button', { name: 'Show Job 1 larger' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show Job 2 larger' })).toBeDefined();
  });

  it('shows each job by name, and where it has got to', () => {
    showing([job(1, ['PLA-Red'], { displayName: 'Player Box', state: 'printing', heldBy: 'mk4' })]);

    expect(screen.getByText('Player Box')).toBeDefined();
    expect(screen.getByText('printing on mk4')).toBeDefined();
  });

  describe('a job that is printing', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-09-09T13:00:00Z') });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('says how long until it should be done', () => {
      showing([job(1, ['PLA-Red'], { state: 'printing', heldBy: 'mk4', expectedDone: new Date('2026-09-09T13:45:00Z') })]);

      expect(screen.getByText('printing on mk4, about 45m left')).toBeDefined();
    });

    it('says when it has run past what it was expected to take', () => {
      showing([job(1, ['PLA-Red'], { state: 'printing', heldBy: 'mk4', expectedDone: new Date('2026-09-09T12:30:00Z') })]);

      expect(screen.getByText('printing on mk4, past its estimate')).toBeDefined();
    });
  });

  // The outcome is not the verdict, and the line has to say which is missing.
  it('says a finished print is waiting for somebody to judge it', () => {
    showing([job(1, ['PLA-Red'], { state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'finished' })]);

    expect(screen.getByText('finished on mk4 - waiting for a verdict')).toBeDefined();
  });

  it('says how much is queued, and how much printing that is', () => {
    showing([job(1, ['PLA-Red'], { estimatedPrintSeconds: 3600 }), job(2, ['PLA-Red'], { estimatedPrintSeconds: 1800 })]);

    expect(screen.getByText('2 queued, 1h 30m of printing')).toBeDefined();
  });

  // What is already on the machine the operator is looking at, which is the whole point of choosing
  // one - the queue that needs no spool change is the queue that can start now.
  it('marks the filament the chosen machine already has on it', () => {
    showing([job(1, ['PLA-Red']), job(2, ['PLA-Blue'])], 2, mk4);

    expect(screen.getByText('on mk4')).toBeDefined();
  });

  it('shows the filament the chosen machine has on it first', () => {
    showing([job(1, ['PLA-Blue']), job(2, ['PLA-Blue']), job(3, ['PLA-Red'])], 3, mk4);

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['PLA-Redon mk4', 'PLA-Blue']);
  });

  it('marks nothing when no machine is chosen', () => {
    showing([job(1, ['PLA-Red'])]);

    expect(screen.queryByText(/^on /)).toBeNull();
  });

  // A caller sees their own work and a number for the rest - the same thing `job list` says, because
  // a list that quietly showed only your own would read as the whole queue.
  it('says how many are held that are not this caller"s', () => {
    showing([job(1, ['PLA-Red'])], 3);

    expect(screen.getByText('and 2 more this shop is holding, which are not yours')).toBeDefined();
  });

  it('says nothing of the sort when the caller can see all of them', () => {
    showing([job(1, ['PLA-Red'])]);

    expect(screen.queryByText(/not yours/)).toBeNull();
  });

  // AIDEV-NOTE: a verdict is offered against the job it is about rather than somewhere on its own,
  // because two machines can be waiting at once and "approve" says nothing about which bed.
  describe('and the verdict that frees a bed', () => {
    it('is offered on the print that is waiting for one', () => {
      judging([printed(7)]);

      expect(screen.getByRole('button', { name: 'Approve job 7' })).toBeDefined();
    });

    it.each([
      ['queued', job(1, ['PLA-Red'])],
      ['printing', job(1, ['PLA-Red'], { state: 'printing', heldBy: 'mk4' })],
    ])('is not offered on one that is %s', (_where, waiting) => {
      judging([waiting]);

      expect(screen.queryByRole('button', { name: /approve/ })).toBeNull();
    });

    it('is not offered at all where there is nobody to take it', () => {
      showing([printed(7)]);

      expect(screen.queryByRole('button', { name: /approve/ })).toBeNull();
    });

    it('says which job it was given about', async () => {
      judging([printed(7), printed(9)]);

      fireEvent.click(screen.getByRole('button', { name: 'Approve job 9' }));

      await waitFor(() => expect(judged).toHaveBeenCalledWith(9, 'approved'));
    });
  });

  // AIDEV-NOTE: the one-click way to put on what a group waits for. It REPLACES what is on the chosen
  // machine, because every printer here has one extruder.
  describe('loading what a group waits for', () => {
    const loads = jest.fn<(printer: string, filaments: string[]) => Promise<void>>();
    const loadOnMk4 = (): HTMLElement[] => screen.queryAllByRole('button', { name: 'Load on mk4' });

    beforeEach(() => {
      loads.mockReset();
      loads.mockResolvedValue(undefined);
    });

    const offering = (jobs: Job[], selected?: RegisteredPrinter): void => {
      render(<JobsByFilament jobs={jobs} totalJobs={jobs.length} selected={selected} onLoad={loads} />);
    };

    it('puts that filament, and only it, on the chosen machine', async () => {
      offering([job(1, ['PLA-Blue'])], mk4);

      fireEvent.click(screen.getByRole('button', { name: 'Load on mk4' }));

      await waitFor(() => expect(loads).toHaveBeenCalledWith('mk4', ['PLA-Blue']));
    });

    // A machine that paused itself mid-print - for a colour change, say - is waiting for exactly this.
    it.each([
      ['printing', { job: 1, phase: 'printing' }, true],
      ['paused by the machine', { job: 1, phase: 'printing', machinePausedSince: new Date('2026-10-18T18:00:00Z') }, false],
      ['awaiting a verdict', { job: 1, phase: 'awaiting-approval' }, false],
    ] as const)('is disabled only while the machine is actively printing - %s', (_what, holding, disabled) => {
      offering([job(1, ['PLA-Blue'])], { ...mk4, holding });

      expect((screen.getByRole('button', { name: 'Load on mk4' }) as HTMLButtonElement).disabled).toBe(disabled);
    });

    it('is not offered for what the machine already has on it', () => {
      offering([job(1, ['PLA-Red']), job(2, ['PLA-Blue'])], mk4);

      expect(loadOnMk4()).toHaveLength(1);
    });

    // A group of prints waiting for a verdict starts nothing when its filament goes on.
    it('is not offered for a group with nothing queued', () => {
      offering([job(1, ['PLA-Blue'], { state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'finished' })], mk4);

      expect(loadOnMk4()).toHaveLength(0);
    });

    it('is not offered when no machine is chosen', () => {
      offering([job(1, ['PLA-Blue'])]);

      expect(screen.queryByRole('button', { name: /^Load on/ })).toBeNull();
    });

    it('is not offered where there is nobody to take it', () => {
      showing([job(1, ['PLA-Blue'])], 1, mk4);

      expect(loadOnMk4()).toHaveLength(0);
    });

    it('cannot be pressed again while the shop is still answering', () => {
      loads.mockReturnValue(new Promise<void>(() => undefined));
      offering([job(1, ['PLA-Blue'])], mk4);

      fireEvent.click(screen.getByRole('button', { name: 'Load on mk4' }));

      expect((screen.getByRole('button', { name: 'Load on mk4' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('says what the shop said when it will not', async () => {
      loads.mockRejectedValue(new Error('no printer is named mk4'));
      offering([job(1, ['PLA-Blue'])], mk4);

      fireEvent.click(screen.getByRole('button', { name: 'Load on mk4' }));

      await waitFor(() => expect(screen.getByText('no printer is named mk4')).toBeDefined());
    });
  });
});
