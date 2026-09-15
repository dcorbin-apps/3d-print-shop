import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';
import { AddPrinterTile } from '../src/components/AddPrinterTile';

describe('adding a printer from the row it will appear in', () => {
  afterEach(cleanup);

  const takesIt = jest.fn<(record: PrinterRecord, key: string) => Promise<void>>();

  const open = (): void => {
    render(<AddPrinterTile onAdd={takesIt} />);
    fireEvent.click(screen.getByRole('button', { name: 'add a printer' }));
  };

  const type = (label: string, said: string): void => {
    fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value: said } });
  };

  const describeAnMk4 = (): void => {
    type('name', 'mk4');
    type('width', '250');
    type('depth', '210');
    type('height', '220');
    type('address', 'http://octopi.local');
    type('api key', 'mk4-key');
  };

  it('is a plus until somebody presses it', () => {
    render(<AddPrinterTile onAdd={takesIt} />);

    expect(screen.getByRole('button', { name: 'add a printer' }).textContent).toContain('+');
    expect(screen.queryByLabelText('name')).toBeNull();
  });

  it('asks for what the shop needs to know', () => {
    open();

    ['name', 'width', 'depth', 'height', 'address', 'api key'].forEach((field) => {
      expect(screen.getByLabelText(field, { exact: false })).toBeDefined();
    });
  });

  // AIDEV-NOTE: the key IS asked for here - a printer the shop has no key for is one it can only
  // report as out of reach, and adding a machine nobody can print on is not what this is for. Not
  // shown while it is typed, because this is a screen in a workshop.
  it('does not leave the key on the screen', () => {
    open();

    expect(screen.getByLabelText('api key', { exact: false }).getAttribute('type')).toBe('password');
  });

  it('hands the shop what was typed', async () => {
    takesIt.mockResolvedValue(undefined);
    open();
    describeAnMk4();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() =>
      expect(takesIt).toHaveBeenCalledWith(
        {
          name: 'mk4',
          buildVolume: { x: 250, y: 210, z: 220 },
          api: 'octoprint',
          address: 'http://octopi.local',
        },
        'mk4-key',
      ),
    );
  });

  // Typed by a person at a machine, where a trailing space is invisible and a directory named with
  // one is not the directory they meant.
  it('trims what was typed around the edges', async () => {
    takesIt.mockResolvedValue(undefined);
    open();
    describeAnMk4();
    type('name', '  mk4  ');

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() => expect(takesIt).toHaveBeenCalledWith(expect.objectContaining({ name: 'mk4' }), 'mk4-key'));
  });

  it('closes once the shop has taken it', async () => {
    takesIt.mockResolvedValue(undefined);
    open();
    describeAnMk4();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'add a printer' })).toBeDefined());
  });

  // The far end is what knows WHY - a name that becomes a directory, an address no printer is at.
  it("stays open with the shop's own words when it is refused", async () => {
    takesIt.mockRejectedValue(new Error('"mk4/2" is not a name a printer can have - it becomes a directory'));
    open();
    describeAnMk4();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() => expect(screen.getByText(/it becomes a directory/)).toBeDefined());
    expect(screen.getByLabelText('name', { exact: false })).toBeDefined();
  });

  // What was typed is still there to correct, rather than a form somebody has to fill in twice.
  it('keeps what was typed when it is refused', async () => {
    takesIt.mockRejectedValue(new Error('no'));
    open();
    describeAnMk4();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    await waitFor(() => expect(screen.getByText('no')).toBeDefined());
    expect((screen.getByLabelText('name', { exact: false }) as HTMLInputElement).value).toBe('mk4');
  });

  it('forgets what was typed when somebody gives up on it', () => {
    open();
    describeAnMk4();

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'add a printer' }));

    expect((screen.getByLabelText('name', { exact: false }) as HTMLInputElement).value).toBe('');
  });

  // Only what the form can know by itself; everything past this is the shop's to judge and it says
  // so better than this could.
  describe('what it will not send at all', () => {
    const addIsOffered = (): boolean => !(screen.getByRole('button', { name: 'add' }) as HTMLButtonElement).disabled;

    it('offers to add one once every field is filled', () => {
      open();
      describeAnMk4();

      expect(addIsOffered()).toBe(true);
    });

    it.each([
      ['name', ' '],
      ['address', ' '],
      ['api key', ' '],
      ['width', ''],
      ['depth', '0'],
      ['height', 'tall'],
      ['width', '-5'],
    ])('does not offer to add one whose %s is %p', (field, said) => {
      open();
      describeAnMk4();
      type(field, said);

      expect(addIsOffered()).toBe(false);
    });
  });
});
