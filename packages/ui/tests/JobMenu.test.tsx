import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Job } from '@3d-print-shop/client/browser';
import { JobMenu } from '../src/components/JobMenu';

// AIDEV-NOTE: (UT) what the menu OFFERS is most of what is being asked here. The shop refuses what
// it must whatever this renders - withholding a button is manners and not the guard - but a button
// offered for something that cannot happen is a person believing they did something they did not.
describe('what can be done with a job', () => {
  afterEach(cleanup);

  const onRename = jest.fn<(id: number, displayName: string) => Promise<void>>();
  const onHold = jest.fn<(id: number, held: boolean) => Promise<void>>();
  const onRemove = jest.fn<(id: number) => Promise<void>>();
  const confirm = jest.fn<(question: string) => boolean>();

  beforeEach(() => {
    onRename.mockResolvedValue(undefined);
    onHold.mockResolvedValue(undefined);
    onRemove.mockResolvedValue(undefined);
    confirm.mockReturnValue(true);
  });

  function job(overrides: Partial<Job> = {}): Job {
    return {
      id: 7,
      displayName: 'Player Box',
      filaments: ['PLA-Red'],
      submittedAt: new Date('2026-09-15T12:00:00Z'),
      state: 'queued',
      gcodeBytes: 1024,
      ...overrides,
    };
  }

  const open = (overrides: Partial<Job> = {}): void => {
    render(<JobMenu job={job(overrides)} actions={{ onRename, onHold, onRemove }} confirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'what can be done with job 7' }));
  };

  const press = (button: string): void => fireEvent.click(screen.getByRole('button', { name: button }));

  describe('a queued job', () => {
    it('can be paused', async () => {
      open();

      press('pause');

      await waitFor(() => expect(onHold).toHaveBeenCalledWith(7, true));
    });

    it('offers to resume one already paused, rather than to pause it twice', async () => {
      open({ heldBack: new Date('2026-09-15T13:00:00Z') });

      press('resume');

      await waitFor(() => expect(onHold).toHaveBeenCalledWith(7, false));
    });

    it('is deleted rather than cancelled, because there is nothing running to stop', async () => {
      open();

      press('delete');

      await waitFor(() => expect(onRemove).toHaveBeenCalledWith(7));
    });

    it('can be called something else', async () => {
      open();
      press('rename');

      fireEvent.change(screen.getByLabelText('a name for job 7'), { target: { value: 'Clamp Dock' } });
      fireEvent.click(screen.getByRole('button', { name: 'rename' }));

      await waitFor(() => expect(onRename).toHaveBeenCalledWith(7, 'Clamp Dock'));
    });
  });

  describe('a job that is printing', () => {
    // A hold keeps a job from STARTING, and this one started. Offering it would have somebody
    // believe they had stopped a print they had not.
    it('is not offered a pause', () => {
      open({ state: 'printing', heldBy: 'mk4' });

      expect(screen.queryByRole('button', { name: 'pause' })).toBeNull();
    });

    it('offers to cancel rather than to delete', () => {
      open({ state: 'printing', heldBy: 'mk4' });

      expect(screen.getByRole('button', { name: 'cancel' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'delete' })).toBeNull();
    });

    it('says what stopping it costs, and names the machine, before doing it', () => {
      open({ state: 'printing', heldBy: 'mk4' });

      press('cancel');

      expect(confirm.mock.calls[0]?.[0]).toContain('mk4');
      expect(confirm.mock.calls[0]?.[0]).toContain('bed');
    });
  });

  // The confirmation is this end's job: it protects a person's intent, where the shop's refusals
  // protect its own rules.
  describe('when somebody changes their mind at the question', () => {
    it('asks the shop for nothing', () => {
      confirm.mockReturnValue(false);
      open();

      press('delete');

      expect(onRemove).not.toHaveBeenCalled();
    });
  });

  it('shows the shop its own words when it refuses', async () => {
    onRemove.mockRejectedValue(new Error('job 7 is waiting for a verdict'));
    open();

    press('delete');

    await waitFor(() => expect(screen.getByText('job 7 is waiting for a verdict')).toBeDefined());
  });
});
