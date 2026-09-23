/** A length of plastic laid down in one straight move, from one point to another, in millimetres. */
export type Bead = [x1: number, y1: number, z1: number, x2: number, y2: number, z2: number];

// AIDEV-NOTE: a picture to tell one plate from another, not a preview anybody checks a print by.
// Beads are SAMPLED evenly across the whole print, the stride doubling each time the cap is hit, so
// a 128MB plate costs the same memory as a plate of a few hundred thousand moves. An ordinary plate
// never reaches it and is drawn whole.
const MAX_BEADS = 200_000;
const ARC_STEP = Math.PI / 12;
// How far outside the part's own footprint the first layer may reach and still be the part.
const FOOTPRINT_MM = 1;

interface Position {
  x: number;
  y: number;
  z: number;
  e: number;
}

/** Where a plate's gcode laid plastic, followed one line at a time. */
export class Toolpath {
  private at: Position = { x: 0, y: 0, z: 0, e: 0 };
  private relative = false;
  private relativeE = false;
  private laid: Bead[] = [];
  private seen = 0;
  private stride = 1;

  /** One line of gcode with its comment already removed. */
  follow(command: string): void {
    const [word, ...rest] = command.toUpperCase().split(/\s+/);
    // A bare letter is a value of nothing, which is 0 - and `G28 X` naming X is what homes only X.
    const said = new Map(rest.map((part) => [part[0], Number(part.slice(1))] as const));

    switch (word) {
      case 'G0':
      case 'G1':
        this.move(said);
        break;
      case 'G2':
      case 'G3':
        this.arc(said, word === 'G2');
        break;
      case 'G90':
        this.relative = this.relativeE = false;
        break;
      case 'G91':
        this.relative = this.relativeE = true;
        break;
      case 'M82':
        this.relativeE = false;
        break;
      case 'M83':
        this.relativeE = true;
        break;
      case 'G92':
        this.at = { ...this.at, ...this.axes(said, () => 0, false) };
        break;
      case 'G28':
        this.at = { ...this.at, ...this.homed(said) };
        break;
    }
  }

  // AIDEV-NOTE: the part is the footprint of what was printed ABOVE the first layer, and the first
  // layer counts only inside it. A purge line along the bed's edge, a skirt and a brim are all
  // first-layer-only, and framing on them made the part a speck in the corner of its own picture.
  // A plate one layer tall has nothing above it, and is all part.
  /** The beads that make up the part, leaving out what the first layer laid down away from it. */
  beads(): Bead[] {
    const bottom = this.laid.reduce((lowest, [, , z1, , , z2]) => Math.min(lowest, z1, z2), Infinity);
    const above = this.laid.filter(([, , z1, , , z2]) => Math.min(z1, z2) > bottom);
    if (above.length === 0) return this.laid;

    const [left, right, front, back] = above.reduce(
      ([l, r, f, b], [x1, y1, , x2, y2]) => [Math.min(l, x1, x2), Math.max(r, x1, x2), Math.min(f, y1, y2), Math.max(b, y1, y2)],
      [Infinity, -Infinity, Infinity, -Infinity],
    );
    const inside = (x: number, y: number): boolean =>
      x >= left - FOOTPRINT_MM && x <= right + FOOTPRINT_MM && y >= front - FOOTPRINT_MM && y <= back + FOOTPRINT_MM;

    return this.laid.filter(([x1, y1, , x2, y2]) => inside(x1, y1) && inside(x2, y2));
  }

  private move(said: Map<string | undefined, number>): void {
    const to = { ...this.at, ...this.axes(said, (axis) => this.at[axis], true) };
    if (this.extrudes(to) && (to.x !== this.at.x || to.y !== this.at.y)) this.lay(this.at, to);
    this.at = to;
  }

  // AIDEV-NOTE: only the I/J form, the one a slicer's arc fitting writes. An R-form arc is laid as
  // its chord, which is wrong in a way nobody recognising a plate will notice.
  private arc(said: Map<string | undefined, number>, clockwise: boolean): void {
    const from = this.at;
    const to = { ...from, ...this.axes(said, (axis) => from[axis], true) };
    const i = said.get('I');
    const j = said.get('J');

    if (!this.extrudes(to) || i === undefined || j === undefined) {
      this.move(said);
      return;
    }

    const [cx, cy] = [from.x + i, from.y + j];
    const radius = Math.hypot(i, j);
    const start = Math.atan2(from.y - cy, from.x - cx);
    let end = Math.atan2(to.y - cy, to.x - cx);
    if (clockwise && end >= start) end -= 2 * Math.PI;
    if (!clockwise && end <= start) end += 2 * Math.PI;

    const steps = Math.max(1, Math.ceil(Math.abs(end - start) / ARC_STEP));
    let previous = from;
    for (let step = 1; step <= steps; step++) {
      const angle = start + ((end - start) * step) / steps;
      const next = { ...to, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle), z: from.z + ((to.z - from.z) * step) / steps };
      this.lay(previous, next);
      previous = next;
    }

    this.at = to;
  }

  private axes(said: Map<string | undefined, number>, base: (axis: keyof Position) => number, moving: boolean): Partial<Position> {
    const moved: Partial<Position> = {};
    for (const axis of ['x', 'y', 'z', 'e'] as const) {
      const value = said.get(axis.toUpperCase());
      if (value === undefined || !Number.isFinite(value)) continue;

      const relative = moving && (axis === 'e' ? this.relativeE : this.relative);
      moved[axis] = relative ? base(axis) + value : value;
    }

    return moved;
  }

  private homed(said: Map<string | undefined, number>): Partial<Position> {
    const named = (['x', 'y', 'z'] as const).filter((axis) => said.has(axis.toUpperCase()));
    return Object.fromEntries((named.length === 0 ? ['x', 'y', 'z'] : named).map((axis) => [axis, 0]));
  }

  // AIDEV-NOTE: a straight move that pushes filament without going anywhere - priming, undoing a
  // retraction - lays no bead, and is usually done with the nozzle parked high above the bed where it
  // would stretch the frame. That is `move`'s to decide and not this: an arc that ends where it began
  // is a whole circle of plastic.
  private extrudes(to: Position): boolean {
    return to.e > this.at.e;
  }

  private lay(from: Position, to: Position): void {
    if (this.seen++ % this.stride !== 0) return;

    this.laid.push([from.x, from.y, from.z, to.x, to.y, to.z]);

    if (this.laid.length > MAX_BEADS) {
      this.laid = this.laid.filter((_, index) => index % 2 === 0);
      this.stride *= 2;
    }
  }
}
