import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Job } from '@3d-print-shop/client/browser';
import { JobName } from '../src/components/JobName';

// AIDEV-NOTE: (UT) Enter and clicking away both COMMIT and Escape abandons, which is the bargain
// every editable field makes. The one worth pinning hardest is Escape: it unmounts the field, and
// unmounting blurs it, and a blur is a commit - so the obvious implementation saves what somebody
// just said to throw away.
describe('renaming a job on the job', () => {
  afterEach(cleanup);

  const onRename = jest.fn<(id: number, displayName: string) => Promise<void>>();

  beforeEach(() => {
    onRename.mockResolvedValue(undefined);
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

  const show = (): { seenAs: (displayName: string) => void } => {
    const shown = render(<JobName job={job()} onRename={onRename} />);

    return { seenAs: (displayName) => shown.rerender(<JobName job={job({ displayName })} onRename={onRename} />) };
  };

  // AIDEV-NOTE: its own function rather than `show(undefined)`, which would take the DEFAULT
  // parameter and quietly render an editable one - a test that passed while asking nothing.
  const showWithNothingOffered = (): void => {
    render(<JobName job={job()} />);
  };

  const editing = (): HTMLElement => screen.getByLabelText('A name for job 7');

  const startEditing = (): void => {
    fireEvent.doubleClick(screen.getByText('Player Box'));
  };

  const type = (what: string): void => fireEvent.change(editing(), { target: { value: what } });

  it('shows the name until somebody asks to change it', () => {
    show();

    expect(screen.getByText('Player Box')).toBeDefined();
    expect(screen.queryByLabelText('A name for job 7')).toBeNull();
  });

  it('opens for editing on a double click, with the name already in it', () => {
    show();

    startEditing();

    expect((editing() as HTMLInputElement).value).toBe('Player Box');
  });

  it('keeps what was typed when Enter is pressed', async () => {
    show();
    startEditing();
    type('Clamp Dock');

    fireEvent.keyDown(editing(), { key: 'Enter' });

    await waitFor(() => expect(onRename).toHaveBeenCalledWith(7, 'Clamp Dock'));
  });

  it('keeps what was typed when the field is left', async () => {
    show();
    startEditing();
    type('Clamp Dock');

    fireEvent.blur(editing());

    await waitFor(() => expect(onRename).toHaveBeenCalledWith(7, 'Clamp Dock'));
  });

  // The one that the obvious implementation gets wrong: Escape unmounts the field, unmounting blurs
  // it, and a blur is a commit. Abandoning has to survive its own blur.
  it('changes nothing when Escape is pressed, whatever was typed', () => {
    show();
    startEditing();
    type('Clamp Dock');

    fireEvent.keyDown(editing(), { key: 'Escape' });
    fireEvent.blur(screen.getByText('Player Box'));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Player Box')).toBeDefined();
  });

  it('puts the name back as it was after an abandoned edit', () => {
    show();
    startEditing();
    type('Clamp Dock');
    fireEvent.keyDown(editing(), { key: 'Escape' });

    startEditing();

    expect((editing() as HTMLInputElement).value).toBe('Player Box');
  });

  // Neither is somebody asking for an empty name or for the name it already has, and neither is
  // worth a request the shop would only have to answer.
  it.each([
    ['nothing was changed', 'Player Box'],
    ['everything was deleted', '   '],
  ])('asks the shop for nothing when %s', (_what, typed) => {
    show();
    startEditing();
    type(typed);

    fireEvent.keyDown(editing(), { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
  });

  it('shows the shop its own words when it will not take the name', async () => {
    onRename.mockRejectedValue(new Error('a job name is at most 255 characters'));
    show();
    startEditing();
    type('Clamp Dock');

    fireEvent.keyDown(editing(), { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/at most 255 characters/)).toBeDefined());
  });

  it('cannot be edited at all by somebody the page offers nothing to', () => {
    showWithNothingOffered();

    fireEvent.doubleClick(screen.getByText('Player Box'));

    expect(screen.queryByLabelText('A name for job 7')).toBeNull();
  });

  // AIDEV-NOTE: the field closes at once and the new name arrives on the next poll, so for a moment
  // the row is rendering a job that still says the old thing. Showing it flashed the old name back
  // at somebody who had just finished typing, which reads as the rename having failed.
  describe('before the shop has answered', () => {
    it('shows what was asked for rather than the name the job still has', async () => {
      show();
      startEditing();
      type('Clamp Dock');

      fireEvent.keyDown(editing(), { key: 'Enter' });

      await waitFor(() => expect(screen.getByText('Clamp Dock')).toBeDefined());
      expect(screen.queryByText('Player Box')).toBeNull();
    });

    it("goes back to the job's own name when the shop will not take it", async () => {
      onRename.mockRejectedValue(new Error('no job 7'));
      show();
      startEditing();
      type('Clamp Dock');

      fireEvent.keyDown(editing(), { key: 'Enter' });

      await waitFor(() => expect(screen.getByText('Player Box')).toBeDefined());
    });

    // Held only until the job itself says so, because from then on the job is the better answer.
    it('defers to the job once the new name has come round', async () => {
      const shown = show();
      startEditing();
      type('Clamp Dock');
      fireEvent.keyDown(editing(), { key: 'Enter' });
      await waitFor(() => expect(onRename).toHaveBeenCalled());

      shown.seenAs('Clamp Dock');

      expect(screen.getByText('Clamp Dock')).toBeDefined();
    });
  });
});
