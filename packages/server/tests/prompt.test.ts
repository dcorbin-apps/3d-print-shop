import { describe, it, expect } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { askSecretly, askSecretlyTwice } from '../src/prompt';

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

// AIDEV-NOTE: asked TWICE in one call rather than by calling askSecretly twice, because a stream that
// is not a terminal ENDS - and a second read of an ended pipe waits for an 'end' that has already
// happened, which is a process that neither answers nor stops.
describe('asking for the same thing twice', () => {
  function aTerminal(): PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void } {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };
    input.isTTY = true;
    input.setRawMode = () => undefined;

    return input;
  }

  describe('at a terminal', () => {
    it('answers with both of them, in the order they were typed', async () => {
      const input = aTerminal();
      const asking = askSecretlyTwice('password: ', 'and again: ', input, new PassThrough());

      input.write('one\r');
      input.write('two\r');

      expect(await asking).toEqual(['one', 'two']);
    });

    it('asks both questions out loud', async () => {
      const input = aTerminal();
      const output = new PassThrough();
      let written = '';
      output.on('data', (chunk: Buffer) => (written += chunk.toString()));

      const asking = askSecretlyTwice('password: ', 'and again: ', input, output);
      input.write('one\r');
      input.write('two\r');
      await asking;

      expect(written).toContain('password: ');
      expect(written).toContain('and again: ');
    });

    it('writes neither of them', async () => {
      const input = aTerminal();
      const output = new PassThrough();
      let written = '';
      output.on('data', (chunk: Buffer) => (written += chunk.toString()));

      const asking = askSecretlyTwice('password: ', 'and again: ', input, output);
      input.write('a secret\r');
      input.write('a secret\r');
      await asking;

      expect(written).not.toContain('a secret');
    });
  });

  // A pipe, a script, a test: one read of the whole thing, split into lines - which is what lets
  // this be driven without a terminal at all.
  describe('anywhere else', () => {
    it('reads the two as two lines', async () => {
      const input = new PassThrough();
      const asking = askSecretlyTwice('password: ', 'and again: ', input, new PassThrough());

      input.end('one\ntwo\n');

      expect(await asking).toEqual(['one', 'two']);
    });

    it('answers with what was given even when the two do not match', async () => {
      const input = new PassThrough();
      const asking = askSecretlyTwice('password: ', 'and again: ', input, new PassThrough());

      input.end('one\nanother\n');

      expect(await asking).toEqual(['one', 'another']);
    });

    // Nothing typed is still an answer: whether an empty password is allowed is the caller's rule,
    // not this one's.
    it('answers with two empty strings for two empty lines', async () => {
      const input = new PassThrough();
      const asking = askSecretlyTwice('password: ', 'and again: ', input, new PassThrough());

      input.end('\n\n');

      expect(await asking).toEqual(['', '']);
    });
  });
});
