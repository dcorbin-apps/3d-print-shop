import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { keepReachingForWhatIsLost, lookingForWork, stoppingTheShop, tryingAgain } from '../src/running';
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
