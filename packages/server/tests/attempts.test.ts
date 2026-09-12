import { describe, it, expect, beforeEach } from '@jest/globals';
import { Attempts } from '../src/attempts';

// AIDEV-NOTE: counted in real numbers rather than in FREELY and the wait constants, deliberately.
// Said in the symbols, a test moves whenever the symbol does - so a shop that made somebody wait for
// one mistyped password went on passing all of them. Three free, then a second, doubling to five
// minutes, forgotten after fifteen: those are decisions about people, and this is where they are
// written down.
const A_SECOND = 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

describe('how long a caller must wait before another go', () => {
  let clock: number;

  const at = (): number => clock;
  const anAttempts = (): Attempts => new Attempts(at);

  const wrongTimes = (attempts: Attempts, times: number, id: string): void => {
    for (let tried = 0; tried < times; tried += 1) attempts.wasWrong(id);
  };

  beforeEach(() => {
    clock = Date.parse('2026-09-12T09:00:00Z');
  });

  it('lets a person mistype their own password three times without being made to wait', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 3, 'dave');

    expect(attempts.mustWait('dave')).toBe(0);
  });

  it('makes them wait a second on the fourth', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 4, 'dave');

    expect(attempts.mustWait('dave')).toBe(A_SECOND);
  });

  it('doubles the wait with every further one', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 6, 'dave');

    expect(attempts.mustWait('dave')).toBe(4 * A_SECOND);
  });

  it('stops doubling at five minutes, however many are got wrong', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 40, 'dave');

    expect(attempts.mustWait('dave')).toBe(FIVE_MINUTES);
  });

  it('counts down as the wait is served', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 4, 'dave');

    clock += A_SECOND;

    expect(attempts.mustWait('dave')).toBe(0);
  });

  // The person who has just proved who they are is not the attacker, and leaving the count
  // standing would let somebody else lock them out by getting their password wrong on purpose.
  it('forgets what was counted against somebody who then gets it right', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 4, 'dave');

    attempts.wasRight('dave');

    expect(attempts.mustWait('dave')).toBe(0);
  });

  it('lets a person locked out by a bad afternoon back in a quarter of an hour later', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 40, 'dave');

    clock += 15 * 60 * 1000 + 1;

    expect(attempts.mustWait('dave')).toBe(0);
  });

  // Counted afresh rather than carried on from where it left off: somebody who has been away for
  // a quarter of an hour is a person who forgot, not the guesser who was here before.
  it('starts the count again for somebody who comes back cold', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 40, 'dave');
    clock += 15 * 60 * 1000 + 1;

    wrongTimes(attempts, 4, 'dave');

    expect(attempts.mustWait('dave')).toBe(A_SECOND);
  });

  // AIDEV-NOTE: the bug this file exists for. The count used to be kept against the ADDRESS as well
  // as the id, and on loopback an address never varies - so a name the shop does not even have could
  // put every caller who does behind a five-minute wait while holding the right password.
  it('makes nobody else wait, whoever was guessed at', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 40, 'no-such-account');

    expect(attempts.mustWait('dave')).toBe(0);
  });

  // AIDEV-NOTE: an entry used to be dropped only when its OWN id was asked about again, so an id
  // somebody invented was never asked about again and was kept for as long as the shop ran.
  describe('what it is still counting against', () => {
    it('forgets an id nobody ever asks about again', () => {
      const attempts = anAttempts();
      for (let made = 0; made < 50; made += 1) attempts.wasWrong(`invented-${made}`);
      expect(attempts.remembered).toBe(50);

      clock += 15 * 60 * 1000 + 1;
      attempts.wasWrong('dave');

      expect(attempts.remembered).toBe(1);
    });

    it('keeps the ones that have not gone cold yet', () => {
      const attempts = anAttempts();
      for (let made = 0; made < 50; made += 1) attempts.wasWrong(`invented-${made}`);

      clock += 60 * 1000;
      attempts.wasWrong('dave');

      expect(attempts.remembered).toBe(51);
    });
  });
});
