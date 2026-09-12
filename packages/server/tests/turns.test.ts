import { describe, it, expect } from '@jest/globals';
import { atMostAtOnce } from '../src/turns';

// AIDEV-NOTE: driven by hand rather than by a clock, so nothing here waits on real time and nothing
// is flaky. Each piece of work settles only when the test says so, which is what makes "how many are
// running right now" a thing that can be asserted at all.
interface Work {
  started: boolean;
  finish: () => void;
  fail: (why: Error) => void;
  done: Promise<unknown>;
}

describe('at most so many at once', () => {
  const settledElsewhere = (): Promise<void> => new Promise((soon) => setImmediate(soon));

  const started = (inTurn: ReturnType<typeof atMostAtOnce>): Work => {
    const work: Partial<Work> = { started: false };

    work.done = inTurn(
      () =>
        new Promise<void>((finish, fail) => {
          work.started = true;
          work.finish = () => finish();
          work.fail = fail;
        }),
    );

    return work as Work;
  };

  it('starts work when there is room for it', async () => {
    const inTurn = atMostAtOnce(2);

    const one = started(inTurn);
    await settledElsewhere();

    expect(one.started).toBe(true);
  });

  it('starts as many at once as it was told to', async () => {
    const inTurn = atMostAtOnce(2);

    const [one, another] = [started(inTurn), started(inTurn)];
    await settledElsewhere();

    expect([one.started, another.started]).toEqual([true, true]);
  });

  it('holds the next one back until there is room', async () => {
    const inTurn = atMostAtOnce(2);
    const [one, another] = [started(inTurn), started(inTurn)];

    const third = started(inTurn);
    await settledElsewhere();

    expect(third.started).toBe(false);
    expect([one.started, another.started]).toEqual([true, true]);
  });

  it('lets the next one go when one finishes', async () => {
    const inTurn = atMostAtOnce(2);
    const [one] = [started(inTurn), started(inTurn)];
    const third = started(inTurn);

    one.finish();
    await settledElsewhere();

    expect(third.started).toBe(true);
  });

  it('lets them go in the order they arrived', async () => {
    const inTurn = atMostAtOnce(1);
    const first = started(inTurn);
    const [second, third] = [started(inTurn), started(inTurn)];

    first.finish();
    await settledElsewhere();
    expect([second.started, third.started]).toEqual([true, false]);

    second.finish();
    await settledElsewhere();
    expect(third.started).toBe(true);
  });

  it('never runs more than it was told to, however many are waiting', async () => {
    const inTurn = atMostAtOnce(2);

    const all = [started(inTurn), started(inTurn), started(inTurn), started(inTurn), started(inTurn)];
    await settledElsewhere();

    expect(all.filter((work) => work.started)).toHaveLength(2);
  });

  // AIDEV-NOTE: the count must not drift as turns are handed on. Handing one over AND giving it back
  // loses a count every time, so the bound loosens with every password the shop hashes - a cap that
  // holds on the first flood and not on the tenth. It takes work FINISHING and more arriving after
  // it to see, which is the ordinary shape of a shop that is being logged in to.
  it('still holds the bound after a turn has been handed on', async () => {
    const inTurn = atMostAtOnce(2);
    const [first, second] = [started(inTurn), started(inTurn)];
    const queued = started(inTurn);

    first.finish();
    await settledElsewhere();
    expect([second.started, queued.started]).toEqual([true, true]);

    const afterwards = started(inTurn);
    await settledElsewhere();

    expect(afterwards.started).toBe(false);
  });

  it('holds it through a run of them, one finishing as the next arrives', async () => {
    const inTurn = atMostAtOnce(2);
    let running = [started(inTurn), started(inTurn)];

    for (let round = 0; round < 5; round += 1) {
      const arriving = started(inTurn);
      running[0].finish();
      await settledElsewhere();

      running = [running[1], arriving];
      expect(running.filter((work) => work.started)).toHaveLength(2);
    }

    const oneTooMany = started(inTurn);
    await settledElsewhere();

    expect(oneTooMany.started).toBe(false);
  });

  // AIDEV-NOTE: a turn that is not given back is a shop that stops hashing altogether - every login
  // after it would queue for ever. `isThePassword` catches a failed derive, so this is the ordinary
  // path rather than an exotic one.
  it('gives the turn up when the work fails', async () => {
    const inTurn = atMostAtOnce(1);
    const first = started(inTurn);
    const second = started(inTurn);

    first.fail(new Error('scrypt would not'));
    await expect(first.done).rejects.toThrow('scrypt would not');
    await settledElsewhere();

    expect(second.started).toBe(true);
  });

  it('answers with what the work answered', async () => {
    const inTurn = atMostAtOnce(1);

    await expect(inTurn(() => Promise.resolve('the hash'))).resolves.toBe('the hash');
  });

  it('takes one at a time when told one', async () => {
    const inTurn = atMostAtOnce(1);

    const [one, another] = [started(inTurn), started(inTurn)];
    await settledElsewhere();

    expect([one.started, another.started]).toEqual([true, false]);
  });
});
