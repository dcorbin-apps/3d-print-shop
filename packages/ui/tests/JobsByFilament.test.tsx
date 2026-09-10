import { describe, it, expect, afterEach } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react';
import type { Job, RegisteredPrinter } from '@3d-print-shop/client/browser';
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

  const showing = (jobs: Job[], totalJobs = jobs.length, selected?: RegisteredPrinter): void => {
    render(<JobsByFilament jobs={jobs} totalJobs={totalJobs} selected={selected} />);
  };

  it('says so when there is nothing outstanding', () => {
    showing([]);

    expect(screen.getByText('Nothing outstanding.')).toBeDefined();
  });

  it('gives every job a heading of the filament it waits on', () => {
    showing([job(1, ['PLA-Red']), job(2, ['PLA-Blue'])]);

    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['PLA-Blue', 'PLA-Red']);
  });

  it('shows each job by name, and where it has got to', () => {
    showing([job(1, ['PLA-Red'], { displayName: 'Player Box', state: 'printing', heldBy: 'mk4' })]);

    expect(screen.getByText('Player Box')).toBeDefined();
    expect(screen.getByText('printing on mk4')).toBeDefined();
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
});
