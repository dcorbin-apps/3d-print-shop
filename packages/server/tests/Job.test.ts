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

  // A client names its own files so it can find them on the printer months later, which is the
  // whole point of remotePath - so what is refused is only what a printer would not store verbatim.
  describe('the path a client asks the printer to store it under', () => {
    const accepts = (remotePath: string): void => expect(() => validateDetails(details({ remotePath }))).not.toThrow();
    const refuses = (remotePath: string): void => expect(() => validateDetails(details({ remotePath }))).toThrow(InvalidSubmission);

    it.each([
      ['gamekit/Gloomhaven (2nd ed) #3.gcode'],
      ["gamekit/Sam & Ella's tray.gcode"],
      ['[GameKit] player-box_x4.gcode'],
      ['a/b/c/deeply/nested.gcode'],
      ['padded .gcode'],
    ])('takes %p, which a printer stores as it was given', (remotePath) => {
      accepts(remotePath);
    });

    // Traversal, and the forms of it OctoPrint itself refuses or resolves away. The reason is
    // asserted, not just the refusal: more than one rule would reject these, and the one that does
    // is what a client is told - "it has an empty folder name in it" explains an absolute path
    // badly, and a leading dot explains '..' badly.
    it.each([
      ['../../etc/passwd', 'it names a folder relative to another one'],
      ['gamekit/../../escape.gcode', 'it names a folder relative to another one'],
      ['./here.gcode', 'it names a folder relative to another one'],
      ['/absolute/on/the/printer.gcode', 'it starts at the root of the printer'],
    ])('refuses %p, saying %p', (remotePath, why) => {
      expect(() => validateDetails(details({ remotePath }))).toThrow(why);
    });

    // Each of these a printer would store under a DIFFERENT name, and a different name is a
    // completion event that matches nothing and a bed held for ever.
    it.each([
      ['back\\slash.gcode'],
      ['colon:name.gcode'],
      ['star*name.gcode'],
      ['question?.gcode'],
      ['quote".gcode'],
      ['less<than.gcode'],
      ['more>than.gcode'],
      ['pipe|name.gcode'],
      ['.hidden.gcode'],
      ['gamekit/.hidden.gcode'],
      [' padded.gcode'],
      ['trailing.gcode.'],
    ])('refuses %p, which a printer would rename', (remotePath) => {
      refuses(remotePath);
    });

    it('refuses a newline, which has no place in a name and none in a header', () => {
      refuses('two\nlines.gcode');
    });

    it('refuses a NUL, which truncates a path rather than being part of it', () => {
      refuses('truncated\u0000.gcode');
    });

    it.each([[''], ['gamekit//doubled.gcode']])('refuses %p, which names nothing', (remotePath) => {
      refuses(remotePath);
    });

    it('refuses a path longer than a filesystem would hold', () => {
      refuses(`${'a'.repeat(252)}.gcode`);
    });

    it('takes one exactly as long as a filesystem would hold', () => {
      accepts(`${'a'.repeat(249)}.gcode`);
    });

    // Absent is the ordinary case - the shop names it then, and there is nothing to check.
    it('takes a job that asks for no path at all', () => {
      expect(() => validateDetails(details())).not.toThrow();
    });
  });
});
