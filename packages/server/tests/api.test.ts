import { describe, it, expect } from '@jest/globals';
import { UnusableRequest, addressIn, bodyOf, keyIn, loadedIn, onePrinterName, printerIn, requireUsablePrinterName, stoppedIn } from '../src/api';

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

// AIDEV-NOTE: the name in a PATH, checked at the `/printers/:name` mount, and in a BODY, checked by
// `printerIn`. The rule is one function over a string; about thirty acceptance cases used to stand up
// a server to ask it, which reports a status code where this reports which rule refused.
describe('what a printer may be called', () => {
  const calling =
    (name: string): (() => void) =>
    (): void =>
      requireUsablePrinterName(name);

  // AIDEV-NOTE: a name becomes a DIRECTORY under the state root and `removePrinter` deletes that
  // directory recursively, so a name from a request is a path fragment a client chose.
  it.each([['../../etc'], ['..'], ['.'], ['a/b'], ['back\\slash'], ['/etc'], ['nested/deep']])(
    'refuses %j, which would not stay in the directory it names',
    (name) => {
      expect(calling(name)).toThrow(UnusableRequest);
      expect(calling(name)).toThrow('is not a name a printer can have');
    },
  );

  it.each([[''], [' '], ['\t'], ['\n'], ['   ']])('refuses %j, which is not a name at all', (name) => {
    expect(calling(name)).toThrow('is not a name a printer can have');
  });

  it.each([['a\u0000b'], ['a\u007Fb']])('refuses %j, which carries what a path cannot hold', (name) => {
    expect(calling(name)).toThrow('is not a name a printer can have');
  });

  // Overreaching here would refuse a machine somebody named reasonably: these are all legal, and
  // only needed encoding on the way in.
  it.each([['mk4'], ['Prusa MK4'], ['mk4#two'], ['mini-2'], ['a.b'], ['...'], ['.hidden'], ['20mm-box']])('takes %j', (name) => {
    expect(calling(name)).not.toThrow();
  });
});

// AIDEV-NOTE: what is checked is the SHAPE - a URL the shop can build requests from, over a protocol
// it speaks, carrying nothing that has no business in a base URL. Where it points is not checked, and
// that decision is recorded in PLAN.md rather than half-answered here.
describe('where a printer may be pointed', () => {
  const pointing =
    (address: string): (() => string) =>
    (): string =>
      addressIn(address);

  it.each([['http://octopi.local'], ['https://octopi.local'], ['http://10.0.0.7:5000'], ['http://octopi.local/prusa']])(
    'takes %j',
    (address) => {
      expect(addressIn(address)).toBe(address);
    },
  );

  // Every request appends its own path, so a trailing slash would double the separator.
  it.each([['http://octopi.local/'], ['http://octopi.local///']])('keeps %j without the trailing slash', (address) => {
    expect(addressIn(address)).toBe('http://octopi.local');
  });

  it.each([['octopi.local'], ['not a url'], ['']])('refuses %j, which is not a URL', (address) => {
    expect(pointing(address)).toThrow(UnusableRequest);
    expect(pointing(address)).toThrow('it is not a URL');
  });

  it.each([['ftp://octopi.local'], ['file:///etc/passwd'], ['ws://octopi.local']])(
    'refuses %j, a protocol this shop does not speak',
    (address) => {
      expect(pointing(address)).toThrow('this shop speaks http and https');
    },
  );

  // Refused rather than dropped: ignoring half of what an operator typed is how a shop ends up
  // talking to something other than what they meant.
  it('refuses an address carrying a username and password, because a printer is reached with its key', () => {
    expect(pointing('http://user:pass@octopi.local')).toThrow('it carries a username and password');
  });

  it.each([['http://octopi.local?a=1'], ['http://octopi.local#frag']])('refuses %j, which has something after the path', (address) => {
    expect(pointing(address)).toThrow('with nothing after them');
  });

  // A printer reached over a VPN is legitimate, and a hostname resolves at connect time - so an
  // add-time range check would be defeated by rebinding anyway. See PLAN.md.
  it.each([['http://127.0.0.1:5000'], ['http://192.168.1.9'], ['https://printer.example.com']])('does not mind where %j points', (address) => {
    expect(addressIn(address)).toBe(address);
  });
});

// AIDEV-NOTE: express.json() leaves `body` undefined when there was none, or when it did not say it
// was JSON - and destructuring that throws a TypeError, which reaches a client as a 500.
describe('the body a request brought', () => {
  it.each([[undefined], [null], ['a string'], [7], [true]])('is an empty object when the body was %p', (body) => {
    expect(bodyOf(body)).toEqual({});
  });

  it('is the body itself when there was one', () => {
    expect(bodyOf({ stopped: true })).toEqual({ stopped: true });
  });

  // An array IS an object, and reading a field off one is undefined rather than a throw - which is
  // what every caller of this then complains about in its own words.
  it('is an array as it came, because reading a field off one is nobody a surprise', () => {
    expect(bodyOf(['a'])).toEqual(['a']);
  });
});

