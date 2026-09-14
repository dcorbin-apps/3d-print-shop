import { describe, it, expect } from '@jest/globals';
import { Command, InvalidArgumentError } from 'commander';

// AIDEV-NOTE: what commander MAKES of a refusal from one of our parsers, which is the one thing
// `ourSentenceIn` cannot say about itself. It takes the sentence commander composed off the front of
// the one this shop wrote, and it can only do that while the front is the shape recorded here.
//
// Two shapes, because an argument and an option are not worded alike. Written against commander
// itself rather than through the shop's command line: what is pinned is the dependency's wording,
// and the shop's own use of it is asked in tests/cli.test.ts.
//
// Red here means commander reworded. Nothing breaks when it does - the sentence simply goes out
// whole, the way it did before any of this - but the stripping has stopped working and this is where
// that is said.
describe('what commander says when a parser of ours refuses a value', () => {
  const OURS = 'cannot read "seven" as a job id';

  const refusing = (): never => {
    throw new InvalidArgumentError(OURS);
  };

  const said = (build: (program: Command) => void, argv: string[]): string => {
    const written: string[] = [];
    const program = new Command();
    program.name('shop').exitOverride();
    program.configureOutput({ outputError: (line) => written.push(line) });
    build(program);

    try {
      program.parse(['node', 'shop', ...argv]);
    } catch {
      // The exit is overridden, so it throws what it would have exited with. The writing is the claim.
    }

    return written.join('').trimEnd();
  };

  it('puts its own sentence about the ARGUMENT in front of ours', () => {
    const written = said(
      (program) =>
        program
          .command('approve')
          .argument('<id>', 'which job', refusing)
          .action(() => undefined),
      ['approve', 'seven']
    );

    expect(written).toBe(`error: command-argument value 'seven' is invalid for argument 'id'. ${OURS}`);
  });

  it('words an OPTION differently, and names the flag rather than the argument', () => {
    const written = said(
      (program) => program.option('--port <port>', 'the port to listen on', refusing).action(() => undefined),
      ['--port', 'seven']
    );

    expect(written).toBe(`error: option '--port <port>' argument 'seven' is invalid. ${OURS}`);
  });

  // What it does NOT compose anything around: its own structural complaints are its to word, and
  // the shop leaves them exactly as they are.
  it('says an unknown option in its own words, with nothing of ours in it', () => {
    const written = said((program) => program.option('--port <port>', 'the port to listen on').action(() => undefined), ['--nope']);

    expect(written).toBe("error: unknown option '--nope'");
  });
});
