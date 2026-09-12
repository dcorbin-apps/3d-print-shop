import { describe, it, expect } from '@jest/globals';
import {
  NotTheirs,
  UnusableRequest,
  addressIn,
  bodyOf,
  cookieIn,
  keyIn,
  loadedIn,
  loginIn,
  onePrinterName,
  passwordChangeIn,
  printerIn,
  requireItCameFromHere,
  requireTheirRole,
  requireUsablePrinterName,
  stoppedIn,
  tokenIn,
  verdictIn,
} from '../src/api';

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

describe('the verdict a body gives', () => {
  it.each([['approved'], ['rejected'], ['abandoned']])('takes %j, which is a verdict this shop records', (verdict) => {
    expect(verdictIn({ verdict })).toBe(verdict);
  });

  // The word arrived and was not one of the three, which is a different mistake from bringing no
  // body at all - and the answer says which by quoting what came.
  it('refuses a word that is not one of the three, saying what it was given', () => {
    expect(() => verdictIn({ verdict: 'good enough' })).toThrow('a verdict is approved, rejected or abandoned, not "good enough"');
  });

  it.each([[{}], [undefined], [{ verdict: null }], [{ verdict: 7 }], [{ verdict: ['approved'] }], [{ verdict: 'Approved' }]])(
    'refuses %p',
    (body) => {
      expect(() => verdictIn(body)).toThrow(UnusableRequest);
    }
  );

  // A request that brought nothing is a client's mistake worth naming as one, so the complaint still
  // says what a verdict is rather than that something was undefined.
  it('tells a request that brought no body what a verdict is', () => {
    expect(() => verdictIn(undefined)).toThrow('a verdict is approved, rejected or abandoned, not undefined');
  });
});

// AIDEV-NOTE: shape only, and that is the point - whether the password is RIGHT is the route's, and
// deliberately slow. Refusing a body that was never a login costs nothing and says nothing about who
// exists.
describe('the login a body carries', () => {
  it('is the name and the password it was given', () => {
    expect(loginIn({ id: 'dave', password: 'a password of some length' })).toEqual({ id: 'dave', password: 'a password of some length' });
  });

  it('carries nothing else the body happened to hold', () => {
    expect(loginIn({ id: 'dave', password: 'secret', role: 'admin' })).toEqual({ id: 'dave', password: 'secret' });
  });

  it.each([[{ id: 'dave' }], [{ password: 'a password' }], [{}], [undefined], [{ id: 7, password: 'a password' }], [{ id: 'dave', password: null }]])(
    'refuses %p, which is not a name and a password',
    (body) => {
      expect(() => loginIn(body)).toThrow(UnusableRequest);
      expect(() => loginIn(body)).toThrow('a login is an id and a password');
    }
  );

  // Empty is a shape this takes and the route refuses by hashing it like any other wrong one, which
  // is what keeps an empty password costing the same as a wrong one.
  it('takes an empty password, which is refused later and at the same price', () => {
    expect(loginIn({ id: 'dave', password: '' })).toEqual({ id: 'dave', password: '' });
  });
});

describe('the password change a body asks for', () => {
  it('is the one in use and the one wanted', () => {
    expect(passwordChangeIn({ current: 'the old one', password: 'the new one' })).toEqual({ current: 'the old one', password: 'the new one' });
  });

  // The id is whoever the request turned out to be, so a body naming somebody is not a way to change
  // theirs - there is nothing here for a name to land in.
  it('carries no name, whoever the body names', () => {
    expect(passwordChangeIn({ id: 'somebody else', current: 'a', password: 'b' })).toEqual({ current: 'a', password: 'b' });
  });

  it.each([[{ current: 'the old one' }], [{ password: 'the new one' }], [{}], [undefined], [{ current: 'a', password: 7 }], [{ current: null, password: 'b' }]])(
    'refuses %p, which is not both of them',
    (body) => {
      expect(() => passwordChangeIn(body)).toThrow(UnusableRequest);
      expect(() => passwordChangeIn(body)).toThrow('changing a password is the one you have now and the one you want');
    }
  );
});

