import type { Bead } from './Toolpath.js';

/** Pixels, four bytes apiece - red, green, blue and how opaque - row after row from the top left. */
export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** How big the picture comes out, along its longer side. */
export const RENDER_PX = 600;
// AIDEV-NOTE: as wide as the plastic a 0.4mm nozzle lays down. Not read from the plate: nobody
// recognising a plate will notice a bead drawn a little fat or thin.
const BEAD_MM = 0.45;
// Drawn at twice the size and averaged down, which is what keeps the edge of a bead from stepping.
const SUPERSAMPLE = 2;
const MARGIN_PX = 8;

// AIDEV-NOTE: a true isometric view from above the bed's front-left corner. `right`, `up` and `into`
// are the camera's axes in the bed's millimetres: across the picture, up it, and away from the viewer.
const ELEVATION = Math.atan(1 / Math.SQRT2);
const HALF = Math.SQRT1_2;
const RIGHT = [HALF, -HALF, 0] as const;
const UP = [Math.sin(ELEVATION) * HALF, Math.sin(ELEVATION) * HALF, Math.cos(ELEVATION)] as const;
const INTO = [Math.cos(ELEVATION) * HALF, Math.cos(ELEVATION) * HALF, -Math.sin(ELEVATION)] as const;

// Light from over the viewer's left shoulder, in the camera's axes: right, up, and towards the viewer.
const LIGHT = normalised([-0.4, 0.6, 0.7]);
const SHINE = normalised([LIGHT[0], LIGHT[1], LIGHT[2] + 1]);
const PLASTIC = [224, 122, 44] as const;
const AMBIENT = 0.28;
const DIFFUSE = 0.72;
const SPECULAR = 0.35;
const GLOSS = 24;

type OnScreen = [x: number, y: number, depth: number];

/**
 * The beads as tubes of plastic, lit and drawn in depth so that nearer ones hide what is behind them.
 * Transparent wherever there is no plastic, so it sits on whatever the page puts it on.
 */
export function renderBeads(beads: Bead[]): Image {
  if (beads.length === 0) return { width: 1, height: 1, rgba: new Uint8Array(4) };

  const seen = beads.map(([x1, y1, z1, x2, y2, z2]): [OnScreen, OnScreen] => [onScreen(x1, y1, z1), onScreen(x2, y2, z2)]);
  const [left, right, top, bottom] = seen.reduce(
    ([l, r, t, b], [a, z]) => [Math.min(l, a[0], z[0]), Math.max(r, a[0], z[0]), Math.min(t, a[1], z[1]), Math.max(b, a[1], z[1])],
    [Infinity, -Infinity, Infinity, -Infinity],
  );
  const [spanX, spanY] = [right - left + BEAD_MM, bottom - top + BEAD_MM];
  const scale = (RENDER_PX - 2 * MARGIN_PX) / Math.max(spanX, spanY);
  const width = Math.round(spanX * scale) + 2 * MARGIN_PX;
  const height = Math.round(spanY * scale) + 2 * MARGIN_PX;

  const canvas = new Canvas(width * SUPERSAMPLE, height * SUPERSAMPLE);
  const px = scale * SUPERSAMPLE;
  const offsetX = (MARGIN_PX + (BEAD_MM / 2) * scale) * SUPERSAMPLE - left * px;
  const offsetY = (MARGIN_PX + (BEAD_MM / 2) * scale) * SUPERSAMPLE - top * px;
  const radius = (BEAD_MM / 2) * px;

  for (const [a, z] of seen) {
    canvas.tube([a[0] * px + offsetX, a[1] * px + offsetY, a[2] * px], [z[0] * px + offsetX, z[1] * px + offsetY, z[2] * px], radius);
  }

  return canvas.downsampled(SUPERSAMPLE);
}

// Screen y runs DOWN, so what is further back and higher up comes out nearer the top.
function onScreen(x: number, y: number, z: number): OnScreen {
  return [x * RIGHT[0] + y * RIGHT[1], -(x * UP[0] + y * UP[1] + z * UP[2]), x * INTO[0] + y * INTO[1] + z * INTO[2]];
}

class Canvas {
  private readonly depth: Float32Array;
  private readonly colour: Uint8Array;

