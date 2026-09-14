import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Caller, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { useShop } from '../src/useShop';

// AIDEV-NOTE: the shop is reached through the real HttpShop, so what is faked is the one thing below
// it that a test cannot have - the network. `fetch` is replaced and nothing else is, which keeps the
// client's own mapping (a time arriving as a string and leaving as a Date) in the path under test.
describe('what the page keeps asking the shop', () => {
  const DAVE: Caller = { id: 'dave', name: 'dave', role: 'admin' };
  const MK4 = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, address: 'http://octopi.local', api: 'octoprint', loaded: [] };
  const A_JOB = {
    id: 1,
    filaments: ['PLA-Red'],
    displayName: 'Player Box',
    gcodeBytes: 10,
    state: 'queued',
    submittedAt: '2026-09-12T09:00:00.000Z',
  };

  const fetching = jest.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
  // AIDEV-NOTE: duck-typed rather than a real Response, because jsdom has neither Response nor fetch
  // - and all HttpShop asks of one is `ok`, `status`, `statusText` and `json()`, which is all of
  // this. Faking the network and nothing above it keeps the client's own mapping under test.
  const answering = (body: unknown, status = 200): Response =>
    ({ ok: status < 400, status, statusText: 'said so', json: () => Promise.resolve(body) }) as unknown as Response;

  const answersEverything = (held: { totalJobs?: number } = {}): void => {
    fetching.mockImplementation((input) => {
      const path = String(input);
      if (path.endsWith('/me')) return Promise.resolve(answering(DAVE));
      if (path.endsWith('/printers')) return Promise.resolve(answering([MK4]));

      return Promise.resolve(answering({ accessibleJobs: [A_JOB], totalJobs: held.totalJobs ?? 1 }));
    });
  };

  // Asked every few milliseconds instead of every two seconds, which is the only reason the hook
  // takes the interval at all.
  const QUICKLY = 5;

  beforeEach(() => {
    globalThis.fetch = fetching as unknown as typeof fetch;
  });

  afterEach(cleanup);

  it('has nothing to show until the first answer arrives', () => {
    fetching.mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(() => useShop('', QUICKLY));

    expect(result.current.answered).toBe(false);
  });

  it('says who the shop takes this browser to be', async () => {
    answersEverything();

    const { result } = renderHook(() => useShop('', QUICKLY));

    await waitFor(() => expect(result.current.caller).toEqual(DAVE));
  });

  it('shows what the shop is holding, with a time as a time', async () => {
    answersEverything();

    const { result } = renderHook(() => useShop('', QUICKLY));

    await waitFor(() => expect(result.current.jobs).toHaveLength(1));
    expect(result.current.jobs[0].submittedAt).toEqual(new Date('2026-09-12T09:00:00.000Z'));
    expect(result.current.printers.map((printer: RegisteredPrinter) => printer.name)).toEqual(['mk4']);
  });

  // What this caller may see, and how many the shop holds altogether - which is all a stranger
  // learns about work that is not theirs.
  it('keeps the total apart from what this caller may see', async () => {
    answersEverything({ totalJobs: 9 });

    const { result } = renderHook(() => useShop('', QUICKLY));

    await waitFor(() => expect(result.current.totalJobs).toBe(9));
    expect(result.current.jobs).toHaveLength(1);
  });

  it('asks again on a tick', async () => {
    answersEverything();
    const { result } = renderHook(() => useShop('', QUICKLY));
    await waitFor(() => expect(result.current.answered).toBe(true));
    const asked = fetching.mock.calls.length;

    await waitFor(() => expect(fetching.mock.calls.length).toBeGreaterThan(asked));
  });

  it('stops asking once nobody is looking at it', async () => {
    answersEverything();
    const { result, unmount } = renderHook(() => useShop('', QUICKLY));
    await waitFor(() => expect(result.current.answered).toBe(true));

    unmount();
    const asked = fetching.mock.calls.length;

    expect(fetching.mock.calls.length).toBe(asked);
  });

  // Being a stranger is not trouble - it is the ordinary state of a browser nobody has logged in on,
  // and of one whose session expired while it sat there. Both want a login rather than an error.
  describe('when the shop does not know this browser', () => {
    beforeEach(() => {
      fetching.mockResolvedValue(answering({ error: 'this shop does not know that token' }, 401));
    });

    it('says so rather than reporting trouble', async () => {
      const { result } = renderHook(() => useShop('', QUICKLY));

      await waitFor(() => expect(result.current.strangers).toBe(true));
      expect(result.current.trouble).toBeUndefined();
    });

    it('clears what was on the screen, because it is no longer theirs to see', async () => {
      answersEverything();
      const { result } = renderHook(() => useShop('', QUICKLY));
      await waitFor(() => expect(result.current.jobs).toHaveLength(1));

      fetching.mockResolvedValue(answering({}, 401));
      await waitFor(() => expect(result.current.jobs).toHaveLength(0));
    });
  });

  // A shop being restarted should not blank the wall display somebody is watching a print on.
  describe('when an ask fails', () => {
    it('leaves the last good answer up and says what went wrong beside it', async () => {
      answersEverything();
      const { result } = renderHook(() => useShop('', QUICKLY));
      await waitFor(() => expect(result.current.jobs).toHaveLength(1));

      fetching.mockRejectedValue(new Error('connection refused'));
      await waitFor(() => expect(result.current.trouble).toContain('Cannot reach the print shop'));
      expect(result.current.jobs).toHaveLength(1);
    });

    it('goes on asking, so a shop that comes back is picked up again', async () => {
      fetching.mockRejectedValue(new Error('connection refused'));
      const { result } = renderHook(() => useShop('', QUICKLY));
      await waitFor(() => expect(result.current.trouble).toBeDefined());

      answersEverything();
      await waitFor(() => expect(result.current.caller).toEqual(DAVE));
    });
  });

  // What a change made from the page waits on, rather than the next tick.
  it('asks again at once when it is told to', async () => {
    answersEverything();
    const { result } = renderHook(() => useShop('', QUICKLY));
    await waitFor(() => expect(result.current.answered).toBe(true));
    const asked = fetching.mock.calls.length;

    await act(async () => {
      result.current.askAgain();
      await Promise.resolve();
    });

    await waitFor(() => expect(fetching.mock.calls.length).toBeGreaterThan(asked));
  });
});
