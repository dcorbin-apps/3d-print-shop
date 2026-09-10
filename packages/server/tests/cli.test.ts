import { describe, it, expect } from '@jest/globals';
import { InvalidArgumentError } from 'commander';
import { createCLI, readMegabytes, readPort, unknownCommandIn } from '../src/cli';

// AIDEV-NOTE: commander answers a --help anywhere in argv before deciding whether the command in
// front of it exists, so a typo that happens to carry one was answered with help and exit 0 - which
// a script cannot tell from success. Driven against the REAL command tree rather than a stub: what
// this has to agree with is the commands the shop actually has.
describe('a command the shop does not have', () => {
  const asked = (line: string): string | undefined => unknownCommandIn(createCLI(), line.split(' ').filter((word) => word !== ''));

  it.each([
    ['nonsense'],
    ['add printer add'],
    ['printer nonsense'],
    ['job nonsense'],
  ])('names the word in %p that is not a command', (line) => {
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
    ['serve --spool /tmp/spool --etc /tmp/etc'],
    ['init dave'],
    ['shutdown'],
  ])('finds nothing wrong with %p', (line) => {
    expect(asked(line)).toBeUndefined();
  });

  // An argument is not a command. `job approve 7` must not have 7 looked up as one.
  it.each([['job approve 7'], ['printer stop mk4 "the door is open"'], ['printer load mk4 PLA-Red']])('reads what follows %p as arguments', (line) => {
    expect(asked(line)).toBeUndefined();
  });

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
