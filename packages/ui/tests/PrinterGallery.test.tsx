import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';
import { PrinterGallery, stillHere } from '../src/components/PrinterGallery';

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

    // The ordinary state of a machine that is switched off, rather than a fault worth shouting about.
    it('says so when the machine does not answer', () => {
      render(<PrinterGallery printers={[printer('mk4')]} onSelect={nobodyChooses} />);

      fireEvent.error(screen.getByRole('img'));

      expect(screen.getByText('no picture')).toBeDefined();
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
