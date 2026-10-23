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
  // AIDEV-NOTE: one act at the shop - `resume` - offered under the name of what it lifts. The shop waits
  // for a person after a machine refuses a plate, because asking again re-sends a whole plate for the
  // same no; and a stop is a person's to lift. This is that person, without a terminal.
  describe('the way to let one take work again', () => {
    const starts = jest.fn<(name: string) => Promise<void>>();
    const button = (name: string): HTMLElement | null => screen.queryByRole('button', { name });
    const refused = { reason: 'Prusa Mk4 refused the file', since: new Date('2026-10-17T09:00:00Z') };
    const paused = { reason: 'clearing the bed', since: new Date('2026-10-17T09:30:00Z') };

    beforeEach(() => {
      starts.mockReset();
      starts.mockResolvedValue(undefined);
    });

    const starting = (on: RegisteredPrinter): void => {
      render(<PrinterGallery printers={[on]} onSelect={nobodyChooses} onStart={starts} />);
    };

    it.each([
      ['Start mk4', { paused }],
      ['Try mk4 again', { refused }],
    ])('is %s, and asks the shop to start that printer', async (name, trouble) => {
      starting(printer('mk4', trouble));

      fireEvent.click(screen.getByRole('button', { name }));

      await waitFor(() => expect(starts).toHaveBeenCalledWith('mk4'));
    });

    it('is not offered on a printer nothing is holding back', () => {
      starting(printer('mk4'));

      expect([button('Start mk4'), button('Try mk4 again')]).toEqual([null, null]);
    });

    // The stop is what somebody has to know they are lifting.
    it('is Start, and not Try again, on a refused printer somebody also stopped', () => {
      starting(printer('mk4', { refused, paused }));

      expect(button('Start mk4')).not.toBeNull();
      expect(button('Try mk4 again')).toBeNull();
    });

    it('is not offered to a caller who was given no way to start one', () => {
      render(<PrinterGallery printers={[printer('mk4', { paused })]} onSelect={nobodyChooses} />);

      expect(button('Start mk4')).toBeNull();
    });

    it('says what the shop said when it will not', async () => {
      starts.mockRejectedValue(new Error('the shop has no printer named mk4'));
      starting(printer('mk4', { refused }));

      fireEvent.click(screen.getByRole('button', { name: 'Try mk4 again' }));

      await waitFor(() => expect(screen.getByText('the shop has no printer named mk4')).toBeDefined());
    });
  });

  describe('the way to stop one', () => {
    const stops = jest.fn<(name: string, reason: string) => Promise<void>>();
    const stopButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Stop mk4' });

    const stopping = (on: RegisteredPrinter): void => {
      render(<PrinterGallery printers={[on]} onSelect={nobodyChooses} onStop={stops} />);
    };

    it('asks why, about only the printer asked about', () => {
      render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} onSelect={nobodyChooses} onStop={stops} />);

      fireEvent.click(screen.getByRole('button', { name: 'Stop mk4' }));

      expect(screen.getByRole('dialog', { name: 'Stop mk4' })).toBeDefined();
      expect(screen.queryByRole('dialog', { name: 'Stop mini' })).toBeNull();
    });

    it('is not offered on a printer already stopped', () => {
      stopping(printer('mk4', { paused: { reason: 'clearing the bed', since: new Date('2026-10-17T09:30:00Z') } }));

      expect(stopButton()).toBeNull();
    });

    it('is not offered to a caller who was given no way to stop one', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      expect(stopButton()).toBeNull();
    });
  });

  describe('the way to load one', () => {
    const loads = jest.fn<(name: string, filaments: string[]) => Promise<void>>();
    const known = jest.fn<() => Promise<string[]>>();
    const dialog = (name: string): HTMLElement | null => screen.queryByRole('dialog', { name: `Load ${name}` });
    const field = (): HTMLSelectElement => screen.getByLabelText('Filament loaded') as HTMLSelectElement;
    const offered = (): string[] => [...field().options].map((option) => option.text);
    const chosen = (): string | undefined => field().selectedOptions[0]?.text;

    beforeEach(() => {
      loads.mockReset();
      loads.mockResolvedValue(undefined);
      known.mockReset();
      known.mockResolvedValue(['PETG-Black', 'PLA-Red']);
    });

    const loading = (on: RegisteredPrinter): void => {
      render(<PrinterGallery printers={[on]} onSelect={nobodyChooses} onLoad={loads} known={known} />);
      fireEvent.click(screen.getByRole('button', { name: `Load ${on.name}` }));
    };

    async function choosing(text: string): Promise<void> {
      await waitFor(() => expect(offered()).toContain(text));
      const option = [...field().options].find((offer) => offer.text === text);
      fireEvent.change(field(), { target: { value: option?.value } });
    }

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

    // A machine that paused itself mid-print - for a colour change, say - is waiting for exactly this.
    it.each([
      ['printing', { job: 1, phase: 'printing' }, true],
      ['paused by the machine', { job: 1, phase: 'printing', machinePausedSince: new Date('2026-10-18T18:00:00Z') }, false],
      ['awaiting a verdict', { job: 1, phase: 'awaiting-approval' }, false],
    ] as const)('is disabled only while the machine is actively printing - %s', (_what, holding, disabled) => {
      render(<PrinterGallery printers={[printer('mk4', { holding })]} onSelect={nobodyChooses} onLoad={loads} />);

      expect((screen.getByRole('button', { name: 'Load mk4' }) as HTMLButtonElement).disabled).toBe(disabled);
    });

    it('offers nothing, every filament the shop knows, and a new one', async () => {
      loading(printer('mk4'));

      await waitFor(() => expect(offered()).toEqual(['<Nothing>', 'PETG-Black', 'PLA-Red', '<New Filament>']));
    });

    it('starts from what is on the machine, before the shop has even answered', () => {
      known.mockReturnValue(new Promise<string[]>(() => undefined));
      loading(printer('mk4', { loaded: ['PLA-Gray'] }));

      expect(chosen()).toBe('PLA-Gray');
    });

    it('starts from nothing on an empty machine', () => {
      loading(printer('mk4'));

      expect(chosen()).toBe('<Nothing>');
    });

    it('puts the chosen filament, and only it, on the machine, and closes once it is taken', async () => {
      loading(printer('mk4'));
      await choosing('PETG-Black');

      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(dialog('mk4')).toBeNull());
      expect(loads).toHaveBeenCalledWith('mk4', ['PETG-Black']);
    });

    it('takes everything off the machine when nothing is chosen', async () => {
      loading(printer('mk4', { loaded: ['PLA-Red'] }));
      await choosing('<Nothing>');

      fireEvent.click(screen.getByRole('button', { name: 'Load' }));

      await waitFor(() => expect(loads).toHaveBeenCalledWith('mk4', []));
    });

    describe('a new filament', () => {
      const name = (): HTMLInputElement | null => screen.queryByLabelText('New filament name');

      it('is not asked for until one is chosen', () => {
        loading(printer('mk4'));

        expect(name()).toBeNull();
      });

      it('loads by the name it is given', async () => {
        loading(printer('mk4'));
        await choosing('<New Filament>');
        fireEvent.change(name()!, { target: { value: ' PLA-Teal ' } });

        fireEvent.click(screen.getByRole('button', { name: 'Load' }));

        await waitFor(() => expect(loads).toHaveBeenCalledWith('mk4', ['PLA-Teal']));
      });

      it('cannot be loaded without a name', async () => {
        loading(printer('mk4'));
        await choosing('<New Filament>');
        fireEvent.change(name()!, { target: { value: '  ' } });

        expect((screen.getByRole('button', { name: 'Load' }) as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('says why when the shop will not say what it knows', async () => {
      known.mockRejectedValue(new Error('GET /filaments/known is for an admin'));
      loading(printer('mk4'));

      await waitFor(() => expect(screen.getByText('GET /filaments/known is for an admin')).toBeDefined());
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

    // A window left in the background stops drawing the stream, and says nothing about it.
    describe('when the page is looked at again', () => {
      const pageIs = (state: DocumentVisibilityState): void => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
        act(() => void document.dispatchEvent(new Event('visibilitychange')));
      };

      afterEach(() => {
        jest.useRealTimers();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      });

      it('asks for the stream afresh, at the address the shop gave', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);
        const first = screen.getByRole('img').getAttribute('src');

        pageIs('hidden');
        pageIs('visible');

        expect(screen.getByRole('img').getAttribute('src')).not.toBe(first);
        expect(screen.getByRole('img').getAttribute('src')).toContain('action=stream');
      });

      it('leaves it alone for being put in the background', () => {
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);
        const first = screen.getByRole('img').getAttribute('src');

        pageIs('hidden');

        expect(screen.getByRole('img').getAttribute('src')).toBe(first);
      });

      it('tries again on a camera it had given up on', () => {
        jest.useFakeTimers();
        render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);
        for (let attempt = 0; attempt < TRIES; attempt += 1) {
          act(() => void fireEvent.error(screen.getByRole('img')));
          act(() => void jest.advanceTimersByTime(BEFORE_TRYING_AGAIN_MS));
        }

        pageIs('visible');

        expect(screen.getByRole('img')).toBeDefined();
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
