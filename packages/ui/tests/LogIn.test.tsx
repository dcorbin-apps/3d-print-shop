import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LogIn } from '../src/components/LogIn';

// AIDEV-NOTE: nothing is kept here and nothing is remembered. What logging in produces is a cookie
// the shop set, which this page cannot read - so what is worth testing is what it does with a
// refusal, which is the one moment a login form can leak something.
describe('the page somebody logs in on', () => {
  afterEach(cleanup);

  const onIn = jest.fn<(id: string, password: string) => Promise<void>>();

  const typing = (): { who: HTMLInputElement; password: HTMLInputElement; button: HTMLButtonElement } => ({
    who: screen.getByLabelText('Who') as HTMLInputElement,
    password: screen.getByLabelText('Password') as HTMLInputElement,
    button: screen.getByRole('button') as HTMLButtonElement,
  });

  const loggingIn = (id: string, password: string): void => {
    const { who, password: field } = typing();
    fireEvent.change(who, { target: { value: id } });
    fireEvent.change(field, { target: { value: password } });
    fireEvent.click(screen.getByRole('button'));
  };

  it('names the shop, because a screen in a workshop is one anybody walks up to', () => {
    render(<LogIn onIn={onIn} />);

    expect(screen.getByRole('heading').textContent).toBe('3D Print Shop');
  });

  it('asks the shop with what was typed', async () => {
    onIn.mockResolvedValue(undefined);
    render(<LogIn onIn={onIn} />);

    loggingIn('dave', 'a password');

    await waitFor(() => expect(onIn).toHaveBeenCalledWith('dave', 'a password'));
  });

  // A name copied from somewhere picks up whitespace; a password is taken exactly as typed, because
  // a space in one is a character of it.
  it('trims the name and never the password', async () => {
    onIn.mockResolvedValue(undefined);
    render(<LogIn onIn={onIn} />);

    loggingIn('  dave  ', '  spaces  ');

    await waitFor(() => expect(onIn).toHaveBeenCalledWith('dave', '  spaces  '));
  });

  describe('before anything has been typed', () => {
    it('cannot be submitted', () => {
      render(<LogIn onIn={onIn} />);

      expect(typing().button.disabled).toBe(true);
    });

    it.each([
      ['a name and no password', 'dave', ''],
      ['a password and no name', '', 'a password'],
      ['a name that is only spaces', '   ', 'a password'],
    ])('cannot be submitted with %s', (_what, id, password) => {
      render(<LogIn onIn={onIn} />);

      fireEvent.change(typing().who, { target: { value: id } });
      fireEvent.change(typing().password, { target: { value: password } });

      expect(typing().button.disabled).toBe(true);
    });
  });

  describe('when the shop will not have them', () => {
    // The shop's own words, which say the same thing for a name it does not know as for a password
    // that is wrong - so this cannot tell somebody which half they got right either.
    it('says what the shop said, and no more', async () => {
      onIn.mockRejectedValue(new Error('that is not a name and a password this shop knows'));
      render(<LogIn onIn={onIn} />);

      loggingIn('dave', 'the wrong one');

      expect((await screen.findByText('that is not a name and a password this shop knows')).textContent).toBe(
        'that is not a name and a password this shop knows',
      );
    });

    // Cleared so the next attempt is typed afresh, and so a wrong one is not left on a screen in a
    // room anybody walks through.
    it('clears the password and keeps the name', async () => {
      onIn.mockRejectedValue(new Error('no'));
      render(<LogIn onIn={onIn} />);

      loggingIn('dave', 'the wrong one');

      await waitFor(() => expect(typing().password.value).toBe(''));
      expect(typing().who.value).toBe('dave');
    });

    it('lets them try again', async () => {
      onIn.mockRejectedValue(new Error('no'));
      render(<LogIn onIn={onIn} />);
      loggingIn('dave', 'the wrong one');
      await screen.findByText('no');

      fireEvent.change(typing().password, { target: { value: 'another' } });

      expect(typing().button.disabled).toBe(false);
    });

    it('stops saying it once another attempt is under way', async () => {
      onIn.mockRejectedValue(new Error('no'));
      render(<LogIn onIn={onIn} />);
      loggingIn('dave', 'the wrong one');
      await screen.findByText('no');

      onIn.mockReturnValue(new Promise(() => undefined));
      loggingIn('dave', 'another');

      await waitFor(() => expect(screen.queryByText('no')).toBeNull());
    });
  });

  // A login costs the shop 50ms of scrypt whatever happens, so a second click while one is in
  // flight is a second one of those.
  describe('while the shop is being asked', () => {
    it('says so, and cannot be asked again', async () => {
      onIn.mockReturnValue(new Promise(() => undefined));
      render(<LogIn onIn={onIn} />);

      loggingIn('dave', 'a password');

      await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true));
      expect(screen.getByRole('button').textContent).toBe('Asking...');
    });
  });
});
