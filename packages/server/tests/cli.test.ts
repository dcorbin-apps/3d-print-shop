import { describe, it, expect } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import { readPort } from '../src/cli';

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
