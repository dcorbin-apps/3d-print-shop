import { describe, it, expect } from '@jest/globals';
import { digestOf, hashPassword, isThePassword, newToken, sameSecret } from '../src/secrets';

describe('a token the shop issued', () => {
  it('is not the token twice running', () => {
    expect(newToken()).not.toBe(newToken());
  });

  // Long enough that guessing is not a thing that happens, which is what lets its hash be a fast
  // one - and hex, so a token copied out of a terminal cannot pick up a character on the way.
  it('is 32 bytes of randomness, said in hex', () => {
    expect(newToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('as it is stored', () => {
    it('is the same digest every time, which is what lets it be looked up', () => {
      expect(digestOf('a-token')).toBe(digestOf('a-token'));
    });

    it('is a different digest for a different token', () => {
      expect(digestOf('a-token')).not.toBe(digestOf('another-token'));
    });

    // The whole point of storing it hashed: the file cannot be read back into a working credential.
    it('is nothing like the token it was made from', () => {
      expect(digestOf('a-token')).not.toContain('a-token');
    });
  });
});

// AIDEV-NOTE: slow on purpose, so these are the tests that cost something. A password is whatever a
// person chose and is therefore guessable, which is what a memory-hard function is for.
describe('a password a person chose', () => {
  it('is recognised by the hash it was made from', async () => {
    expect(await isThePassword('correct horse', await hashPassword('correct horse'))).toBe(true);
  }, 10_000);

  it('is not recognised by a hash made from a different one', async () => {
    expect(await isThePassword('not it', await hashPassword('correct horse'))).toBe(false);
  }, 10_000);

  // Salted, so two people who chose the same password do not have the same hash - which is what
  // stops one stolen file answering "who else uses this password" for free.
  it('hashes differently every time, however often it is the same password', async () => {
    expect(await hashPassword('correct horse')).not.toBe(await hashPassword('correct horse'));
  }, 10_000);

  it('is still recognised by either of them', async () => {
    const [one, other] = [await hashPassword('correct horse'), await hashPassword('correct horse')];

    expect(await isThePassword('correct horse', one)).toBe(true);
    expect(await isThePassword('correct horse', other)).toBe(true);
  }, 15_000);

  // What it cost travels with it, so raising the cost later leaves everything already stored
  // readable rather than locking everybody out.
  it('carries the function and what it cost', async () => {
    expect(await hashPassword('correct horse')).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  }, 10_000);

  it('is read at a cost it was made with rather than the one in force now', async () => {
    const cheaper = ['scrypt', 1024, 8, 1].join('$');
    const madeCheaply = (await hashPassword('correct horse')).replace(/^scrypt\$\d+\$\d+\$\d+/, cheaper);

    // Not the same hash, so it must not be accepted - what matters is that it was READ and refused
    // rather than thrown at, which is the same thing a different cost has to be.
    expect(await isThePassword('correct horse', madeCheaply)).toBe(false);
  }, 10_000);

  // AIDEV-NOTE: a hash nobody can make sense of is a credential nobody can present - it must not
  // throw, and it must certainly not become a way in. A file gets edited by hand.
  it.each([[''], ['not a hash'], ['scrypt$'], ['scrypt$0$8$1$aa$bb'], ['bcrypt$1$2$3$aa$bb'], ['scrypt$x$y$z$aa$bb']])(
    'is not recognised by %p, and does not throw',
    async (mangled) => {
      expect(await isThePassword('correct horse', mangled)).toBe(false);
    },
    10_000,
  );
});

describe('comparing two secrets', () => {
  it('says two of the same are the same', () => {
    expect(sameSecret(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
  });

  it('says two different ones are not', () => {
    expect(sameSecret(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
  });

  // timingSafeEqual throws on a length mismatch rather than answering, and the length of a stored
  // hash is not a secret - so the length is checked first and answered as a plain no.
  it('says so rather than throwing when they are not even the same length', () => {
    expect(sameSecret(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
