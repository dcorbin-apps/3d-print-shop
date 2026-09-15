import type { BuildVolume } from './Job.js';

/** What a plate's own comments say it needs, as far as they say anything. */
export interface SlicedPlate {
  /** In the order the comment named them; the first is the one that has to be loaded. */
  filaments: string[];
  estimatedPrintSeconds?: number;
  requiredBuildVolume?: BuildVolume;
}

// AIDEV-NOTE: a TABLE of spellings per field, not a parser per slicer. Every tool that writes one of
// these invents its own name for the same fact, and the ones here are the ones that have been seen -
// so adding support for another is a string in a list rather than a branch. Nothing here may name
// the tool a spelling came from: what writes a plate is a client, and the shop names none.
const FILAMENT_KEYS = ['filament_type', 'filament_settings_id'];
const ESTIMATE_KEYS = ['estimated printing time (normal mode)', 'estimated printing time', 'total estimated time'];
const WIDTH_AND_DEPTH_KEYS = ['bed_shape', 'printable_area'];
const HEIGHT_KEYS = ['max_print_height', 'printable_height'];

// AIDEV-NOTE: `; name = value`, which is the one shape every writer of these agrees on. A line that
// is not a comment ends nothing and is simply not a setting - the block is not delimited here,
// because what this is given is already only the ends of a file.
const SETTING = /^;\s*([^=]+?)\s*=\s*(.*?)\s*$/;

/** What the comments in this much of a plate say about it. */
export function slicedPlate(text: string): SlicedPlate {
  const said = settingsIn(text);

  return {
    filaments: filamentsIn(said),
    estimatedPrintSeconds: estimateIn(said),
    requiredBuildVolume: buildVolumeIn(said),
  };
}

function settingsIn(text: string): Map<string, string> {
  const said = new Map<string, string>();

  for (const line of text.split('\n')) {
    const match = SETTING.exec(line);
    // AIDEV-NOTE: the FIRST wins. A plate carries the same setting at the head and again in the
    // trailing block, and this is handed both ends at once - so a rule about which is needed, and
    // "the one nearest the top" is the one that does not depend on how much tail was read.
    if (match !== null && !said.has(match[1])) said.set(match[1], match[2]);
  }

  return said;
}

function firstOf(said: Map<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = said.get(key);
    if (value !== undefined && value !== '') return value;
  }

  return undefined;
}

// AIDEV-NOTE: separated by `;` where more than one is named, which collides with nothing because the
// comment marker has already been stripped by the time this sees a value. Commas are taken too, and
// cost nothing to take.
function filamentsIn(said: Map<string, string>): string[] {
  const value = firstOf(said, FILAMENT_KEYS);
  if (value === undefined) return [];

  return value
    .split(/[;,]/)
    .map((filament) => filament.trim())
    .filter((filament) => filament !== '');
}

const SPANS = /(\d+)\s*([dhms])/g;
const PER_UNIT: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

// AIDEV-NOTE: `2h 5m 30s`, and every subset of it. Returned undefined rather than zero when nothing
// parses: the field is optional and absent means "this client does not know", where zero would be a
// claim that the plate takes no time and would rank its filament below everything.
function estimateIn(said: Map<string, string>): number | undefined {
  const value = firstOf(said, ESTIMATE_KEYS);
  if (value === undefined) return undefined;

  let seconds = 0;
  let found = false;
  for (const [, amount, unit] of value.matchAll(SPANS)) {
    seconds += Number(amount) * PER_UNIT[unit];
    found = true;
  }

  return found ? seconds : undefined;
}

// AIDEV-NOTE: the bed the plate was sliced FOR, which reads like an over-estimate of what the object
// needs and is the right number anyway: a plate's coordinates include the prime line, the skirt and
// the wipe tower, all placed against that bed. The object's own extent is the UNSAFE number here,
// and is deliberately not what this reads.
function buildVolumeIn(said: Map<string, string>): BuildVolume | undefined {
  const bed = firstOf(said, WIDTH_AND_DEPTH_KEYS);
  const height = firstOf(said, HEIGHT_KEYS);
  if (bed === undefined || height === undefined) return undefined;

  const corners = [...bed.matchAll(/(-?[\d.]+)\s*x\s*(-?[\d.]+)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
  const z = Number(height);
  if (corners.length === 0 || !Number.isFinite(z) || z <= 0) return undefined;

  const x = Math.max(...corners.map((corner) => corner.x));
  const y = Math.max(...corners.map((corner) => corner.y));
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return undefined;

  return { x, y, z };
}
