import { describe, it, expect } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import { createCLI, ourSentenceIn, readJobId, readMegabytes, readPort, readRole, run, unknownCommandIn } from '../src/cli';

// AIDEV-NOTE: commander answers a --help anywhere in argv before deciding whether the command in
// front of it exists, so a typo that happens to carry one was answered with help and exit 0 - which
// a script cannot tell from success. Driven against the REAL command tree rather than a stub: what
// this has to agree with is the commands the shop actually has.
describe('a command the shop does not have', () => {
  const asked = (line: string): string | undefined =>
    unknownCommandIn(
      createCLI(),
      line.split(' ').filter((word) => word !== ''),
    );

  it.each([['nonsense'], ['add printer add'], ['printer nonsense'], ['job nonsense']])('names the word in %p that is not a command', (line) => {
    expect(asked(line)).toBe(line.split(' ').find((word) => word === 'nonsense' || word === 'add'));
  });

  // The whole point: the typo is still named when the line asks for help, because asking for help
  // about a command that does not exist is a mistake rather than a request.
  it.each([['add printer add --help'], ['printer nonsense --help'], ['nonsense -h']])('names it in %p, help or no help', (line) => {
    expect(asked(line)).toBeDefined();
  });

  // Wherever the flag falls, and not only where the typo happens to come first: a help flag is not
  // a thing that excuses the word beside it.
  it.each([['printer --help nonsense'], ['-h nonsense']])('names the one in %p that comes after the flag', (line) => {
    expect(asked(line)).toBe('nonsense');
  });

  it.each([
    ['printer add mk4 250x210x220 http://octopi.local'],
    ['printer list'],
    ['job waiting mk4'],
    ['serve --data /tmp/data --etc /tmp/etc'],
    ['init dave'],
    ['shutdown'],
  ])('finds nothing wrong with %p', (line) => {
    expect(asked(line)).toBeUndefined();
  });

  // An argument is not a command. `job approve 7` must not have 7 looked up as one.
  it.each([['job approve 7'], ['printer stop mk4 "the door is open"'], ['printer load mk4 PLA-Red']])(
    'reads what follows %p as arguments',
    (line) => {
      expect(asked(line)).toBeUndefined();
    },
  );

  // An option's VALUE is not a command either, and this one is written before the subcommand.
  it('does not read the value of an option as a command', () => {
    expect(asked('printer --shop-url http://localhost:7373 list')).toBeUndefined();
  });

  it('is not troubled by an option written as one word', () => {
    expect(asked('printer --shop-url=http://localhost:7373 list')).toBeUndefined();
  });

  // commander's own, and in no list of commands to be found in - so it must be let past rather than
  // reported, and what follows it is commander's to judge.
  it.each([['help'], ['help printer'], ['printer help']])('lets %p past to commander', (line) => {
    expect(asked(line)).toBeUndefined();
  });

  it.each([[''], ['--help'], ['-h']])('finds nothing to complain about in %p', (line) => {
    expect(asked(line)).toBeUndefined();
  });

  // The other half of the point: a REAL command asking for help is a request and not a mistake, so
  // the check has to let it through to commander rather than naming the flag or the command.
  it.each([['printer add --help'], ['printer --help'], ['job approve --help'], ['serve -h']])('lets %p through to be answered', (line) => {
    expect(asked(line)).toBeUndefined();
  });
});

// AIDEV-NOTE: the ORDER, which is the whole of the bug. commander answers a --help anywhere in argv
// before deciding whether the command in front of it exists, so a typo carrying one was answered
// with the general help and exit 0. This used to live in main.ts's module body, where the only way
// to ask about it was to spawn a process.
describe('running a command line', () => {
  const said: string[] = [];
  const running = (line: string): Promise<number> => {
    said.length = 0;

    return run(['node', 'shop', ...line.split(' ').filter((word) => word !== '')], (message) => said.push(message));
  };

  it.each([['nonsense'], ['add printer add --help'], ['printer nonsense --help'], ['nonsense -h']])(
    'is a failure for %p, however it asks for help',
    async (line) => {
      expect(await running(line)).toBe(1);
    },
  );

  it('says which word it did not know, the way commander says its own', async () => {
    await running('printer nonsense --help');

    expect(said).toEqual(["error: unknown command 'nonsense'"]);
  });

  // AIDEV-NOTE: proof that the check came FIRST. Reaching commander with this line would print the
  // general help and answer 0, which is what it used to do - so a non-zero code with nothing but the
  // one message says commander never saw it.
  it('never reaches commander with a command it does not have', async () => {
    expect(await running('nonsense --help')).toBe(1);
    expect(said).toEqual(["error: unknown command 'nonsense'"]);
  });
});

