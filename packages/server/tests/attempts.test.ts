import { describe, it, expect, beforeEach } from '@jest/globals';
import { Attempts } from '../src/attempts';

// AIDEV-NOTE: counted in real numbers rather than in FREELY and the wait constants, deliberately.
// Said in the symbols, a test moves whenever the symbol does - so a shop that made somebody wait for
// one mistyped password went on passing all of them. Three free, then a second, doubling to five
// minutes, forgotten after fifteen: those are decisions about people, and this is where they are
// written down.
const A_SECOND = 1000;
const A_QUARTER_HOUR = 15 * 60 * 1000;

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

  it('stops doubling at a quarter of an hour, however many are got wrong', () => {
    const attempts = anAttempts();

    wrongTimes(attempts, 40, 'dave');

    expect(attempts.mustWait('dave')).toBe(A_QUARTER_HOUR);
  });

  // AIDEV-NOTE: what the cap and the forget window standing in that relation actually BUY, asked as
  // behaviour rather than as a comparison of two constants. While the cap was the shorter of the
  // two there was a moment when the wait had run out and the count had not gone cold, and a guesser
  // who landed one wrong guess in it put the clock back - for ever, twelve requests an hour, with
  // the caller holding the right password the whole time. Waiting a wait out now costs the guesser
  // everything they had counted up.
  it('leaves a guesser who serves out the longest wait with nothing counted up', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 40, 'dave');

    // Served out exactly as long as it was told to, which is what an attacker does and what the
    // hour hardcoded here could not say: the wait and the window have to be read against each other.
    clock += attempts.mustWait('dave');
    attempts.wasWrong('dave');

    expect(attempts.mustWait('dave')).toBe(0);
  });

  // The other side of the same boundary: at the window it is gone, not merely servable. A wait that
  // outlasted the count by even a millisecond is the moment the whole of the above turns on.
  it('has forgotten the count at the moment the wait it set is up', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 40, 'dave');

    clock += attempts.mustWait('dave');

    // Asked again rather than read cold: an entry is swept on the way IN, so asking is what expires
    // it. The claim here is what is LEFT afterwards - where a wait that outlasts the window by even
    // a millisecond leaves a count standing for a guesser to build on.
    expect(attempts.mustWait('dave')).toBe(0);
    expect(attempts.remembered).toBe(0);
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

    clock += A_QUARTER_HOUR + 1;

    expect(attempts.mustWait('dave')).toBe(0);
  });

  // Counted afresh rather than carried on from where it left off: somebody who has been away for
  // a quarter of an hour is a person who forgot, not the guesser who was here before.
  it('starts the count again for somebody who comes back cold', () => {
    const attempts = anAttempts();
    wrongTimes(attempts, 40, 'dave');
    clock += A_QUARTER_HOUR + 1;

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

      clock += A_QUARTER_HOUR + 1;
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
