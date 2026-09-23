import { describe, it, expect } from '@jest/globals';
import { Toolpath } from '../src/Toolpath';
import type { Bead } from '../src/Toolpath';

function laid(lines: string[]): Bead[] {
  const toolpath = new Toolpath();
  lines.forEach((line) => toolpath.follow(line));

  return toolpath.beads();
}

describe('where a plate lays plastic', () => {
  it('is where the nozzle moved while extruding, and not where it only travelled', () => {
    expect(laid(['G1 X10 Y10', 'G1 X20 Y10 E1', 'G1 X20 Y20', 'G1 X30 Y20 E2'])).toEqual([
      [10, 10, 0, 20, 10, 0],
      [20, 20, 0, 30, 20, 0],
    ]);
  });

  it('takes a retraction for what it is when extrusion is absolute', () => {
    expect(laid(['M82', 'G1 X10 E5', 'G1 X20 E4', 'G1 X30 E6'])).toHaveLength(2);
  });

  it('counts every positive length as plastic when extrusion is relative', () => {
    expect(laid(['M83', 'G1 X10 E1', 'G1 X20 E1', 'G1 X30 E-1', 'G1 X40 E1'])).toHaveLength(3);
  });

  it('starts counting again from where G92 says the extruder is', () => {
    expect(laid(['M82', 'G1 X10 E5', 'G92 E0', 'G1 X20 E1'])).toHaveLength(2);
  });

  it('moves relative to where it is after G91', () => {
    expect(laid(['G91', 'M83', 'G1 X10 E1', 'G1 X10 Y5 E1'])).toEqual([
      [0, 0, 0, 10, 0, 0],
      [10, 0, 0, 20, 5, 0],
    ]);
  });

  it('takes extrusion as absolute again after G90, as it was before G91', () => {
    expect(laid(['G91', 'G90', 'G1 X10 E1', 'G1 X20 E1'])).toHaveLength(1);
  });

  it('starts from the origin again after homing', () => {
    expect(laid(['G1 X50 Y50', 'G28', 'M83', 'G1 X10 E1'])).toEqual([[0, 0, 0, 10, 0, 0]]);
  });

  it('homes only the axes it names', () => {
    expect(laid(['G1 X50 Y50', 'G28 X', 'M83', 'G1 X60 E1'])).toEqual([[0, 50, 0, 60, 50, 0]]);
  });

  it('passes over a value that is not a number', () => {
    expect(laid(['G1 X10', 'M83', 'G1 Xabc Y5 E1'])).toEqual([[10, 0, 0, 10, 5, 0]]);
  });

  it('lays nothing for plastic pushed without moving', () => {
    expect(laid(['M83', 'G1 X10 E1', 'G1 E2', 'G1 X20 E1'])).toHaveLength(2);
  });

  describe('an arc', () => {
    const halfwayAround = (command: string): number => {
      const beads = laid(['G1 X10 Y0', `${command} X-10 Y0 I-10 J0 E1`]);
      return beads[Math.floor(beads.length / 2)]?.[1] ?? 0;
    };

    it('follows its centre rather than cutting across', () => {
      const beads = laid(['G1 X10 Y0', 'G3 X-10 Y0 I-10 J0 E1']);

      expect(beads.length).toBeGreaterThan(4);
      beads.forEach(([x, y]) => expect(Math.hypot(x, y)).toBeCloseTo(10));
    });

    it('goes all the way round when it ends where it began', () => {
      const clockwise = laid(['G1 X10 Y0', 'G2 X10 Y0 I-10 J0 E1']);
      const anticlockwise = laid(['G1 X10 Y0', 'G3 X10 Y0 I-10 J0 E1']);

      [clockwise, anticlockwise].forEach((beads) => expect(Math.min(...beads.map(([x]) => x))).toBeCloseTo(-10));
    });

    it('climbs evenly when it changes height on the way', () => {
      const beads = laid(['G1 X10 Y0 Z1', 'G3 X-10 Y0 I-10 J0 Z2 E1']);

      expect(beads[0]?.[5]).toBeGreaterThan(1);
      expect(beads[0]?.[5]).toBeLessThan(1.5);
      expect(beads[beads.length - 1]?.[5]).toBe(2);
    });

    it('leaves the nozzle where it ended', () => {
      const beads = laid(['M83', 'G1 X10 Y0', 'G3 X-10 Y0 I-10 J0 E1', 'G1 X-10 Y-5 E1']);
      const [x = NaN, y = NaN] = beads[beads.length - 1] ?? [];

      expect(x).toBe(-10);
      expect(y).toBeCloseTo(0);
    });

    it('turns the way its command says', () => {
      expect(halfwayAround('G3')).toBeGreaterThan(5);
      expect(halfwayAround('G2')).toBeLessThan(-5);
    });
  });

  describe('the part, as against what the first layer laid around it', () => {
    const part = ['M83', 'G1 Z0.2', 'G1 X100 Y100', 'G1 X110 Y100 E1', 'G1 Z0.4', 'G1 X100 Y100 E1'];

    it('leaves out what the first layer laid down away from the part, like a purge line', () => {
      expect(laid([...part, 'G1 Z0.2', 'G1 X0 Y0', 'G1 X50 Y0 E1'])).toEqual(laid(part));
    });

    it('counts first-layer plastic within a millimetre of the part as the part, and all of a bead or none of it', () => {
      const beside = ['G1 Z0.2', 'G1 X100 Y100.5', 'G1 X110 Y100.5 E1'];
      const tooFar = ['G1 X100 Y102', 'G1 X110 Y102 E1'];
      const leaving = ['G1 X105 Y100', 'G1 X105 Y90 E1'];

      expect(laid([...part, ...beside, ...tooFar, ...leaving])).toEqual([...laid(part), [100, 100.5, 0.2, 110, 100.5, 0.2]]);
    });

    it('is all of a plate one layer tall', () => {
      expect(laid(['M83', 'G1 X100 Y100', 'G1 X110 Y100 E1', 'G1 X0 Y0', 'G1 X50 Y0 E1'])).toHaveLength(2);
    });
  });

  describe('a print too long to keep every bead of', () => {
    it('keeps a bounded number of them', () => {
      const beads = laid(['M83', ...Array.from({ length: 450_000 }, (_, at) => `G1 X${at % 2 === 0 ? 0 : 1} E0.1`)]);

      expect(beads.length).toBeLessThanOrEqual(200_000);
      expect(beads.length).toBeGreaterThan(100_000);
    });

    it('samples the whole print evenly rather than favouring either end of it', () => {
      const beads = laid(['M83', ...Array.from({ length: 450_000 }, (_, at) => `G1 X${at} E0.1`)]);
      const firstHalf = beads.filter(([, , , x2]) => x2 < 225_000).length;

      expect(Math.max(...beads.map(([, , , x2]) => x2).slice(-10))).toBeGreaterThan(440_000);
      expect(firstHalf / beads.length).toBeCloseTo(0.5, 1);
    });
  });
});