describe('readPort', () => {
  it.each([
    ['7373', 7373],
    ['0', 0],
  ])('reads %s as a port', (text, expected) => {
    expect(readPort(text)).toBe(expected);
  });

  // 65535 is the last one there is, and a port typed by hand is exactly where a digit gets added.
  it.each([['65536'], ['-1'], ['7373.5'], ['http'], ['']])('refuses %p', (text) => {
    expect(() => readPort(text)).toThrow(InvalidArgumentError);
  });
});

describe('readMegabytes', () => {
  it.each([
    ['1', 1024 * 1024],
    ['256', 256 * 1024 * 1024],
  ])('reads %s as that many megabytes', (text, expected) => {
    expect(readMegabytes(text)).toBe(expected);
  });

  // Zero would be a shop that refuses every job, which nobody means to ask for.
  it.each([['0'], ['-1'], ['1.5'], ['128MB'], ['']])('refuses %p', (text) => {
    expect(() => readMegabytes(text)).toThrow(InvalidArgumentError);
  });
});

// AIDEV-NOTE: the shop's own ids are counting numbers, so anything else is a typo rather than a job
// it has not got - and saying so here is better than a 404 about job NaN.
describe('reading a job id an operator typed', () => {
  it.each([
    ['1', 1],
    ['7', 7],
    ['42', 42],
  ])('reads %j as %i', (said, expected) => {
    expect(readJobId(said)).toBe(expected);
  });

  it.each([['0'], ['-1'], ['1.5'], ['seven'], [''], ['7x'], ['x7'], [' 7'], ['1e3'], ['0x7']])('will not read %j as one', (said) => {
    expect(() => readJobId(said)).toThrow(`cannot read "${said}" as a job id`);
  });
});

// The two there are, said back rather than let through as whatever was typed - a role nobody
// recognises would be written into the file and refused by the shop on its next read.
describe('reading the role an operator typed', () => {
  it.each([['admin'], ['user']])('reads %j', (said) => {
    expect(readRole(said)).toBe(said);
  });

  it.each([['Admin'], ['ADMIN'], ['operator'], [''], ['admin ']])('will not read %j as one', (said) => {
    expect(() => readRole(said)).toThrow('a role is "admin" or "user"');
  });

  // AIDEV-NOTE: the two shapes commander composes are pinned in
  // tests/assumptions/whatCommanderSays.test.ts, because they are its wording and not ours. What is
  // asked here is what this shop does with them: takes its sentence off and leaves the one a parser
  // wrote, which is how every rule checked anywhere else already reads.
  describe('the sentence an operator is left with', () => {
    it('drops what commander said about an argument', () => {
      expect(ourSentenceIn(`error: command-argument value 'seven' is invalid for argument 'id'. cannot read "seven" as a job id`)).toBe(
        'cannot read "seven" as a job id',
      );
    });

    it('drops what it said about an option, which it words differently', () => {
      expect(ourSentenceIn(`error: option '--port <port>' argument 'abc' is invalid. cannot read "abc" as a port`)).toBe(
        'cannot read "abc" as a port',
      );
    });

    // Its own complaints are its to word. The shop raises one of these itself, in the same words, so
    // that an unknown command and an unknown option read alike.
    it.each([["error: unknown option '--nope'"], ["error: missing required argument 'id'"], ["error: unknown command 'wibble'"]])(
      'leaves %p exactly as commander wrote it',
      (line) => {
        expect(ourSentenceIn(line)).toBe(line);
      },
    );

    // AIDEV-NOTE: only commander's half, however our half is punctuated. Matched greedily this runs
    // to the LAST full stop in the line and takes the first sentence of the parser's message with
    // it - which no message here would have shown, because none of them has a full stop in it yet.
    it('takes its half only, even when ours has a full stop of its own', () => {
      const composed = `error: command-argument value 'x' is invalid for argument 'id'. a job id counts from one. "x" does not`;

      expect(ourSentenceIn(composed)).toBe('a job id counts from one. "x" does not');
    });

    // A sentence of ours that was never composed into one of commander's is nobody's to trim.
    it('leaves a sentence that arrived on its own alone', () => {
      const said = 'cannot read "250x210" as a build volume - expected <width>x<depth>x<height> in mm';

      expect(ourSentenceIn(said)).toBe(said);
    });
  });
});
