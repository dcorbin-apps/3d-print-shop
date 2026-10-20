import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Job } from '@3d-print-shop/client/browser';
import { JobControls } from '../src/components/JobControls';

// AIDEV-NOTE: (UT) what is OFFERED is most of what is being asked here. The shop refuses what it must
// whatever this renders - withholding a button is manners and not the guard - but a button offered
// for something that cannot happen is a person believing they did something they did not.
describe('what can be done with a job', () => {
  afterEach(cleanup);

  const onRename = jest.fn<(id: number, displayName: string) => Promise<void>>();
  const onHold = jest.fn<(id: number, held: boolean) => Promise<void>>();
  const onRemove = jest.fn<(id: number) => Promise<void>>();
  const onPromote = jest.fn<(id: number) => Promise<void>>();
  const confirm = jest.fn<(question: string) => boolean>();

  beforeEach(() => {
    onRename.mockResolvedValue(undefined);
    onHold.mockResolvedValue(undefined);
    onRemove.mockResolvedValue(undefined);
    onPromote.mockResolvedValue(undefined);
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

  const show = (overrides: Partial<Job> = {}): void => {
    render(<JobControls job={job(overrides)} actions={{ onRename, onHold, onRemove }} confirm={confirm} />);
  };

  const showToAnAdmin = (overrides: Partial<Job> = {}): void => {
    render(<JobControls job={job(overrides)} actions={{ onRename, onHold, onRemove, onPromote }} confirm={confirm} />);
  };

  const press = (button: string): void => fireEvent.click(screen.getByRole('button', { name: button }));

  describe('a queued job', () => {
    it('can be paused', async () => {
      show();

      press('Pause job 7');

      await waitFor(() => expect(onHold).toHaveBeenCalledWith(7, true));
    });

    it('offers to resume one already paused, rather than to pause it twice', async () => {
      show({ heldBack: new Date('2026-09-15T13:00:00Z') });

      press('Resume job 7');

      await waitFor(() => expect(onHold).toHaveBeenCalledWith(7, false));
    });

    it('is deleted rather than cancelled, because there is nothing running to stop', async () => {
      show();

      press('Delete job 7');

      await waitFor(() => expect(onRemove).toHaveBeenCalledWith(7));
    });
  });

  describe('a job that is printing', () => {
    // A pause keeps a job from STARTING, and this one started. Offering it would have somebody
    // believe they had stopped a print they had not.
    it('is not offered a pause', () => {
      show({ state: 'printing', heldBy: 'mk4' });

      expect(screen.queryByRole('button', { name: 'Pause job 7' })).toBeNull();
    });

    it('offers to cancel rather than to delete', () => {
      show({ state: 'printing', heldBy: 'mk4' });

      expect(screen.getByRole('button', { name: 'Cancel job 7' })).toBeDefined();
      expect(screen.queryByRole('button', { name: 'Delete job 7' })).toBeNull();
    });

    it('says what stopping it costs, and names the machine, before doing it', () => {
      show({ state: 'printing', heldBy: 'mk4' });

      press('Cancel job 7');

      expect(confirm.mock.calls[0]?.[0]).toContain('mk4');
      expect(confirm.mock.calls[0]?.[0]).toContain('bed');
    });
  });

  describe('promoting a job', () => {
    it('sends a queued one to the front', async () => {
      showToAnAdmin();

      press('Promote job 7');

      await waitFor(() => expect(onPromote).toHaveBeenCalledWith(7));
    });

    it('is not offered on one that is printing, because it has already started', () => {
      showToAnAdmin({ state: 'printing', heldBy: 'mk4' });

      expect(screen.queryByRole('button', { name: 'Promote job 7' })).toBeNull();
    });

    it('is not offered where there is nobody to take it', () => {
      show();

      expect(screen.queryByRole('button', { name: 'Promote job 7' })).toBeNull();
    });
  });

  // The shop refuses it: a verdict is how a print waiting for one leaves.
  describe('a print waiting for a verdict', () => {
    it('is offered neither a delete nor a cancel', () => {
      show({ state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'finished' });

      expect(screen.queryByRole('button', { name: /^(Delete|Cancel) job 7$/ })).toBeNull();
    });
  });

  // A mark is only as good as the word beside it, and these have no word until somebody hovers.
  describe('what each mark says it is', () => {
    it.each([
      ['a queued job', 'Pause', {}],
      ['a paused one', 'Resume', { heldBack: new Date('2026-09-15T13:00:00Z') }],
      ['a queued job', 'Delete', {}],
      ['a printing one', 'Cancel', { state: 'printing' as const, heldBy: 'mk4' }],
      ['a queued job', 'Promote', {}],
    ])('tells somebody %s can be %s, in the word the button would have said', (_what, word, overrides) => {
      showToAnAdmin(overrides);

      // `data-says` and not `title`: a browser draws a title under the pointer, which on a mark this
      // size is the pointer covering the word. The stylesheet draws this one above the button.
      expect(screen.getByRole('button', { name: `${word} job 7` }).getAttribute('data-says')).toBe(word);
    });
  });

  // The confirmation is this end's job: it protects a person's intent, where the shop's refusals
  // protect its own rules.
  describe('when somebody changes their mind at the question', () => {
    it('asks the shop for nothing', () => {
      confirm.mockReturnValue(false);
      show();

      press('Delete job 7');

      expect(onRemove).not.toHaveBeenCalled();
    });
  });

  it('shows the shop its own words when it refuses', async () => {
    onRemove.mockRejectedValue(new Error('job 7 is waiting for a verdict'));
    show();

    press('Delete job 7');

    await waitFor(() => expect(screen.getByText('job 7 is waiting for a verdict')).toBeDefined());
  });

  describe('what the shop said when it refused', () => {
    const refusedOnce = async (): Promise<(overrides: Partial<Job>) => void> => {
      onRemove.mockRejectedValue(new Error('nothing to cancel'));
      const { rerender } = render(<JobControls job={job({ state: 'printing', heldBy: 'mk4' })} actions={{ onRename, onHold, onRemove }} confirm={confirm} />);
      press('Cancel job 7');
      await waitFor(() => expect(screen.getByText('nothing to cancel')).toBeDefined());

      return (overrides) => rerender(<JobControls job={job(overrides)} actions={{ onRename, onHold, onRemove }} confirm={confirm} />);
    };

    it('stays while the job is as it was', async () => {
      const showAgain = await refusedOnce();

      showAgain({ state: 'printing', heldBy: 'mk4' });

      expect(screen.queryByText('nothing to cancel')).not.toBeNull();
    });

    it('goes once the job has moved on', async () => {
      const showAgain = await refusedOnce();

      showAgain({ state: 'awaiting-approval', heldBy: 'mk4', lastPrinterOutcome: 'failed' });

      expect(screen.queryByText('nothing to cancel')).toBeNull();
    });
  });
});
