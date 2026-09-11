import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    const takesIt = jest.fn<(record: PrinterRecord) => Promise<void>>();
    const addsOne = (): HTMLElement | null => screen.queryByRole('button', { name: 'add a printer' });

    it('is not offered to a caller who was given no way to add one', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      expect(addsOne()).toBeNull();
    });

    it('is offered beside the machines to a caller who was', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} onAdd={takesIt} />);

      expect(addsOne()).not.toBeNull();
    });

    // The emptiest shop is where it matters most, and the one place the old wording sent somebody
    // to a terminal instead.
    it('is offered in a shop with no printers at all', () => {
      render(<PrinterGallery printers={[]} onSelect={nobodyChooses} onAdd={takesIt} />);

      expect(addsOne()).not.toBeNull();
    });

    // It comes after them: what an operator is looking at is the machines, not the way to add one.
    it('comes after the machines rather than before them', () => {
      render(<PrinterGallery printers={[printer('mk4'), printer('mini')]} onSelect={nobodyChooses} onAdd={takesIt} />);

      const last = screen.getAllByRole('button').at(-1);

      expect(last?.getAttribute('aria-label')).toBe('add a printer');
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
      beforeEach(() => jest.useFakeTimers());
      afterEach(() => jest.useRealTimers());

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
