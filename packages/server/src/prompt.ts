import type { Readable, Writable } from 'node:stream';

/** Where a secret is typed. A terminal when there is one, and a stream that ends when there is not. */
export type Asked = Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };

// AIDEV-NOTE: a password is not an argument, ever. argv is in `ps` for every user on the machine and
// in the shell's history file afterwards, which is the same reason a printer's key was never a flag.
// So it is asked for, and the terminal is told not to echo it.
//
// Raw mode rather than readline: readline cannot stop a terminal echoing what is typed into it, and
// the only ways round that are a private field or a dependency. Not a terminal at all - a pipe, a
// test, a script - reads a line, which is what lets this be driven without one.

// AIDEV-NOTE: both questions here rather than two calls, because a stream that is not a terminal
// ENDS - and a second read of an ended pipe waits for an 'end' that has already happened, which is a
// process that neither answers nor stops. Asked twice at a terminal, where the stream stays open;
// read as two lines from one read anywhere else.
/** Ask for the same thing twice, because nobody can see what they typed the first time. */
export async function askSecretlyTwice(
  asking: string,
  again: string,
  input: Asked = process.stdin,
  output: Writable = process.stdout,
): Promise<[string, string]> {
  if (input.isTTY === true && input.setRawMode !== undefined) {
    return [await askSecretly(asking, input, output), await askSecretly(again, input, output)];
  }

  const [said = '', confirmed = ''] = await readLines(input);

  return [said, confirmed];
}

/** Ask for something nobody should be able to read over a shoulder, and answer with what was typed. */
export async function askSecretly(asking: string, input: Asked = process.stdin, output: Writable = process.stdout): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) return readALine(input);

  output.write(asking);
  input.setRawMode(true);
  input.resume();

  try {
    const said = await readWithoutEcho(input, output);
    output.write('\n');

    return said;
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}

const ENTER = ['\r', '\n'];
const BACKSPACE = ['', ''];
const INTERRUPT = '';

function readWithoutEcho(input: Readable, output: Writable): Promise<string> {
  return new Promise((typed, gaveUp) => {
    let said = '';

    const read = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (ENTER.includes(character)) {
          input.off('data', read);
          typed(said);
          return;
        }

        // Ctrl-C, which in raw mode is a character rather than a signal - so nothing else would
        // ever stop this, and a person who changed their mind would be stuck at a silent prompt.
        if (character === INTERRUPT) {
          input.off('data', read);
          gaveUp(new Error('nothing was changed'));
          return;
        }

        if (BACKSPACE.includes(character)) said = said.slice(0, -1);
        else said += character;

        // Nothing is echoed, not even a star: a count of the characters is a thing a shoulder can
        // read, and a person typing a password knows what they typed.
      }
    };

    input.on('data', read);
    output.write('');
  });
}

async function readALine(input: Readable): Promise<string> {
  return (await readLines(input))[0] ?? '';
}

// Read whole rather than a line at a time: what is on the other end is a pipe or a file, which ends,
// and the alternative is a second read of something that has already finished.
function readLines(input: Readable): Promise<string[]> {
  return new Promise((lines, wrong) => {
    let said = '';

    input.setEncoding('utf-8');
    input.on('data', (chunk: string) => (said += chunk));
    input.on('end', () => lines(said.split('\n')));
    input.on('error', wrong);
  });
}