describe('what an operator says is loaded', () => {
  const loading =
    (body: unknown): (() => string[]) =>
    (): string[] =>
      loadedIn(body);

  it('takes the filaments in the order they were given', () => {
    expect(loadedIn({ loaded: ['PLA-Red', 'PLA-White'] })).toEqual(['PLA-Red', 'PLA-White']);
  });

  // An empty list is an answer: the machine has nothing on it.
  it('takes an empty machine for an answer', () => {
    expect(loadedIn({ loaded: [] })).toEqual([]);
  });

  it.each([[{}], [{ loaded: 'PLA-Red' }], [{ loaded: 7 }], [{ loaded: null }], [undefined]])('refuses %p, which is not a list', (body) => {
    expect(loading(body)).toThrow(UnusableRequest);
    expect(loading(body)).toThrow('loaded is the filaments on the machine');
  });

  it.each([[{ loaded: [''] }], [{ loaded: ['  '] }], [{ loaded: ['PLA-Red', 7] }], [{ loaded: [null] }]])(
    'refuses %p, which names a filament that is not one',
    (body) => {
      expect(loading(body)).toThrow('loaded is the filaments on the machine');
    },
  );
});

describe('an operator stopping a printer or starting it', () => {
  const saying =
    (body: unknown): (() => unknown) =>
    (): unknown =>
      stoppedIn(body);

  it('is stopping it, with the reason somebody should see', () => {
    expect(stoppedIn({ stopped: true, reason: 'the door is open' })).toEqual({ stopped: true, reason: 'the door is open' });
  });

  // Starting one needs no explanation - demanding one would be the shop asking an operator to
  // justify having fixed something.
  it('is starting it, and needs no reason for that', () => {
    expect(stoppedIn({ stopped: false })).toEqual({ stopped: false });
  });

  it.each([[{ stopped: true }], [{ stopped: true, reason: '' }], [{ stopped: true, reason: '   ' }], [{ stopped: true, reason: 7 }]])(
    'refuses %p, because stopping a machine without a reason leaves nobody anything to act on',
    (body) => {
      expect(saying(body)).toThrow(UnusableRequest);
      expect(saying(body)).toThrow('needs a reason an operator can act on');
    },
  );

  it.each([[{}], [{ stopped: 'yes' }], [{ stopped: 1 }], [{ stopped: null }], [undefined]])('refuses %p, which says neither', (body) => {
    expect(saying(body)).toThrow('says stopped true or false');
  });
});

// AIDEV-NOTE: a key is read apart from the record and never folded into it - `printerIn` builds a
// fresh object of the four fields a printer IS, so a key cannot follow one into printer.json however
// the body was shaped.
describe('the key a printer is reached by', () => {
  it('is absent for a printer nobody has given one to', () => {
    expect(keyIn({ name: 'mk4' })).toBeUndefined();
  });

  it('is the string the shop reaches the machine with', () => {
    expect(keyIn({ key: 'ABC123' })).toBe('ABC123');
  });

  it.each([[{ key: '' }], [{ key: '   ' }], [{ key: 7 }], [{ key: null }]])('refuses %p, which meant to give one and did not', (body) => {
    expect(() => keyIn(body)).toThrow(UnusableRequest);
  });
});

describe('the printer a body describes', () => {
  const MK4 = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, address: 'http://octopi.local' };

  it('is the four fields a printer is', () => {
    expect(printerIn(MK4)).toEqual({ ...MK4, api: 'octoprint' });
  });

  // The key is read apart from the record, so it cannot follow the body into printer.json.
  it('never carries the key that arrived beside it', () => {
    expect(printerIn({ ...MK4, key: 'ABC123' })).not.toHaveProperty('key');
  });

  it('carries nothing else the body happened to hold', () => {
    expect(printerIn({ ...MK4, loaded: ['PLA'], holding: { job: 7 } })).toEqual({ ...MK4, api: 'octoprint' });
  });

  it.each([[{ ...MK4, name: undefined }], [{ ...MK4, name: '' }], [{ ...MK4, name: 7 }]])('refuses %p, which has no usable name', (body) => {
    expect(() => printerIn(body)).toThrow(UnusableRequest);
  });

  it('refuses a name that names a directory somewhere else', () => {
    expect(() => printerIn({ ...MK4, name: '../../etc' })).toThrow('is not a name a printer can have');
  });

  it.each([[undefined], [''], ['   ']])('refuses an address of %j', (address) => {
    expect(() => printerIn({ ...MK4, address })).toThrow('needs an address');
  });

  it.each([
    [{ x: 0, y: 210, z: 220 }],
    [{ x: -1, y: 210, z: 220 }],
    [{ x: 250, y: 210 }],
    [{ x: '250', y: 210, z: 220 }],
    [{ x: Number.NaN, y: 210, z: 220 }],
    [{ x: Number.POSITIVE_INFINITY, y: 210, z: 220 }],
    [undefined],
  ])('refuses the build volume %p', (buildVolume) => {
    expect(() => printerIn({ ...MK4, buildVolume })).toThrow('a build volume is x, y and z in mm');
  });

  it('refuses a protocol this shop does not speak', () => {
    expect(() => printerIn({ ...MK4, api: 'klipper' })).toThrow('is not a protocol this shop speaks');
  });
});
