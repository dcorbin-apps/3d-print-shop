import { describe, it, expect } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import { readMegabytes, readPort } from '../src/cli';

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
