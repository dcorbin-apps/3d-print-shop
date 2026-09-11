import { describe, it, expect } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { askSecretly } from '../src/prompt';

// AIDEV-NOTE: a password is never an argument, because argv is `ps` and shell history - so it is
// asked for. What is proved here is the two paths that gives: a terminal, where the echo has to be
// off, and everything else, where a line is read so that a script or a test can drive it.
describe('asking for something nobody should read over a shoulder', () => {
  function aTerminal(): PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void } {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void; raw?: boolean };
    input.isTTY = true;
    input.setRawMode = (raw: boolean) => {
      input.raw = raw;
    };

    return input;
  }

  function whatIsWritten(): { output: PassThrough; said: () => string } {
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk: Buffer) => (written += chunk.toString()));

    return { output, said: () => written };
  }

  describe('at a terminal', () => {
    it('answers with what was typed, up to the return', async () => {
      const input = aTerminal();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.write('a password\r');

      expect(await asking).toBe('a password');
    });

    // The whole point. Not even a star per character: a count of them is a thing a shoulder reads.
    it('writes nothing of what was typed', async () => {
      const input = aTerminal();
      const { output, said } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.write('a password\r');
      await asking;

      expect(said()).toBe('password: \n');
    });

    it('takes a character back when it is rubbed out', async () => {
      const input = aTerminal();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.write('a passwordX\r');

      expect(await asking).toBe('a password');
    });

    // In raw mode Ctrl-C is a character rather than a signal, so nothing else would ever stop this -
    // and a person who changed their mind would be stuck at a prompt that says nothing.
    it('gives up when somebody interrupts it, rather than waiting for ever', async () => {
      const input = aTerminal();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.write('');

      await expect(asking).rejects.toThrow('nothing was changed');
    });

    it('leaves the terminal as it found it', async () => {
      const input = aTerminal();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.write('a password\r');
      await asking;

      expect((input as { raw?: boolean }).raw).toBe(false);
    });
  });

  // A pipe, a script, a test: there is no terminal to stop echoing, and a line is what arrives.
  describe('anywhere else', () => {
    it('reads a line', async () => {
      const input = new PassThrough();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.end('a password\n');

      expect(await asking).toBe('a password');
    });

    it('reads only the first line, so two answers are two questions', async () => {
      const input = new PassThrough();
      const { output } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.end('a password\nand another\n');

      expect(await asking).toBe('a password');
    });

    // Nothing is asked out loud either, because nothing is listening for it.
    it('does not write a prompt at something that cannot answer one', async () => {
      const input = new PassThrough();
      const { output, said } = whatIsWritten();

      const asking = askSecretly('password: ', input, output);
      input.end('a password\n');
      await asking;

      expect(said()).toBe('');
    });
  });
});
