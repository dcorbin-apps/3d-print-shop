import { describe, it, expect } from '@jest/globals';
import { slicedPlate } from '../src/slicedPlate';

// AIDEV-NOTE: (UT) over a string, which is what the ends of a plate are by the time anything here
// sees them. What an actual plate has in it is a question about somebody else's file format, and no
// test here can answer it - tests/assumptions is where a sample would be pinned.
describe('what a sliced plate says about itself', () => {
  it('names the filament the plate was sliced for', () => {
    expect(slicedPlate('; filament_type = PLA\n').filaments).toEqual(['PLA']);
  });

  it('keeps every filament named, in the order they were named', () => {
    expect(slicedPlate('; filament_type = PETG;PLA;ABS\n').filaments).toEqual(['PETG', 'PLA', 'ABS']);
  });

  it('names none when the plate says nothing about filament', () => {
    expect(slicedPlate('G1 X100.000 Y100.000\n; layer_height = 0.2\n').filaments).toEqual([]);
  });

  it('reads an estimate given in hours and minutes', () => {
    expect(slicedPlate('; estimated printing time (normal mode) = 2h 5m\n').estimatedPrintSeconds).toBe(7500);
  });

  it('reads an estimate given in days, minutes and seconds', () => {
    expect(slicedPlate('; estimated printing time = 1d 3m 4s\n').estimatedPrintSeconds).toBe(86584);
  });

  it('leaves the estimate out when what was written is not a span of time', () => {
    expect(slicedPlate('; estimated printing time = unknown\n').estimatedPrintSeconds).toBeUndefined();
  });

  it('takes the bed the plate was sliced for as the room it needs', () => {
    const plate = '; bed_shape = 0x0,250x0,250x210,0x210\n; max_print_height = 220\n';

    expect(slicedPlate(plate).requiredBuildVolume).toEqual({ x: 250, y: 210, z: 220 });
  });

  it('says nothing about room when the plate gives a bed and no height', () => {
    expect(slicedPlate('; bed_shape = 0x0,250x0,250x210,0x210\n').requiredBuildVolume).toBeUndefined();
  });

  it('says nothing about room when the plate gives a height and no bed', () => {
    expect(slicedPlate('; max_print_height = 220\n').requiredBuildVolume).toBeUndefined();
  });

  // The head of a plate and its trailing block are handed over together, so the same setting arrives
  // twice and which one counts cannot be left to how much tail was read.
  it('keeps the first answer when a setting is written twice', () => {
    expect(slicedPlate('; filament_type = PLA\nG1 X1\n; filament_type = PETG\n').filaments).toEqual(['PLA']);
  });

  it('reads nothing out of a line that is not a comment', () => {
    expect(slicedPlate('filament_type = PLA\n').filaments).toEqual([]);
  });
});
