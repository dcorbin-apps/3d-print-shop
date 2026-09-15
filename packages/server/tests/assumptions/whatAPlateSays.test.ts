import { describe, it, expect } from '@jest/globals';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ENDS_BYTES, endsOf } from '../../src/asAnOctoPrint';
import { slicedPlate } from '../../src/slicedPlate';

// AIDEV-NOTE: (assumption test) the one thing `slicedPlate` cannot say about itself - that the
// spellings it looks for are the spellings a real plate actually uses. Everything in slicedPlate.ts
// was written from what somebody else's tool is BELIEVED to write; this is a plate that tool really
// produced, and it is the only place in this repository that a claim about that format is measured
// rather than asserted.
//
// It reads through `endsOf` on purpose. A test that read the file its own way would pin the format
// and not the shop's ability to find it in one - which is the half that breaks when a plate grows.
describe('what a plate a real tool wrote actually says', () => {
  // Jest's own answer for where this file is, because `import.meta` is not on in this transform and
  // a path from the working directory would depend on where somebody ran the suite from.
  const PLATE = path.resolve(path.dirname(expect.getState().testPath ?? ''), 'aRealPlate.gcode');

  it('is read for its filament, its estimate and the bed it was sliced for', async () => {
    expect(slicedPlate(await endsOf(PLATE))).toEqual({
      filaments: ['PLA'],
      estimatedPrintSeconds: 359,
      requiredBuildVolume: { x: 250, y: 210, z: 220 },
    });
  });

  // What the window costs is bounded; what it has to reach is not, and only a real file says which.
  it('keeps everything worth reading inside the window the shop reads', async () => {
    const { size } = await stat(PLATE);
    const settingsAt = (await endsOf(PLATE)).indexOf('; filament_type = ');

    expect(size).toBeGreaterThan(ENDS_BYTES);
    expect(settingsAt).toBeGreaterThan(-1);
  });

  // The profile's name sits beside the material's and is not it. It is quoted, it names settings in
  // somebody else's namespace, and a job that waited for it would wait for ever.
  it('carries a settings profile beside the material, which is not taken for one', async () => {
    const ends = await endsOf(PLATE);

    expect(ends).toContain('; filament_settings_id = ');
    expect(slicedPlate(ends).filaments).toEqual(['PLA']);
  });
});
