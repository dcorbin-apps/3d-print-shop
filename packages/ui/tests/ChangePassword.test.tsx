import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChangePassword } from '../src/components/ChangePassword';

describe('changing your own password', () => {
  afterEach(cleanup);

  const changed = jest.fn<(current: string, password: string) => Promise<void>>();
  const closed = jest.fn<() => void>();

  const NOW = 'the password in use';
  const NEXT = 'a different password entirely';

  beforeEach(() => {
    changed.mockReset();
    changed.mockResolvedValue(undefined);
    closed.mockReset();
  });

  const asking = (): void => {
    render(<ChangePassword onChange={changed} onDone={closed} />);
  };

  const type = (label: string, said: string): void => {
    fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value: said } });
  };

  const fillIn = (now = NOW, next = NEXT, again = next): void => {
    type('current password', now);
    type('new password', next);
    type('repeat the new one', again);
  };

  const press = (button: string): void => {
    fireEvent.click(screen.getByRole('button', { name: button }));
  };

  // AIDEV-NOTE: the one they have now is asked for even though the shop already knows who this
  // browser is - a session is a screen somebody walked away from.
  it('asks for the one in use as well as the new one', () => {
    asking();

    ['current password', 'new password', 'repeat the new one'].forEach((field) => {
      expect(screen.getByLabelText(field, { exact: false })).toBeDefined();
    });
  });

  it('leaves none of them on the screen as it is typed', () => {
    asking();

    ['current password', 'new password', 'repeat the new one'].forEach((field) => {
      expect(screen.getByLabelText(field, { exact: false }).getAttribute('type')).toBe('password');
    });
  });

  it('hands the shop the one in use and the one wanted', async () => {
    asking();
    fillIn();

    press('change');

    await waitFor(() => expect(changed).toHaveBeenCalledWith(NOW, NEXT));
  });

  it('will not ask until all three have been typed', () => {
    asking();
    type('current password', NOW);

    expect(screen.getByRole('button', { name: 'change' }).hasAttribute('disabled')).toBe(true);
  });

  // The one thing this end knows by itself: the shop cannot see that the two new ones differ.
  it('says so when the two new ones are not the same, and asks the shop nothing', () => {
    asking();
    fillIn(NOW, NEXT, 'something else again');

    press('change');

    expect(screen.getByText('The two new ones are not the same')).toBeDefined();
    expect(changed).not.toHaveBeenCalled();
  });

  // How long a password has to be is the shop's rule, said in the shop's words - a copy of it here
  // is the copy that drifts.
  it('shows what the shop said when it would not take one', async () => {
    changed.mockRejectedValue(new Error('a password has to be at least 12 characters'));
    asking();
    fillIn();

    press('change');

    expect(await screen.findByText('a password has to be at least 12 characters')).toBeDefined();
  });

  // A message from the last go, sitting beside "changing...", reads as the answer to this one.
  it('clears what the shop said last time while it is asking again', async () => {
    changed.mockRejectedValueOnce(new Error('that is not the password this caller has now'));
    asking();
    fillIn();
    press('change');
    await screen.findByText('that is not the password this caller has now');

    changed.mockReturnValue(new Promise<void>(() => undefined));
    press('change');

    await waitFor(() => expect(screen.getByRole('button', { name: 'changing...' })).toBeDefined());
    expect(screen.queryByText('that is not the password this caller has now')).toBeNull();
  });

  it('stays open to be tried again after a refusal', async () => {
    changed.mockRejectedValueOnce(new Error('that is not the password this caller has now'));
    asking();
    fillIn();
    press('change');
    await screen.findByText('that is not the password this caller has now');

    press('change');

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  });

  // Nothing else on the page changes when this works, so a form that simply vanished would be
  // indistinguishable from one that did nothing.
  it('says it worked, and what it did to every other browser', async () => {
    asking();
    fillIn();

    press('change');

    expect(await screen.findByText(/Password changed/)).toBeDefined();
    expect(screen.getByText(/logged out/)).toBeDefined();
  });

  it('is put away when there is nothing more to say', async () => {
    asking();
    fillIn();
    press('change');
    await screen.findByText(/Password changed/);

    press('close');

    expect(closed).toHaveBeenCalled();
  });

  it('is put away by somebody who thought better of it, having changed nothing', () => {
    asking();
    fillIn();

    press('cancel');

    expect(closed).toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it('says which one it is waiting on the shop for', async () => {
    changed.mockReturnValue(new Promise<void>(() => undefined));
    asking();
    fillIn();

    press('change');

    await waitFor(() => expect(screen.getByRole('button', { name: 'changing...' }).hasAttribute('disabled')).toBe(true));
  });
});
