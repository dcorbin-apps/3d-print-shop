import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TopBar } from '../src/components/TopBar';
import type { ShopSummary } from '../src/shopSummary';

describe('the banner and what it says the shop is doing', () => {
  afterEach(cleanup);

  const quiet: ShopSummary = { printers: 0, printing: 0, needingSomebody: 0, queued: 0, awaitingApproval: 0 };

  const said = (label: string): string | null => screen.getByText(label).parentElement?.querySelector('dd')?.textContent ?? null;

  it('names the shop', () => {
    render(<TopBar summary={quiet} />);

    expect(screen.getByRole('heading').textContent).toBe('3D Print Shop');
  });

  it('counts what there is', () => {
    render(<TopBar summary={{ printers: 2, printing: 1, needingSomebody: 1, queued: 7, awaitingApproval: 2 }} />);

    expect(said('printers')).toBe('2');
    expect(said('printing')).toBe('1');
    expect(said('needs somebody')).toBe('1');
    expect(said('queued')).toBe('7');
    expect(said('to judge')).toBe('2');
  });

  // One printer is a printer, and a banner that says "1 printers" is a banner nobody trusts.
  it('says printer rather than printers when there is one', () => {
    render(<TopBar summary={{ ...quiet, printers: 1 }} />);

    expect(screen.getByText('printer')).toBeDefined();
  });

  // AIDEV-NOTE: what the summary is FOR - the two numbers that mean somebody has to go and do
  // something are the two that are marked, and only while they are not zero.
  it.each<[keyof ShopSummary, string]>([
    ['needingSomebody', 'needs somebody'],
    ['awaitingApproval', 'to judge'],
  ])('marks %s as wanting a person when it is not zero', (field, label) => {
    render(<TopBar summary={{ ...quiet, [field]: 1 }} />);

    expect(screen.getByText(label).parentElement?.className).toBe('count urgent');
  });

  it('marks nothing in a shop where nothing needs doing', () => {
    render(<TopBar summary={quiet} />);

    expect(document.querySelectorAll('.urgent')).toHaveLength(0);
  });

  // AIDEV-NOTE: behind the name rather than beside it, because a log out sitting in the banner of a
  // shared screen is a thing to hit by accident - and what somebody goes to the corner of a page
  // looking for is their own name.
  describe('who is looking at it', () => {
    const asDave = { id: 'dave', name: 'dave', role: 'admin' as const };
    const goesOut = jest.fn<() => void>();

    const theName = (): HTMLElement => screen.getByRole('button', { name: /dave/ });
    const loggingOut = (): HTMLElement | null => screen.queryByRole('menuitem', { name: 'Log out' });

    it('says the name and the role of whoever is logged in', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);

      expect(theName().textContent).toContain('dave');
      expect(theName().textContent).toContain('admin');
    });

    it('says nothing at all when nobody is', () => {
      render(<TopBar summary={quiet} />);

      expect(screen.queryByRole('button', { name: /dave/ })).toBeNull();
    });

    it('keeps logging out behind the name rather than in the banner', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);

      expect(loggingOut()).toBeNull();
    });

    it('offers it when the name is clicked', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);

      fireEvent.click(theName());

      expect(loggingOut()).not.toBeNull();
    });

    it('logs out when it is chosen', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);
      fireEvent.click(theName());

      fireEvent.click(loggingOut() as HTMLElement);

      expect(goesOut).toHaveBeenCalled();
    });

    // The two ways out of an open menu that people expect and nothing else provides.
    it('closes when somebody clicks at anything else', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);
      fireEvent.click(theName());

      fireEvent.mouseDown(document.body);

      expect(loggingOut()).toBeNull();
      expect(goesOut).not.toHaveBeenCalled();
    });

    it('closes when somebody presses escape', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);
      fireEvent.click(theName());

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(loggingOut()).toBeNull();
    });

    it('closes again when the name is clicked a second time', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);
      fireEvent.click(theName());

      fireEvent.click(theName());

      expect(loggingOut()).toBeNull();
    });

    // What a screen reader is told, and what says which way the thing in the corner opens.
    it('says whether it is open', () => {
      render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);
      expect(theName().getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(theName());

      expect(theName().getAttribute('aria-expanded')).toBe('true');
    });

    // A caller the page was given no way to log out is still a caller worth naming.
    it('offers nothing behind the name when there is no way to log out', () => {
      render(<TopBar summary={quiet} caller={asDave} />);

      fireEvent.click(theName());

      expect(loggingOut()).toBeNull();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    // AIDEV-NOTE: their own password, behind their own name - the only thing on this page that is
    // about the person rather than about the shop, and where somebody goes looking for it.
    describe('and changing their password', () => {
      const changed = jest.fn<(current: string, password: string) => Promise<void>>();
      const changingIt = (): HTMLElement | null => screen.queryByRole('menuitem', { name: 'Change password' });

      it('is offered behind the name, beside logging out', () => {
        render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} onChangePassword={changed} />);

        fireEvent.click(theName());

        expect(changingIt()).not.toBeNull();
      });

      it('is not offered where the page was given no way to do it', () => {
        render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} />);

        fireEvent.click(theName());

        expect(changingIt()).toBeNull();
      });

      it('asks for the passwords when it is chosen, and puts the menu away', () => {
        render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} onChangePassword={changed} />);
        fireEvent.click(theName());

        fireEvent.click(changingIt() as HTMLElement);

        expect(screen.getByLabelText('current password', { exact: false })).toBeDefined();
        expect(changingIt()).toBeNull();
      });

      it('asks for nothing until it is chosen', () => {
        render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} onChangePassword={changed} />);

        expect(screen.queryByLabelText('current password', { exact: false })).toBeNull();
      });

      it('is put away by somebody who thought better of it', () => {
        render(<TopBar summary={quiet} caller={asDave} onOut={goesOut} onChangePassword={changed} />);
        fireEvent.click(theName());
        fireEvent.click(changingIt() as HTMLElement);

        fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

        expect(screen.queryByLabelText('current password', { exact: false })).toBeNull();
      });
    });
  });

  // The last good answer stays underneath, so a shop being restarted does not blank a wall display.
  it('says what went wrong asking, when something did', () => {
    render(<TopBar summary={quiet} trouble="the shop could not be reached" />);

    expect(screen.getByText('the shop could not be reached')).toBeDefined();
  });

  it('says nothing when nothing went wrong', () => {
    render(<TopBar summary={quiet} />);

    expect(document.querySelector('.trouble')).toBeNull();
  });
});
