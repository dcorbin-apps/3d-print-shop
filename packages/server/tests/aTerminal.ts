import { PassThrough } from 'node:stream';

export type AFakeTerminal = PassThrough & { isTTY?: boolean; setRawMode?: (raw: boolean) => void; raw?: boolean };

/** Enough of a terminal for a prompt to take the path that turns the echo off. */
export function aTerminal(): AFakeTerminal {
  const input = new PassThrough() as AFakeTerminal;
  input.isTTY = true;
  input.setRawMode = (raw: boolean) => {
    input.raw = raw;
  };

  return input;
}

/** Somewhere a prompt writes, and what it has written there so far. */
export function whatIsWritten(): { output: PassThrough; said: () => string } {
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => (written += chunk.toString()));

  return { output, said: () => written };
}