// AIDEV-NOTE: the header a browser sends, read for one name. Every one of these was only ever
// reachable through a socket, where all a test could read back was the status the guard answered.
describe('the cookie a request carries', () => {
  const SESSION = 'print-shop-session';

  it('is the value written under the name asked for', () => {
    expect(cookieIn(`${SESSION}=abc123`, SESSION)).toBe('abc123');
  });

  it('finds it among the others a browser sent', () => {
    expect(cookieIn(`theme=dark; ${SESSION}=abc123; locale=en`, SESSION)).toBe('abc123');
  });

  it('minds the space a browser puts after each semicolon', () => {
    expect(cookieIn(`theme=dark;${SESSION}=abc123`, SESSION)).toBe('abc123');
  });

  // What express writes is encoded, so what is read back is decoded. The two are one mechanism.
  it('decodes what was encoded on the way out', () => {
    expect(cookieIn(`${SESSION}=a%2Fb%20c`, SESSION)).toBe('a/b c');
  });

  it.each([[undefined], [''], ['theme=dark'], [`${SESSION}`], [`=abc123`]])('is nobody at all for %j', (header) => {
    expect(cookieIn(header, SESSION)).toBeUndefined();
  });

  // AIDEV-NOTE: the 500 this used to be. `decodeURIComponent` throws a URIError on a truncated
  // escape, and it threw inside the guard before any credential was looked at - so a caller the shop
  // could not even name got a stack trace in its log. A cookie that will not decode is not one this
  // shop wrote, so it is no cookie, and the caller is refused for being unknown like anybody else.
  it.each([['%'], ['%E0'], ['%zz'], ['abc%']])('is nobody at all for a value of %j, rather than throwing', (value) => {
    expect(cookieIn(`${SESSION}=${value}`, SESSION)).toBeUndefined();
  });

  // Only the one asked for: an undecodable cookie of another name must not hide a good session.
  it('is unbothered by another cookie that will not decode', () => {
    expect(cookieIn(`theme=%E0; ${SESSION}=abc123`, SESSION)).toBe('abc123');
  });
});

describe('the token a request presents', () => {
  it('is what follows Bearer', () => {
    expect(tokenIn('Bearer abc123')).toBe('abc123');
  });

  it('keeps a token that has spaces in it, because the shop decides what a token may be', () => {
    expect(tokenIn('Bearer one two')).toBe('one two');
  });

  it.each([[undefined], [''], ['abc123'], ['bearer abc123'], ['Bearer'], ['Bearer '], ['Basic abc123']])(
    'is nobody at all for %j',
    (header) => {
      expect(tokenIn(header)).toBeUndefined();
    }
  );
});

// AIDEV-NOTE: the shop keeping the rule SameSite keeps in the browser. A cookie is sent by whatever
// page asked, so a write carrying one has to have come from this shop's own page.
describe('a write that has to have come from here', () => {
  const HERE = 'shop.local:4000';

  it('is let through when the origin is the host it arrived at', () => {
    expect(() => requireItCameFromHere(`http://${HERE}`, HERE)).not.toThrow();
  });

  it('minds neither the scheme nor a path on the origin, because the host is the question', () => {
    expect(() => requireItCameFromHere(`https://${HERE}`, HERE)).not.toThrow();
  });

  it('refuses one that came from somewhere else', () => {
    expect(() => requireItCameFromHere('http://somewhere.else', HERE)).toThrow(NotTheirs);
    expect(() => requireItCameFromHere('http://somewhere.else', HERE)).toThrow('is not this shop');
  });

  // A browser sends Origin on everything that is not a plain navigation, so one that says nothing is
  // not a browser doing what browsers do.
  it('refuses one that will not say where it came from', () => {
    expect(() => requireItCameFromHere(undefined, HERE)).toThrow('has to say where it came from');
  });

  it('refuses one that arrived at nowhere it can name', () => {
    expect(() => requireItCameFromHere(`http://${HERE}`, undefined)).toThrow(NotTheirs);
  });

  // A port is part of a host: a page on another port is another origin.
  it('refuses the same name on another port', () => {
    expect(() => requireItCameFromHere('http://shop.local:4001', HERE)).toThrow(NotTheirs);
  });

  // AIDEV-NOTE: the other 500. `Origin: null` is what a sandboxed iframe sends, and a redirect
  // across origins - `new URL` threw a TypeError on it, inside the guard. It was always going to be
  // refused; what was wrong was being refused as the shop's fault.
  it.each([['null'], ['not a url'], [''], ['http://']])('refuses an origin of %j rather than throwing', (origin) => {
    expect(() => requireItCameFromHere(origin, HERE)).toThrow(NotTheirs);
  });
});

