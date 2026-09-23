import { describe, it, expect, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Job } from '@3d-print-shop/client/browser';
import { JobPicture } from '../src/components/JobPicture';

describe('the picture of a job', () => {
  afterEach(cleanup);

  const playerBox: Job = {
    id: 7,
    displayName: 'Player Box',
    filaments: ['PLA-Red'],
    submittedAt: new Date('2026-09-09T12:00:00Z'),
    gcodeBytes: 1024,
    state: 'queued',
  };

  const thumbnail = (): HTMLElement => screen.getByRole('button', { name: 'Show Player Box larger' });

  it('shows the shop’s picture of that job', () => {
    render(<JobPicture job={playerBox} />);

    expect(thumbnail().querySelector('img')?.getAttribute('src')).toBe('/jobs/7/picture');
  });

  it('shows it larger, named for the job, when it is clicked', () => {
    render(<JobPicture job={playerBox} />);

    fireEvent.click(thumbnail());

    expect(screen.getByRole('dialog', { name: 'Player Box' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Player Box' }).getAttribute('src')).toBe('/jobs/7/picture');
  });

  it('puts the larger one away when it is clicked', () => {
    render(<JobPicture job={playerBox} />);
    fireEvent.click(thumbnail());

    fireEvent.click(screen.getByRole('dialog'));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts the larger one away on Escape', () => {
    render(<JobPicture job={playerBox} />);
    fireEvent.click(thumbnail());

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is not shown at all when the shop could not give one', () => {
    render(<JobPicture job={playerBox} />);

    fireEvent.error(thumbnail().querySelector('img') as HTMLImageElement);

    expect(screen.queryByRole('button')).toBeNull();
  });
});