  constructor(
    private readonly width: number,
    private readonly height: number,
  ) {
    this.depth = new Float32Array(width * height).fill(Infinity);
    this.colour = new Uint8Array(width * height * 3);
  }

  // AIDEV-NOTE: a capsule rather than a true cylinder - every pixel within `radius` of the bead's
  // line on screen is plastic, and its surface normal is taken from how far off the line it is. That
  // is the tube impostor a slicer's preview uses, and the ends come out round for free.
  //
  // Each row is walked only across the stretch the bead can reach, so a long diagonal costs its
  // length rather than the area of the box around it.
  tube(a: OnScreen, z: OnScreen, radius: number): void {
    const [ax, ay, ad] = a;
    const [dx, dy, dd] = [z[0] - ax, z[1] - ay, z[2] - ad];
    const length2 = dx * dx + dy * dy;
    const radius2 = radius * radius;

    const firstRow = Math.max(0, Math.floor(Math.min(ay, z[1]) - radius));
    const lastRow = Math.min(this.height - 1, Math.ceil(Math.max(ay, z[1]) + radius));

    for (let row = firstRow; row <= lastRow; row++) {
      const y = row + 0.5;
      const [from, to] = this.reach(ax, ay, dx, dy, y, radius);

      for (let column = Math.max(0, Math.floor(from)); column <= Math.min(this.width - 1, Math.ceil(to)); column++) {
        const x = column + 0.5;
        const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length2));
        const [offX, offY] = [x - (ax + t * dx), y - (ay + t * dy)];
        const off2 = offX * offX + offY * offY;
        if (off2 > radius2) continue;

        const rise = Math.sqrt(radius2 - off2);
        const depth = ad + t * dd - rise;
        const at = row * this.width + column;
        if (depth >= (this.depth[at] ?? -Infinity)) continue;

        this.depth[at] = depth;
        this.paint(at, [offX / radius, -offY / radius, rise / radius]);
      }
    }
  }

  downsampled(by: number): Image {
    const [width, height] = [Math.floor(this.width / by), Math.floor(this.height / by)];
    const rgba = new Uint8Array(width * height * 4);

    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const sum = [0, 0, 0];
        let covered = 0;

        for (let sy = 0; sy < by; sy++) {
          for (let sx = 0; sx < by; sx++) {
            const at = (row * by + sy) * this.width + column * by + sx;
            if (this.depth[at] === Infinity) continue;

            covered++;
            for (let channel = 0; channel < 3; channel++) sum[channel] = (sum[channel] ?? 0) + (this.colour[at * 3 + channel] ?? 0);
          }
        }

        if (covered === 0) continue;
        const out = (row * width + column) * 4;
        for (let channel = 0; channel < 3; channel++) rgba[out + channel] = Math.round((sum[channel] ?? 0) / covered);
        rgba[out + 3] = Math.round((255 * covered) / (by * by));
      }
    }

    return { width, height, rgba };
  }

  // The x a row can be plastic between: where the bead's line is within `radius` of the row, widened
  // by the radius itself. Generous by design - every pixel in it is still tested properly.
  private reach(ax: number, ay: number, dx: number, dy: number, y: number, radius: number): [number, number] {
    if (Math.abs(dy) < 1e-9) return [Math.min(ax, ax + dx) - radius, Math.max(ax, ax + dx) + radius];

    const [t1, t2] = [(y - radius - ay) / dy, (y + radius - ay) / dy];
    const [low, high] = [Math.max(0, Math.min(t1, t2)), Math.min(1, Math.max(t1, t2))];

    const [x1, x2] = [ax + low * dx, ax + high * dx];
    return [Math.min(x1, x2) - radius, Math.max(x1, x2) + radius];
  }

  private paint(at: number, normal: readonly [number, number, number]): void {
    const diffuse = Math.max(0, dot(normal, LIGHT));
    const shine = SPECULAR * Math.pow(Math.max(0, dot(normal, SHINE)), GLOSS);
    const lit = AMBIENT + DIFFUSE * diffuse;

    for (let channel = 0; channel < 3; channel++) {
      this.colour[at * 3 + channel] = Math.min(255, Math.round((PLASTIC[channel] ?? 0) * lit + 255 * shine));
    }
  }
}

function dot(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

function normalised([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