// AIDEV-NOTE: the permission table, which is the security boundary - so what a user may NOT do is
// asserted route by route rather than in the general. Eighteen of these stood up an HTTP server to
// ask what a function makes of two strings, and answered with a status code; here the answer is
// which rule refused and in what words.
//
// What express hands the guard for a real request line is not this function's to say, and is pinned
// in tests/assumptions/theRequestLine.test.ts. That the guard is wired to this at all, and mounted
// where it must be, is tests/guard.test.ts.
describe('whether a route is an admin\'s', () => {
  const user = { id: 'slicer', name: 'slicer', role: 'user' as const };
  const admin = { id: 'dave', name: 'dave', role: 'admin' as const };

  const asksOf =
    (caller: typeof user | typeof admin, method: string, path: string): (() => void) =>
    (): void =>
      requireTheirRole(caller, method, path);

  describe('a route every caller may reach', () => {
    it.each([
      ['GET', '/jobs'],
      ['POST', '/jobs'],
      ['GET', '/jobs/1'],
      ['PUT', '/jobs/1/verdict'],
      ['GET', '/printers'],
      ['GET', '/me'],
      ['PUT', '/me/password'],
    ])('lets a user %s %s', (method, path) => {
      expect(asksOf(user, method, path)).not.toThrow();
    });
  });

  describe('a route only an admin may reach', () => {
    it.each([
      ['POST', '/shutdown'],
      ['POST', '/printers'],
      ['DELETE', '/printers/mk4'],
      ['PUT', '/printers/mk4/filament'],
      ['PUT', '/printers/mk4/status'],
      ['GET', '/filaments'],
      // AIDEV-NOTE: `DELETE /sessions` is deliberately absent. It is not on the open list, so a user
      // is refused it - which means a non-admin cannot log out. That looks wrong rather than
      // intended, and it is not this table's place to bless it; see PLAN.md.
    ])('refuses a user %s %s', (method, path) => {
      expect(asksOf(user, method, path)).toThrow(NotTheirs);
    });

    it.each([
      ['POST', '/shutdown'],
      ['DELETE', '/printers/mk4'],
      ['GET', '/filaments'],
    ])('lets an admin %s %s', (method, path) => {
      expect(asksOf(admin, method, path)).not.toThrow();
    });
  });

  // Says what was asked for and who asked, because a client that shows somebody what they may do has
  // to be able to tell them why it would not.
  it('says which route it was and that the caller is not an admin', () => {
    expect(asksOf(user, 'DELETE', '/printers/mk4')).toThrow('DELETE /printers/mk4 is for an admin, and slicer is not one');
  });

  // A route nobody classified needs an admin, so forgetting one makes the shop stricter rather than
  // looser - which is why the list is the routes a USER may have and not the ones an admin needs.
  it('refuses a user a route it has never heard of', () => {
    expect(asksOf(user, 'POST', '/something-added-later')).toThrow(NotTheirs);
  });

  // AIDEV-NOTE: express routes non-strictly, case-insensitively, and serves HEAD from a GET route, so
  // every one of these REACHES a route a user is entitled to. Comparing the path as written refused
  // them - and it failed CLOSED, so it only ever broke the less privileged caller: a client using a
  // trailing slash worked on an admin token and 403'd on a user one.
  describe('a path that reaches a route a user may have, written another way', () => {
    it.each([
      ['GET', '/jobs/'],
      ['GET', '/jobs//'],
      ['GET', '/JOBS'],
      ['GET', '/Jobs'],
      ['GET', '/printers/'],
      ['HEAD', '/jobs'],
      ['HEAD', '/jobs/'],
      ['PUT', '/jobs/1/verdict/'],
    ])('lets a user %s %s', (method, path) => {
      expect(asksOf(user, method, path)).not.toThrow();
    });

    // The normalising must not open anything: a trailing slash or a shout is still an admin's route.
    it.each([
      ['POST', '/shutdown/'],
      ['DELETE', '/PRINTERS/mk4'],
      ['PUT', '/printers/mk4/status/'],
      ['HEAD', '/filaments'],
    ])('still refuses a user %s %s', (method, path) => {
      expect(asksOf(user, method, path)).toThrow(NotTheirs);
    });

    // `/` is what a trailing-slash strip leaves of the root, and it is nobody's open route.
    it('refuses a user the root, which is what stripping slashes leaves of one', () => {
      expect(asksOf(user, 'GET', '/')).toThrow(NotTheirs);
    });
  });
});
