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

  // AIDEV-NOTE: `JobDetails` is a declaration about JSON somebody else wrote. Each of these read a
  // method off what arrived and threw a TypeError, which reaches a client as 500 - the shop taking
  // the blame for a request it should have refused.
  it.each([[undefined], ['PLA'], [5], [null], [{}], [[5]], [[null]], [['PLA', 7]]])(
    'refuses %p, which is not a list of filament names',
    (filaments) => {
      expect(() => validateDetails(details({ filaments: filaments as unknown as string[] }))).toThrow(InvalidSubmission);
    }
  );

  // An empty name would schedule against a material nobody can load.
  it.each([[''], ['   ']])('refuses a filament named %p', (filament) => {
    expect(() => validateDetails(details({ filaments: [filament] }))).toThrow('no name');
  });

  // AIDEV-NOTE: nothing in the shop calls a string method on this, so what a wrong one breaks is
  // whatever is reading it - an operator's list, a log line, a page. The shop cannot answer for those
  // and so does not accept what would break them.
  describe('the name a client gives a job', () => {
    const named = (displayName: unknown): (() => void) => (): void => validateDetails(details({ displayName: displayName as string }));

    it.each([[5], [null], [{}], [[]], [true]])('refuses %p, which is not text', (displayName) => {
      expect(named(displayName)).toThrow('is not a name for a job');
    });

    // The boundary both ways: one that fits is kept, and the first one that does not is refused.
    it('takes a name of exactly 255 characters', () => {
      expect(named('x'.repeat(255))).not.toThrow();
    });

    it('refuses a name of 256, and says how long it was rather than repeating it', () => {
      expect(named('x'.repeat(256))).toThrow('at most 255 characters, and this one is 256');
    });
  });

  // AIDEV-NOTE: a number the shop adds up, so what it refuses is what would poison the total. It is
  // cast from JSON on the way in, so a client can send anything at all under this name.
  describe('how long a client says the print takes', () => {
    it('accepts a job that says', () => {
      expect(() => validateDetails(details({ estimatedPrintSeconds: 20_460 }))).not.toThrow();
    });

    it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['3600' as unknown as number], [null as unknown as number]])(
      'refuses %p as how long a print takes',
      (said) => {
        expect(() => validateDetails(details({ estimatedPrintSeconds: said }))).toThrow('is not how long a print takes');
      }
    );

    // Said back so an operator reading the log can see what arrived - and JSON.stringify writes
    // both of these as `null`, which would name neither.
    it.each([
      [Number.NaN, 'NaN is not how long'],
      [Number.POSITIVE_INFINITY, 'Infinity is not how long'],
    ])('says what it was given when it was %p', (said, complaint) => {
      expect(() => validateDetails(details({ estimatedPrintSeconds: said }))).toThrow(complaint);
    });
  });

  it('refuses a blank filament among good ones', () => {
    expect(() => validateDetails(details({ filaments: ['PLA-SpaceGray', ''] }))).toThrow(InvalidSubmission);
  });

  // A client names its own files so it can find them on the printer months later, which is the
  // whole point of remotePath - so what is refused is only what a printer would not store verbatim.
  describe('the path a client asks the printer to store it under', () => {
    const accepts = (remotePath: string): void => expect(() => validateDetails(details({ remotePath }))).not.toThrow();
    const refuses = (remotePath: string): void => expect(() => validateDetails(details({ remotePath }))).toThrow(InvalidSubmission);

    // The same mistake as the filaments above, one line below it: everything this checks reads the
    // path as text, so anything else was a TypeError rather than a refusal.
    it.each([[5], [null], [[]], [{}]])('refuses %p, which is not text', (remotePath) => {
      expect(() => validateDetails(details({ remotePath: remotePath as unknown as string }))).toThrow(InvalidSubmission);
    });

    // AIDEV-NOTE: every one of these was uploaded to a real OctoPrint (1.11.8) and read back under
    // the name it was given. They are here rather than in a comment because what a printer does with
    // a name is the whole of this rule, and the next version of one is free to disagree.
    it.each([
      ['gamekit/Gloomhaven (2nd ed) #3.gcode'],
      ["gamekit/Sam and Ella's tray.gcode"],
      ['[GameKit] player-box_x4.gcode'],
      ['a/b/c/deeply/nested.gcode'],
      ['padded .gcode'],
      ['percent%and!bang@at^hat~tilde.gcode'],
      ['comma,brace{}plus+equals=.gcode'],
    ])('takes %p, which a printer stores as it was given', (remotePath) => {
      accepts(remotePath);
    });

    // AIDEV-NOTE: the thing the API docs had left open, and the machine says no: a non-ASCII name is
    // NOT transliterated. The docs show `20mm-ümläut-böx` stored as `20mm-umlaut-box`; on 1.11.8 it
    // comes back exactly as sent, so there is no rule against one and these say so.
    it.each([['20mm-ümläut-böx.gcode'], ['ärger-straße.gcode'], ['emoji-🖨.gcode'], ['日本語.gcode']])(
      'takes %p, which a printer does not transliterate',
      (remotePath) => {
        accepts(remotePath);
      }
    );

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

    // AIDEV-NOTE: MEASURED. These three are taken out of a name silently by OctoPrint 1.11.8 -
    // `a&b.gcode` is stored as `ab.gcode` - so a job asking for one would be watched for at a path
    // the printer never used, and its bed held until somebody gave up on it. Nothing about them is
    // illegal on a filesystem, which is why they are a rule of their own.
    it.each([
      ["gamekit/Sam & Ella's tray.gcode"],
      ['semi;colon.gcode'],
      ['dollar$sign.gcode'],
      ['all&three;of$them.gcode'],
    ])('refuses %p, which a printer would silently shorten', (remotePath) => {
      refuses(remotePath);
    });

    it('says which characters a printer takes out, because a client has to choose another name', () => {
      expect(() => validateDetails(details({ remotePath: 'a&b.gcode' }))).toThrow('takes "&", ";" and "$" out of a name');
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
