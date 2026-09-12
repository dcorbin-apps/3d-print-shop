import { describe, it, expect } from '@jest/globals';
import { UnusableRequest, onePrinterName } from '../src/api';

// AIDEV-NOTE: the name in a QUERY string, which is the second of the three ways one arrives - the
// others being a path segment, checked at the `/printers/:name` mount, and a body, checked in
// `printerIn`. It is a plain function over a value, so it is tested as one. What a running shop adds
// is whether the route is wired to it at all, and that is ONE acceptance test rather than twelve.
describe('the one printer a request may name in its query', () => {
  const naming =
    (asked: unknown): (() => string | undefined) =>
    (): string | undefined =>
      onePrinterName(asked);

  describe('naming nothing', () => {
    // Not a refusal: the whole shop is the answer when nobody names a machine.
    it('is nobody in particular when the parameter is left out', () => {
      expect(onePrinterName(undefined)).toBeUndefined();
    });

    it.each([[''], [' '], ['\t'], ['\n']])('refuses %j, which named something and then did not', (asked) => {
      expect(naming(asked)).toThrow(UnusableRequest);
      expect(naming(asked)).toThrow('printer names one machine');
    });
  });

  // AIDEV-NOTE: express parses `?printer=a&printer=b` into an array and `?printer[x]=y` into an
  // object, so what arrives is not a string because a caller wrote one. Answering for the whole shop
  // when somebody asked about one machine would be the wrong answer said confidently.
  describe('naming more than one thing', () => {
    it.each([[['mk4', 'mini']], [{ x: 'y' }], [7], [null], [true]])('refuses %p, which is not one name', (asked) => {
      expect(naming(asked)).toThrow(UnusableRequest);
      expect(naming(asked)).toThrow('printer names one machine');
    });
  });

  // AIDEV-NOTE: a name becomes a DIRECTORY under the state root, so one that climbs out of it read a
  // printer.json from anywhere the service user could - and the answer said which case it was: a
  // file that parsed was 200, one that was not there 404, one that was not JSON 500.
  describe('naming something a directory cannot be called', () => {
    it.each([['../../etc'], ['../..'], ['..'], ['.'], ['a/b'], ['back\\slash'], ['/etc/passwd'], ['nested/printer']])(
      'refuses %j, which would not stay in the directory it names',
      (asked) => {
        expect(naming(asked)).toThrow(UnusableRequest);
        expect(naming(asked)).toThrow('is not a name a printer can have');
      },
    );

    it.each([['a\u0000b'], ['a\u001Fb'], ['a\u007Fb']])('refuses %j, which carries what a path cannot hold', (asked) => {
      expect(naming(asked)).toThrow('is not a name a printer can have');
    });
  });

  // A name with a space, a dot or a '#' in it is legal and reaches the shop encoded. Refusing those
  // would be the guard overreaching on a machine somebody named reasonably.
  describe('naming a machine', () => {
    it.each([['mk4'], ['Prusa MK4'], ['mk4#two'], ['mini-2'], ['a.b'], ['...'], ['.hidden']])('takes %j', (asked) => {
      expect(onePrinterName(asked)).toBe(asked);
    });
  });
});
