// AIDEV-NOTE: a bound on how many of something may run at once, and the rest wait their turn. Not a
// RATE: a rate is a policy about how much traffic is acceptable, it needs tuning against somebody's
// working day, and it belongs to whatever fronts a service. This is a bound on a resource the
// process itself owns - the shape a connection pool has - so the number comes from the resource
// rather than from taste.
//
// The queue is deliberately not bounded, and what that means is worth saying out loud. What this can
// protect is everything that is NOT the work being bounded. It cannot protect that work from its own
// flood: there is no way to check a password without hashing one, so a flood either makes people
// wait or refuses them, and refusing them is the same outage by another name. Waiting is the honest
// one. A caller that is merely queued holds a socket and a closure, where one that is running holds
// 32MB, which is the difference this exists to make.

/** Runs work, waiting its turn first when too much is already running. */
export type InTurn = <T>(work: () => Promise<T>) => Promise<T>;

/** At most this many at once. Everything past that queues, and goes in the order it arrived. */
export function atMostAtOnce(howMany: number): InTurn {
  let running = 0;
  const waiting: (() => void)[] = [];

  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running < howMany) running += 1;
    else await new Promise<void>((itIsYourTurn) => waiting.push(itIsYourTurn));

    try {
      return await work();
    } finally {
      // AIDEV-NOTE: the turn is HANDED to whoever is next rather than given back for them to take.
      // `running` does not move, because the turn never becomes free - decrementing and letting the
      // queue re-check would leave an instant between the two in which somebody arriving fresh takes
      // the turn that was already promised, and then the queue is not a queue.
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  };
}
