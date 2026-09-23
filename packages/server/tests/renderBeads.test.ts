import { describe, it, expect } from '@jest/globals';
import { RENDER_PX, renderBeads } from '../src/renderBeads';
import type { Image } from '../src/renderBeads';
import type { Bead } from '../src/Toolpath';

type Pixel = [r: number, g: number, b: number, a: number];

function pixel({ width, rgba }: Image, x: number, y: number): Pixel {
  const at = (y * width + x) * 4;
  return [...rgba.subarray(at, at + 4)] as Pixel;
}

const brightness = ([r, g, b]: Pixel): number => r + g + b;

/** Every pixel with any plastic in it, as [x, y]. */
function covered(image: Image): [number, number][] {
  const found: [number, number][] = [];
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if ((pixel(image, x, y)[3] ?? 0) > 0) found.push([x, y]);
  return found;
}

/** The rows a column is opaque in, top to bottom. */
function opaqueRows(image: Image, x: number): number[] {
  return Array.from({ length: image.height }, (_, y) => y).filter((y) => pixel(image, x, y)[3] === 255);
}

// AIDEV-NOTE: the view is isometric from the bed's front-left corner, so a bead running along x=-y
// lies level across the picture and one along x=y runs straight up it. Every bead below is built on
// those two directions so that where it lands on the picture can be found without the projection.
const across = (z: number): Bead => [-5, 5, z, 5, -5, z];
const upAndDown = (z: number): Bead => [-5, -5, z, 5, 5, z];

describe('a render of the beads a plate laid', () => {
  it('is one transparent pixel when there is nothing to draw', () => {
    expect(renderBeads([])).toEqual({ width: 1, height: 1, rgba: new Uint8Array(4) });
  });

  it('is the size it renders at along its longer side, and in proportion along the other', () => {
    const wide = renderBeads([across(0)]);
    const tall = renderBeads([upAndDown(0)]);

    expect(wide.width).toBe(RENDER_PX);
    expect(wide.height).toBeLessThan(RENDER_PX / 4);
    expect(tall.height).toBe(RENDER_PX);
    expect(tall.width).toBeLessThan(RENDER_PX / 4);
  });

  it('is plastic along a bead and transparent away from it', () => {
    const image = renderBeads([across(0)]);
    const middle = Math.floor(image.width / 2);
    const rows = opaqueRows(image, middle);

    expect(rows.length).toBeGreaterThan(0);
    expect(pixel(image, middle, 0)[3]).toBe(0);
    expect(pixel(image, middle, image.height - 1)[3]).toBe(0);
  });

  it('lights a bead from above, leaving its lower side in shadow', () => {
    const image = renderBeads([across(0)]);
    const middle = Math.floor(image.width / 2);
    const rows = opaqueRows(image, middle);
    const quarter = Math.floor(rows.length / 4);
    const upper = brightness(pixel(image, middle, rows[quarter] ?? 0));
    const lower = brightness(pixel(image, middle, rows[rows.length - 1 - quarter] ?? 0));

    expect(lower).toBeLessThan(0.6 * upper);
  });

  // The higher bead is a short one, so a column near the edge of the picture finds the lower alone.
  it('draws a higher bead higher up the picture', () => {
    const image = renderBeads([across(0), [-1, 1, 5, 1, -1, 5]]);
    const lowerAlone = opaqueRows(image, Math.floor(image.width / 10));

    expect(lowerAlone.length).toBeGreaterThan(0);
    lowerAlone.forEach((row) => expect(row).toBeGreaterThan(image.height / 2));
  });

  it('rounds the ends of a bead', () => {
    const plastic = covered(renderBeads([across(0)]));
    const [left, top] = [Math.min(...plastic.map(([x]) => x)), Math.min(...plastic.map(([, y]) => y))];
    const [right, bottom] = [Math.max(...plastic.map(([x]) => x)), Math.max(...plastic.map(([, y]) => y))];
    const plasticAt = new Set(plastic.map(([x, y]) => `${x},${y}`));

    [`${left},${top}`, `${right},${top}`, `${left},${bottom}`, `${right},${bottom}`].forEach((corner) =>
      expect(plasticAt.has(corner)).toBe(false),
    );
  });

  it('softens its edges into what is behind it', () => {
    const image = renderBeads([across(0)]);

    expect(covered(image).some(([x, y]) => (pixel(image, x, y)[3] ?? 0) < 255)).toBe(true);
  });

  describe('where two beads cross', () => {
    // Beside the upright bead rather than on it, so what is found there is the level bead alone.
    function crossing(image: Image): { onTheCrossing: Pixel; besideIt: Pixel } {
      const middle = Math.floor(image.width / 2);
      const beside = middle + Math.floor(image.width / 8);
      const rows = opaqueRows(image, beside);
      const row = rows[Math.floor(rows.length / 4)] ?? 0;

      return { onTheCrossing: pixel(image, middle, row), besideIt: pixel(image, beside, row) };
    }

    it('shows the nearer one, though it was drawn first', () => {
      const { onTheCrossing, besideIt } = crossing(renderBeads([across(1), upAndDown(0)]));

      onTheCrossing.forEach((channel, at) => expect(Math.abs(channel - (besideIt[at] ?? 0))).toBeLessThanOrEqual(2));
    });

    it('shows the upright one where that one is the nearer', () => {
      const { onTheCrossing, besideIt } = crossing(renderBeads([across(0), upAndDown(1)]));

      expect(Math.abs(brightness(onTheCrossing) - brightness(besideIt))).toBeGreaterThan(20);
    });
  });
});
