import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { PrinterGallery, stillHere } from '../src/components/PrinterGallery';
import { BEFORE_TRYING_AGAIN_MS, TRIES } from '../src/components/PrinterTile';

describe('the gallery of printers', () => {
  afterEach(cleanup);

  function printer(name: string, overrides: Partial<RegisteredPrinter> = {}): RegisteredPrinter {
    return {
      name,
      buildVolume: { x: 250, y: 210, z: 220 },
      api: 'octoprint',
      address: `http://${name}`,
      camera: `http://${name}/webcam/?action=stream`,
      loaded: [],
      ...overrides,
    };
  }

  const nobodyChooses = jest.fn<(name: string) => void>();

  it('says how a printer gets here when there are none', () => {
    render(<PrinterGallery printers={[]} onSelect={nobodyChooses} />);

    expect(screen.getByText(/printer add/)).toBeDefined();
  });

  // AIDEV-NOTE: adding a printer is an admin's, and the page is told which the caller is rather than
  // offering it to everybody and letting the shop's 403 teach them. The shop refuses either way -
  // withholding the button is manners, not the guard.
  describe('the way to add one', () => {
    const takesIt = jest.fn<(record: PrinterRecord, key: string | undefined) => Promise<void>>();
    const addsOne = (): HTMLElement | null => screen.queryByRole('button', { name: 'Add a printer' });

    it('is not offered to a caller who was given no way to add one', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      expect(addsOne()).toBeNull();
    });

    it('is offered beside the machines to a caller who was', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={takesIt} />);

      expect(addsOne()).not.toBeNull();
    });

    // The emptiest shop is where it matters most, and the one place the old wording sent somebody
    // to a terminal instead.
    it('is offered in a shop with no printers at all', () => {
      render(<PrinterGallery printers={[]} onSelect={nobodyChooses} onSave={takesIt} />);

      expect(addsOne()).not.toBeNull();
    });

    // It comes after them: what an operator is looking at is the machines, not the way to add one.
    it('comes after the machines rather than before them', () => {
      render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} onSelect={nobodyChooses} onSave={takesIt} />);

      const last = screen.getAllByRole('button').at(-1);

      expect(last?.getAttribute('aria-label')).toBe('Add a printer');
    });
  });

  // AIDEV-NOTE: changing a printer is an admin's for the same reason adding one is, and is offered
  // on the same terms - see 'the way to add one' above.
  describe('the way to change one', () => {
    const saves = jest.fn<(record: PrinterRecord, key: string | undefined) => Promise<void>>();
    const editButton = (name: string): HTMLElement | null => screen.queryByRole('button', { name: `Edit ${name}` });

    beforeEach(() => {
      saves.mockResolvedValue(undefined);
    });

    it('is not offered to a caller who was given no way to change one', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      expect(editButton('mk4')).toBeNull();
    });

    const dialog = (name: string): HTMLElement | null => screen.queryByRole('dialog', { name: `Edit ${name}` });

    it('opens a dialog about only the printer asked about', () => {
      render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} onSelect={nobodyChooses} onSave={saves} />);

      fireEvent.click(screen.getByRole('button', { name: 'Edit mini' }));

      expect(dialog('mini')).not.toBeNull();
      expect(dialog('mk4')).toBeNull();
      expect((screen.getByLabelText('address', { exact: false }) as HTMLInputElement).value).toBe('http://mini');
    });

    // The machine being changed stays in view behind it, camera and all.
    it('leaves the tile where it was', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={saves} />);

      fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));

      expect(screen.getByRole('img', { name: 'mk4 now' })).toBeDefined();
    });

    it('is not choosing the printer', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={saves} />);

      fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));

      expect(nobodyChooses).not.toHaveBeenCalled();
    });

    it('hands the shop what was changed, and closes once it is taken', async () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={saves} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));
      fireEvent.change(screen.getByLabelText('address', { exact: false }), { target: { value: 'http://mk4.home' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(dialog('mk4')).toBeNull());
      expect(saves).toHaveBeenCalledWith(expect.objectContaining({ name: 'mk4', address: 'http://mk4.home' }), undefined);
    });

    it('closes, changing nothing, when somebody gives up on it', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={saves} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(dialog('mk4')).toBeNull();
      expect(saves).not.toHaveBeenCalled();
    });

    it('closes, changing nothing, on Escape', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onSave={saves} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit mk4' }));

      fireEvent.keyDown(screen.getByLabelText('address', { exact: false }), { key: 'Escape' });

      expect(dialog('mk4')).toBeNull();
      expect(saves).not.toHaveBeenCalled();
    });
  });

  // AIDEV-NOTE: what is on a machine is an admin's to say, offered on the same terms as Edit.
  // AIDEV-NOTE: the shop waits for a person after a machine refuses a plate, because asking again
  // re-sends a whole plate for the same no. This is that person, without a terminal.
  describe('the way to try a refused one again', () => {
    const retries = jest.fn<(name: string) => Promise<void>>();
    const tryAgain = (name: string): HTMLElement | null => screen.queryByRole('button', { name: `Try ${name} again` });
    const refused = { reason: 'Prusa Mk4 refused the file', since: new Date('2026-10-17T09:00:00Z') };

    beforeEach(() => {
      retries.mockReset();
      retries.mockResolvedValue(undefined);
    });

    const retrying = (on: RegisteredPrinter): void => {
      render(<PrinterGallery printers={[on]} onSelect={nobodyChooses} onRetry={retries} />);
    };

    it('asks the shop to try that printer again', async () => {
      retrying(printer('mk4', { refused }));

      fireEvent.click(screen.getByRole('button', { name: 'Try mk4 again' }));

      await waitFor(() => expect(retries).toHaveBeenCalledWith('mk4'));
    });

    it('is not offered on a printer nothing refused', () => {
      retrying(printer('mk4'));

      expect(tryAgain('mk4')).toBeNull();
    });

    // Trying again is lifting what is held against the machine, and a person's stop is not this
    // button's to lift.
    it('is not offered on a refused printer somebody also stopped', () => {
      retrying(printer('mk4', { refused, paused: { reason: 'clearing the bed', since: new Date('2026-10-17T09:30:00Z') } }));

      expect(tryAgain('mk4')).toBeNull();
    });

    it('is not offered to a caller who was given no way to try again', () => {
      render(<PrinterGallery printers={[printer('mk4', { refused })]} onSelect={nobodyChooses} />);

      expect(tryAgain('mk4')).toBeNull();
    });

    it('says what the shop said when it will not', async () => {
      retries.mockRejectedValue(new Error('the shop has no printer named mk4'));
      retrying(printer('mk4', { refused }));

      fireEvent.click(screen.getByRole('button', { name: 'Try mk4 again' }));

      await waitFor(() => expect(screen.getByText('the shop has no printer named mk4')).toBeDefined());
    });
  });

  describe('the way to load one', () => {
    const loads = jest.fn<(name: string, filaments: string[]) => Promise<void>>();
    const dialog = (name: string): HTMLElement | null => screen.queryByRole('dialog', { name: `Load ${name}` });
    const field = (): HTMLInputElement => screen.getByLabelText('Filament loaded') as HTMLInputElement;

    beforeEach(() => {
      loads.mockReset();
      loads.mockResolvedValue(undefined);
    });

    const loading = (on: RegisteredPrinter, waitingFor: string[] = []): void => {
      render(<PrinterGallery printers={[on]} onSelect={nobodyChooses} onLoad={loads} waitingFor={waitingFor} />);
      fireEvent.click(screen.getByRole('button', { name: `Load ${on.name}` }));
    };

    it('is not offered to a caller who was given no way to load one', () => {
      render(
        <PrinterGallery
          printers={[printer('mk4')]}
          onSelect={nobodyChooses}
          onSave={jest.fn<(record: PrinterRecord, key: string | undefined) => Promise<void>>()}
        />,
      );

      expect(screen.queryByRole('button', { name: 'Load mk4' })).toBeNull();
    });

    it.each([
      ['printing', true],
      ['awaiting-approval', false],
    ] as const)('is disabled only while the machine is printing - %s', (phase, disabled) => {
      render(<PrinterGallery printers={[printer('mk4', { holding: { job: 1, phase } })]} onSelect={nobodyChooses} onLoad={loads} />);

      expect((screen.getByRole('button', { name: 'Load mk4' }) as HTMLButtonElement).disabled).toBe(disabled);
    });

    it('starts from what is on the machine now', () => {
      loading(printer('mk4', { loaded: ['PLA', 'PETG'] }));

      expect(field().value).toBe('PLA, PETG');
    });

    // The shop matches by exact name, so the names worth typing are the ones queued work waits for.
    it('suggests what queued work is waiting for', () => {
      loading(printer('mk4'), ['PLA', 'PETG-Black']);

      const suggested = [...(field().list?.options ?? [])].map((option) => option.value);

      expect(suggested).toEqual(['PLA', 'PETG-Black']);
    });

    it('hands the shop each filament typed, in order, and closes once it is taken', async () => {
      loading(printer('mk4'));
      fireEvent.change(field(), { target: { value: ' PLA ,, PETG ' } });

      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(dialog('mk4')).toBeNull());
      expect(loads).toHaveBeenCalledWith('mk4', ['PLA', 'PETG']);
    });

    it('takes everything off the machine when nothing is typed', async () => {
      loading(printer('mk4', { loaded: ['PLA'] }));
      fireEvent.change(field(), { target: { value: '  ' } });

      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(loads).toHaveBeenCalledWith('mk4', []));
    });

    it('stays open with what the shop said when it will not', async () => {
      loads.mockRejectedValue(new Error('the shop has no printer named mk4'));
      loading(printer('mk4'));

      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(screen.getByText('the shop has no printer named mk4')).toBeDefined());
      expect(dialog('mk4')).not.toBeNull();
    });

    it('closes, changing nothing, when somebody gives up on it', () => {
      loading(printer('mk4'));

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(dialog('mk4')).toBeNull();
      expect(loads).not.toHaveBeenCalled();
    });

    it('closes, changing nothing, on Escape', () => {
      loading(printer('mk4'));

      fireEvent.keyDown(field(), { key: 'Escape' });

      expect(dialog('mk4')).toBeNull();
      expect(loads).not.toHaveBeenCalled();
    });
  });

  it('shows one tile for each machine', () => {
    render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} onSelect={nobodyChooses} />);

    expect(screen.getAllByRole('button').map((tile) => tile.textContent)).toEqual([
      expect.stringContaining('mk4'),
      expect.stringContaining('mini'),
    ]);
  });

  it('marks the selected one, and only it', () => {
    render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} selected="mini" onSelect={nobodyChooses} />);

    expect(screen.getAllByRole('button').map((tile) => tile.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('says which was chosen when one is clicked', () => {
    const chooses = jest.fn<(name: string) => void>();
    render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} selected="mk4" onSelect={chooses} />);

    fireEvent.click(screen.getAllByRole('button')[1]);

    expect(chooses).toHaveBeenCalledWith('mini');
  });

  describe('the camera on a tile', () => {
    it('is the picture the shop said where to find', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      expect(screen.getByRole('img').getAttribute('src')).toBe('http://mk4/webcam/?action=stream');
    });

    // A machine whose protocol says nothing about one. The tile is still a tile.
    it('says so when the shop named none', () => {
      render(<PrinterGallery printers={[printer('mk4', { camera: undefined })]} onSelect={nobodyChooses} />);

      expect(screen.queryByRole('img')).toBeNull();
      expect(screen.getByText('no camera')).toBeDefined();
    });

    // AIDEV-NOTE: a stream has more ways of failing once than of being unavailable - a machine still
    // booting, a connection dropped, a moment when something else had it. Giving up on the first
    // left a tile saying "no picture" at a working camera until somebody reloaded the page.
    describe('when a try fails', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });
      afterEach(() => {
        jest.useRealTimers();
      });

      const andWait = (): void => act(() => void jest.advanceTimersByTime(BEFORE_TRYING_AGAIN_MS));

      const failed = (): void => {
        act(() => void fireEvent.error(screen.getByRole('img')));
        andWait();
      };

      it('tries again rather than giving up', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

        failed();

        expect(screen.getByRole('img')).toBeDefined();
      });

      // The same URL would not be fetched again - a browser that has just failed one has it cached
      // as a failure - so each try has to be a different one.
      it('asks for something the browser has not already failed', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);
        const first = screen.getByRole('img').getAttribute('src');

        failed();

        expect(screen.getByRole('img').getAttribute('src')).not.toBe(first);
      });

      // A camera whose address already carries a query keeps it.
      it('keeps the address the shop gave it', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

        failed();

        expect(screen.getByRole('img').getAttribute('src')).toContain('action=stream');
      });

      it('waits before trying again rather than hammering the machine', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);
        const first = screen.getByRole('img').getAttribute('src');

        act(() => void fireEvent.error(screen.getByRole('img')));

        expect(screen.getByRole('img').getAttribute('src')).toBe(first);
      });

      // It does stop: a camera that is really not there must not be asked for ever.
      it('says so once enough of them have failed', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

        for (let attempt = 0; attempt < TRIES; attempt += 1) failed();

        expect(screen.queryByRole('img')).toBeNull();
        expect(screen.getByText('no picture')).toBeDefined();
      });
    });
  });

  describe('what a tile says about the machine', () => {
    it('is what it is doing, and what somebody has to know', () => {
      const stopped = printer('mk4', { paused: { reason: 'the door is open', since: new Date() } });
      render(<PrinterGallery printers={[stopped]} onSelect={nobodyChooses} />);

      expect(screen.getByText('stopped')).toBeDefined();
      expect(screen.getByText('the door is open')).toBeDefined();
    });

    it('is what is on the machine, or that there is nothing', () => {
      render(<PrinterGallery printers={[printer('mk4', { loaded: ['PLA-Red'] }), printer('mini')]} onSelect={nobodyChooses} />);

      expect(screen.getByText('PLA-Red')).toBeDefined();
      expect(screen.getByText('nothing loaded')).toBeDefined();
    });
  });

  // AIDEV-NOTE: a wall display that forgot which machine it was showing on every reload would be
  // worse than useless, and a name that is no longer here must not leave it showing nothing.
  describe('which one is selected to begin with', () => {
    const two = [printer('mk4'), printer('mini')];

    it('is the one it was last showing', () => {
      expect(stillHere(two, 'mini')).toBe('mini');
    });

    it('is the first when nothing was remembered', () => {
      expect(stillHere(two, undefined)).toBe('mk4');
    });

    it('is the first when the remembered one has been taken out of the shop', () => {
      expect(stillHere(two, 'gone')).toBe('mk4');
    });

    it('is nothing at all when the shop has no printers', () => {
      expect(stillHere([], 'mk4')).toBeUndefined();
    });
  });
});
