import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PasswordDidNotStick, keepReachingForWhatIsLost, keepingTheKey, keepingTheirPassword, lookingForWork, stoppingTheShop, tryingAgain } from '../src/running';
import { printerKeysIn, writeFirstCaller } from '../src/credentials';
import { silent, toStdout } from '../src/log';
import type { Log } from '../src/log';
import type { Stopping, TheForeman, TheMachines } from '../src/running';

// AIDEV-NOTE: the moving parts of a shop that is already running. Each was a closure inside the serve
// command, so the only way to ask what stopping does - or in what order, or twice - was to spawn a
// process and read its log. They are functions now, and each is asked directly.
describe('a shop that is running', () => {
  let order: string[];
  let mockConsiderStarting: jest.Mock<TheForeman['considerStarting']>;
  let mockStartAgain: jest.Mock<TheForeman['startAgain']>;
  let mockStop: jest.Mock<TheForeman['stop']>;
  let mockWatchersSettled: jest.Mock<TheForeman['watchersSettled']>;
  let mockCloseAll: jest.Mock<TheMachines['closeAll']>;
  let foreman: TheForeman;
  let machines: TheMachines;
  let said: string[];
  let lines: string[];
  let log: Log;

  const noting =
    (what: string): (() => void) =>
    (): void => {
      order.push(what);
    };

  beforeEach(() => {
    order = [];
    said = [];
    lines = [];
    log = toStdout(
      () => new Date(),
      (line) => lines.push(line)
    );

    mockConsiderStarting = jest.fn<TheForeman['considerStarting']>();
    mockConsiderStarting.mockResolvedValue(undefined);
    mockStartAgain = jest.fn<TheForeman['startAgain']>();
    mockStartAgain.mockResolvedValue(undefined);
    mockStop = jest.fn<TheForeman['stop']>(noting('foreman stopped'));
    mockWatchersSettled = jest.fn<TheForeman['watchersSettled']>();
    mockWatchersSettled.mockResolvedValue(undefined);
    mockCloseAll = jest.fn<TheMachines['closeAll']>(noting('machines let go'));

    foreman = { considerStarting: mockConsiderStarting, startAgain: mockStartAgain, stop: mockStop, watchersSettled: mockWatchersSettled };
    machines = { closeAll: mockCloseAll };
  });

  const stopping = (over: Partial<Stopping> = {}): (() => void) =>
    stoppingTheShop({
      server: { close: noting('server closed') },
      stopAsking: noting('stopped asking'),
      foreman,
      machines,
      releaseData: noting('data let go'),
      log,
      say: (told) => said.push(...told),
      ...over,
    });

  describe('stopping', () => {
    // AIDEV-NOTE: the order is the whole of it. Letting the machines go first would settle the
    // watchers while a request was still able to start a new print.
    it('takes no more requests before it lets anything go', async () => {
      stopping()();

      expect(order).toEqual(['server closed', 'stopped asking', 'foreman stopped', 'machines let go', 'data let go']);
    });

    // Stopping the listener is what makes the process END - nothing else holds the event loop open
    // once the printers are let go.
    it('closes the listener, which is what lets the process end', () => {
      stopping()();

      expect(order).toContain('server closed');
    });

    // The operator can ask over the API and the supervisor can signal at the same moment, and a
    // second release of the data directory is not the first one's to give away.
    it('does nothing the second time it is asked', () => {
      const stop = stopping();

      stop();
      stop();

      expect(order.filter((each) => each === 'data let go')).toHaveLength(1);
    });

    it('says so once every watcher has settled, and not before', async () => {
      let settle = (): void => undefined;
      mockWatchersSettled.mockReturnValue(new Promise<void>((settled) => (settle = settled)));

      stopping()();
      await Promise.resolve();
      expect(said).toEqual([]);

      settle();
      await Promise.resolve();
      await Promise.resolve();

      expect(said).toEqual(['3d-print-shop has stopped']);
      expect(lines.join('\n')).toContain('the shop has stopped');
    });
  });

  // AIDEV-NOTE: the one thing the shop writes to /etc, and the reason a printer can be given its key
  // from a browser at all. Written to the file the shop READS, and the printer tried at once - a
  // machine that had no key is written down as unreachable and would otherwise serve out a backoff
  // before anybody found out the key was right.
  describe('a key a printer arrived with', () => {
    let etc: string;

    beforeEach(async () => {
      etc = await mkdtemp(path.join(tmpdir(), 'print-shop-keys-'));
      await chmod(etc, 0o700);
    });

    afterEach(async () => {
      await rm(etc, { recursive: true, force: true });
    });

    // AIDEV-NOTE: the half that a lock cannot answer. `caller password` at a terminal writes this
    // same file from a process of its own - deliberately, because a shop cannot be asked to give
    // somebody a way in that it does not yet answer - so a change made over the API can still be
    // overwritten whole. What must not happen then is the route acting as though it took: it ends
    // every other session this caller holds and answers 204, which would leave them logged out
    // everywhere holding a password the file does not have. A writer that does not write is what
    // losing that race looks like from in here.
    describe('keeping a password somebody just changed', () => {
      const PASSWORD = 'a password of some length';
      const WANTED = 'a different password entirely';

      const lostIt: (etc: string, id: string, password: string) => Promise<void> = () => Promise.resolve();

      beforeEach(async () => {
        await writeFirstCaller(etc, 'dave', 'dave', PASSWORD);
      });

      it('answers with the callers the file now names', async () => {
        const callers = await keepingTheirPassword(etc)('dave', WANTED);

        expect(callers.named('dave')?.caller).toEqual({ id: 'dave', name: 'dave', role: 'admin' });
      });

      it('refuses when the file does not hold what it just wrote', async () => {
        await expect(keepingTheirPassword(etc, lostIt)('dave', WANTED)).rejects.toThrow(PasswordDidNotStick);
      });

      // Said of the shop and its directory rather than of the caller, because nobody asking got
      // anything wrong - which is also why it goes out as a 500 and the path stays in the log.
      it('says what happened rather than blaming whoever asked', async () => {
        await expect(keepingTheirPassword(etc, lostIt)('dave', WANTED)).rejects.toThrow(etc);
      });
    });

    it('is written where the shop reads its keys', async () => {
      await keepingTheKey(etc, silent, noting('tried again'))('mk4', 'a-key-from-a-browser');

      await expect(printerKeysIn(etc)).resolves.toEqual(new Map([['mk4', 'a-key-from-a-browser']]));
    });

    it('is answered back as every key the shop now holds', async () => {
      await keepingTheKey(etc, silent, noting('tried again'))('mk4', 'one-key');

      await expect(keepingTheKey(etc, silent, noting('tried again'))('mini', 'another')).resolves.toEqual(
        new Map([
          ['mk4', 'one-key'],
          ['mini', 'another'],
        ])
      );
    });

    // At once, and without waiting to be signalled: the machine is written down as unreachable until
    // something tries it, and an operator who has just typed the right key should not wait out a
    // backoff to find that out.
    it('has its printer tried again straight away', async () => {
      const tried: string[] = [];

      await keepingTheKey(etc, silent, (printer) => tried.push(printer))('mk4', 'a-key');

      expect(tried).toEqual(['mk4']);
    });

    it('is said in the log, naming the printer and where the keys live', async () => {
      await keepingTheKey(etc, log, noting('tried again'))('mk4', 'a-key');

      expect(lines.join('\n')).toContain('a printer was given its key');
      expect(lines.join('\n')).toContain(etc);
    });
  });

  describe('looking for work', () => {
    it('asks the foreman whether anything could start', () => {
      lookingForWork(foreman, log)();

      expect(mockConsiderStarting).toHaveBeenCalledTimes(1);
    });

    // Not awaited and never thrown: a client waiting on its own submission has no reason to wait for
    // a printer to take a different job, and a failure to LOOK is the shop's trouble rather than an
    // answer to the request that prompted it.
    it('says a failure to look rather than throwing it at whoever prompted it', async () => {
      mockConsiderStarting.mockRejectedValue(new Error('the store is unreadable'));

      expect(() => lookingForWork(foreman, log)()).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(lines.join('\n')).toContain('could not look for work');
      expect(lines.join('\n')).toContain('the store is unreadable');
    });
  });

  describe('an operator saying to try a printer again', () => {
    it('names the machine they went to', () => {
      tryingAgain(foreman, log)('mk4');

      expect(mockStartAgain).toHaveBeenCalledWith('mk4');
    });

    it('says which printer it could not try, rather than throwing', async () => {
      mockStartAgain.mockRejectedValue(new Error('nothing is listening'));

      expect(() => tryingAgain(foreman, log)('mk4')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(lines.join('\n')).toContain('mk4');
      expect(lines.join('\n')).toContain('could not try the printer again');
    });
  });

  // AIDEV-NOTE: the one thing the shop does on a clock rather than after a change it made. A machine
  // the shop cannot hear makes no changes, so nothing else would ever ask again.
  describe('reaching for the printers it has lost', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('asks again on the clock', () => {
      const reach = jest.fn<() => Promise<unknown>>();
      reach.mockResolvedValue(undefined);

      keepReachingForWhatIsLost(reach, 1000, silent);
      jest.advanceTimersByTime(3000);

      expect(reach).toHaveBeenCalledTimes(3);
    });

    it('stops asking when it is told to, which is what lets the process end', () => {
      const reach = jest.fn<() => Promise<unknown>>();
      reach.mockResolvedValue(undefined);

      const stopAsking = keepReachingForWhatIsLost(reach, 1000, silent);
      jest.advanceTimersByTime(1000);
      stopAsking();
      jest.advanceTimersByTime(5000);

      expect(reach).toHaveBeenCalledTimes(1);
    });

    it('goes on asking after one attempt failed', async () => {
      const reach = jest.fn<() => Promise<unknown>>();
      reach.mockRejectedValueOnce(new Error('nothing is listening')).mockResolvedValue(undefined);

      keepReachingForWhatIsLost(reach, 1000, log);
      jest.advanceTimersByTime(2000);
      await Promise.resolve();

      expect(reach).toHaveBeenCalledTimes(2);
    });
  });
});
