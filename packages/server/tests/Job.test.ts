import { describe, it, expect } from '@jest/globals';
import { InvalidSubmission, generatedDisplayName, validateDetails } from '../src/Job';
import type { JobDetails } from '../src/Job';

describe('generatedDisplayName', () => {
  // Two, because one would be satisfied by any fixed string.
  it.each([
    [1, 'Job 1'],
    [7, 'Job 7'],
  ])('names submission %i for a client that offered none', (ordinal, expected) => {
    expect(generatedDisplayName(ordinal)).toBe(expected);
  });
});

describe('validateDetails', () => {
  function details(overrides: Partial<JobDetails> = {}): JobDetails {
    return { filaments: ['PLA-SpaceGray'], ...overrides };
  }

  // Everything but the filaments is optional, so this is also what a bare submission looks like:
  // no display name, no remote path, no printer, no metadata. Note it says nothing about gcode -
  // the stream has not run yet, so the store catches an empty one. See JobStore.test.ts.
  it('accepts a job that names a filament and nothing else', () => {
    expect(() => validateDetails(details())).not.toThrow();
  });

  it('refuses a job that says nothing about what it needs loaded', () => {
    expect(() => validateDetails(details({ filaments: [] }))).toThrow('which filaments it needs');
  });

  // An empty name would schedule against a material nobody can load.
  it.each([[''], ['   ']])('refuses a filament named %p', (filament) => {
    expect(() => validateDetails(details({ filaments: [filament] }))).toThrow('no name');
  });

  it('refuses a blank filament among good ones', () => {
    expect(() => validateDetails(details({ filaments: ['PLA-SpaceGray', ''] }))).toThrow(InvalidSubmission);
  });
});
