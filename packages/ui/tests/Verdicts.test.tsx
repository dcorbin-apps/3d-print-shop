import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Verdict } from '@3d-print-shop/client/browser';
import { Verdicts } from '../src/components/Verdicts';

describe('judging a print from the page it was watched on', () => {
  afterEach(cleanup);

  const said = jest.fn<(verdict: Verdict) => Promise<void>>();

  beforeEach(() => {
    said.mockReset();
    said.mockResolvedValue(undefined);
  });

  const offering = (job = 7): void => {
    render(<Verdicts job={job} onVerdict={said} />);
  };

  const press = (button: string, job = 7): void => {
    fireEvent.click(screen.getByRole('button', { name: `${button} job ${job}` }));
  };

  // Three, because the third one is the one a shop cannot do without: a print that was no good and
  // is not worth another still has to let go of the bed it is holding.
  it.each([
    ['approve', 'approved'],
    ['print again', 'rejected'],
    ['give up', 'abandoned'],
  ])('tells the shop that %s means %s', async (button, verdict) => {
    offering();

    press(button);

    await waitFor(() => expect(said).toHaveBeenCalledWith(verdict));
  });

  // A screen may be offering this for several finished prints at once, and "approve" on its own
  // says nothing about which bed is about to be freed.
  it('says which job each of them judges', () => {
    offering(12);

    expect(screen.getByRole('button', { name: 'approve job 12' })).toBeDefined();
  });

  it('says what each of them will do to the job', () => {
    offering();

    expect(screen.getByRole('button', { name: 'print again job 7' }).getAttribute('title')).toContain('print again from the same gcode');
  });

  it('takes one verdict, not one per click', async () => {
    let taken = (): void => undefined;
    said.mockReturnValue(
      new Promise<void>((done) => {
        taken = done;
      })
    );
    offering();

    press('approve');
    await waitFor(() => expect(screen.getByRole('button', { name: 'give up job 7' }).hasAttribute('disabled')).toBe(true));
    press('give up');

    expect(said).toHaveBeenCalledTimes(1);
    taken();
  });

  it('says which one it is waiting on the shop to take', async () => {
    said.mockReturnValue(new Promise<void>(() => undefined));
    offering();

    press('approve');

    await waitFor(() => expect(screen.getByRole('button', { name: 'approve job 7' }).textContent).toBe('approve...'));
  });

  // The shop's own words, because this end knows only that a verdict was not taken - not whether the
  // job had already gone, or was never this caller's to judge.
  it('shows what the shop said when it would not take one', async () => {
    said.mockRejectedValue(new Error('job 7 is not yours to judge'));
    offering();

    press('approve');

    expect(await screen.findByText('job 7 is not yours to judge')).toBeDefined();
  });

  it('can be asked again after a refusal', async () => {
    said.mockRejectedValueOnce(new Error('the shop is not answering'));
    offering();

    press('approve');
    await screen.findByText('the shop is not answering');
    press('give up');

    await waitFor(() => expect(said).toHaveBeenCalledWith('abandoned'));
    expect(screen.queryByText('the shop is not answering')).toBeNull();
  });
});
