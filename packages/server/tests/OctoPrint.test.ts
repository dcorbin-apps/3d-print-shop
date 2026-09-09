import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import { CouldNotReach, OctoPrint, reconnectAfter, reconnectDelayMs, whyUnreachable } from '../src';
import type { HttpClient, OctoPrintConfig, PushSocket, PushSocketFactory, ReconnectDelay } from '../src';

interface MockPushSocket extends PushSocket {
  send: jest.Mock<(frame: string) => void>;
  close: jest.Mock<() => void>;
}

// AIDEV-NOTE: what node says when it cannot reach a machine at all is "fetch failed", and it names
// neither the address nor the reason. That message is not thrown away: it reaches the log and
// `printer.paused.reason`, which is the whole of what an operator gets when a printer goes quiet.
describe('why a machine could not be reached', () => {
  // How node reports it: a TypeError saying nothing, with the reason underneath in `cause`.
  const fetchFailed = (code: string): Error =>
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('...'), { code }) });

  it.each([
    ['ECONNREFUSED', 'nothing is listening at http://octopi.local (ECONNREFUSED)'],
    ['ENOTFOUND', 'the name octopi.local does not resolve (ENOTFOUND)'],
    ['ETIMEDOUT', 'http://octopi.local did not answer in time (ETIMEDOUT)'],
    ['ECONNRESET', 'http://octopi.local closed the connection (ECONNRESET)'],
    ['EHOSTUNREACH', 'there is no route to octopi.local (EHOSTUNREACH)'],
  ])('says what %s means, and keeps the code to search for', (code, expected) => {
    expect(whyUnreachable(fetchFailed(code), 'http://octopi.local')).toBe(expected);
  });

  // Node tries A and AAAA at once and reports both failures together, in an error whose own message
  // is empty - which is what a machine that is simply not there looks like.
  it('reads the reason out of a pair of failures reported together', () => {
    const both = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(''), { errors: [Object.assign(new Error('...'), { code: 'ECONNREFUSED' })] }),
    });

    expect(whyUnreachable(both, 'http://octopi.local')).toBe('nothing is listening at http://octopi.local (ECONNREFUSED)');
  });

  // A code nobody anticipated is still worth more than "fetch failed": it says where, and it says
  // enough to search for.
  it('says the code even when it has no words for it', () => {
    expect(whyUnreachable(fetchFailed('EPROTO'), 'http://octopi.local')).toBe('http://octopi.local could not be reached (EPROTO)');
  });

  // node's outer message is "fetch failed" whatever went wrong; the cause is what knows. A port
  // undici refuses to dial at all arrives exactly this way.
  it('says what the failure underneath said, not the "fetch failed" over the top of it', () => {
    const badPort = Object.assign(new TypeError('fetch failed'), { cause: new Error('bad port') });

    expect(whyUnreachable(badPort, 'http://octopi.local:9')).toBe('http://octopi.local:9 could not be reached: bad port');
  });

  it('falls back to what the failure said when there is no code at all', () => {
    expect(whyUnreachable(new Error('something else entirely'), 'http://octopi.local')).toBe(
      'http://octopi.local could not be reached: something else entirely'
    );
  });
});

describe('OctoPrint', () => {
  let mockHttpClient: jest.Mock<HttpClient>;
  let mockWs: MockPushSocket;
  let mockWsFactory: jest.Mock<PushSocketFactory>;
  let mockReconnectDelay: jest.Mock<ReconnectDelay>;
  let adapter: OctoPrint;

  const config: OctoPrintConfig = {
    baseUrl: 'http://octoprint.local',
    apiKey: 'test-key',
  };

  const REMOTE_PATH = 'plates/tray.gcode';
  const gcode = (): Readable => Readable.from(['G1 X0 Y0\n']);

  function makeMockWs(): MockPushSocket {
    return {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: jest.fn<(frame: string) => void>(),
      close: jest.fn<() => void>(),
    };
  }

  function makeOkResponse(body: unknown = {}): Response {
    return {
      ok: true,
      json: jest.fn<() => Promise<unknown>>().mockResolvedValue(body),
    } as unknown as Response;
  }

  function makeErrorResponse(status: number, statusText: string): Response {
    return {
      ok: false,
      status,
      statusText,
      json: jest.fn<() => Promise<unknown>>().mockResolvedValue({ error: statusText }),
    } as unknown as Response;
  }

  function sendEvent(type: string, path: string = 'plates/tray.gcode', ws: MockPushSocket = mockWs): void {
    ws.onmessage!(JSON.stringify({ event: { type, payload: { path } } }));
  }

  // AIDEV-NOTE: a tick is needed between connect() and onopen - the socket is not created until
  // the passive login resolves, so firing onopen synchronously would touch a handler that does not
  // exist yet.
  async function connectAdapter(): Promise<void> {
    const connectPromise = adapter.connect();
    await settle();
    mockWs.onopen!();
    await connectPromise;
  }

  function settle(): Promise<void> {
    return new Promise((tick) => setImmediate(tick));
  }

  async function expectPending(promise: Promise<unknown>): Promise<void> {
    let settled = false;
    const record = (): void => {
      settled = true;
    };
    void promise.then(record, record);

    await settle();
    expect(settled).toBe(false);
  }

  beforeEach(() => {
    // AIDEV-NOTE: connect() now performs a passive login before opening the socket, because
    // OctoPrint's auth frame wants `<user id>:<session key>` and the session comes from that call.
    // Every test that connects therefore needs a login response available.
    mockHttpClient = jest.fn<HttpClient>();
    mockHttpClient.mockResolvedValue(makeOkResponse({ name: 'operator', session: 'sess-1' }));
    mockWs = makeMockWs();
    mockWsFactory = jest.fn<PushSocketFactory>().mockReturnValue(mockWs);
    mockReconnectDelay = jest.fn<ReconnectDelay>().mockResolvedValue(undefined);

    adapter = new OctoPrint(config, mockHttpClient, mockWsFactory, mockReconnectDelay);
  });

  describe('connect()', () => {
    it('connects to the OctoPrint push socket endpoint', async () => {
      void adapter.connect();
      await settle();

      expect(mockWsFactory).toHaveBeenCalledWith('ws://octoprint.local/sockjs/websocket');
    });

    // AIDEV-NOTE: OctoPrint's push socket does not accept an api key. Its auth frame wants
    // `<user id>:<session key>`, and the session comes from a login call - see its own sockjs.py,
    // which splits on ':' and requires exactly two parts. This codebase sent `apikey:<key>` until
    // 2026-08-26, which OctoPrint resets to anonymous, and an anonymous socket receives no status
    // messages at all - so awaitOutcome() would simply never fire.
    it('performs a passive login before opening the socket', async () => {
      void adapter.connect();
      await settle();

      expect(mockHttpClient).toHaveBeenCalledWith(
        'http://octoprint.local/api/login',
        expect.objectContaining({
          method: 'POST',
          headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
          body: JSON.stringify({ passive: true }),
        })
      );
    });

    it('fails with a clear message when the login is rejected', async () => {
      mockHttpClient.mockResolvedValue(makeErrorResponse(403, 'Forbidden'));

      await expect(adapter.connect()).rejects.toThrow('OctoPrint login failed: 403 Forbidden');
    });

    it('fails when the login returns no session, rather than sending a malformed auth frame', async () => {
      mockHttpClient.mockResolvedValue(makeOkResponse({ name: '', session: undefined }));

      await expect(adapter.connect()).rejects.toThrow('did not return a usable session');
    });

    // AIDEV-NOTE: what the shop branches on. A key the machine will not accept is ended by somebody
    // correcting it, outside the shop and without announcing it - so it is the shop failing to GET
    // to the machine, and worth asking again, rather than the machine refusing a job.
    it('calls a login it would not grant being out of reach', async () => {
      mockHttpClient.mockResolvedValue(makeErrorResponse(403, 'Forbidden'));

      await expect(adapter.connect()).rejects.toThrow(CouldNotReach);
    });

    // AIDEV-NOTE: the key must not appear in the URL - query strings are recorded by proxies and
    // servers, so a credential there leaks everywhere URLs are logged. It travels in the auth
    // frame's payload instead; see OctoPrint.openSocket().
    it('keeps the api key out of the connection URL', async () => {
      void adapter.connect();
      await settle();

      const url = mockWsFactory.mock.calls[0][0];

      expect(url).not.toContain('test-key');
      expect(url).not.toContain('apikey');
    });

    it('sends the session-based auth message on open', async () => {
      await connectAdapter();

      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify({ auth: 'operator:sess-1' }));
    });

    it('resolves once the socket opens', async () => {
      await connectAdapter();
    });

    it('rejects if the initial connection closes before opening', async () => {
      const promise = adapter.connect();
      await settle();
      mockWs.onclose!();
      await expect(promise).rejects.toThrow('the push socket to http://octoprint.local closed before it opened');
    });

    // The reason is offered on the error event and nowhere else - a close carries none - so a
    // socket that reported one and a socket that just went away must not read the same.
    it('says why the initial connection failed, when the socket said why', async () => {
      const promise = adapter.connect();
      await settle();
      mockWs.onerror!(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' }));
      mockWs.onclose!();

      await expect(promise).rejects.toThrow(
        'the push socket to http://octoprint.local closed before it opened: nothing is listening at http://octoprint.local (ECONNREFUSED)'
      );
    });

    it('does not attempt to reconnect after the initial connection fails', async () => {
      const promise = adapter.connect();
      await settle();
      mockWs.onclose!();
      await expect(promise).rejects.toThrow();
      await Promise.resolve();
      expect(mockReconnectDelay).not.toHaveBeenCalled();
    });
  });

  describe('disconnect()', () => {
    it('closes the underlying socket', async () => {
      await connectAdapter();
      adapter.disconnect();
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('prevents a subsequent close from triggering a reconnect', async () => {
      await connectAdapter();
      adapter.disconnect();
      mockWs.onclose!();
      await Promise.resolve();
      expect(mockReconnectDelay).not.toHaveBeenCalled();
      expect(mockWsFactory).toHaveBeenCalledTimes(1);
    });

    it('rejects any print job still waiting for completion', async () => {
      await connectAdapter();
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      adapter.disconnect();
      await expect(promise).rejects.toThrow('OctoPrint connection was closed before print completion');
    });

    // A backoff still waiting is a timer still armed, and that alone keeps the process alive - so a
    // shop told to stop mid-outage would sit out the delay before exiting.
    it('tells a backoff that is already waiting to stop waiting', async () => {
      await connectAdapter();
      mockWs.onclose!();

      const [, cancelled] = mockReconnectDelay.mock.calls[0];
      expect(cancelled.aborted).toBe(false);

      adapter.disconnect();

      expect(cancelled.aborted).toBe(true);
    });

    // Cancelling is permanent, so an adapter connected again has to wait out its backoffs afresh -
    // otherwise every one of them settles at once and the reconnect becomes a hot loop.
    it('waits out a backoff again once it has been reconnected', async () => {
      await connectAdapter();
      adapter.disconnect();

      await connectAdapter();
      mockWs.onclose!();

      const [, cancelled] = mockReconnectDelay.mock.calls[0];
      expect(cancelled.aborted).toBe(false);
    });
  });

  // The whole point: this is the message that reaches the log and `printer.paused.reason`.
  describe('a machine that cannot be reached at all', () => {
    it('says so, and where, rather than "fetch failed"', async () => {
      mockHttpClient.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));

      await expect(adapter.send(REMOTE_PATH, gcode())).rejects.toThrow('nothing is listening at http://octoprint.local (ECONNREFUSED)');
    });

    // The difference between a retry costing one login and a retry costing a whole plate.
    it('calls an upload that never arrived being out of reach', async () => {
      mockHttpClient.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));

      await expect(adapter.send(REMOTE_PATH, gcode())).rejects.toThrow(CouldNotReach);
    });
  });

  describe('submit()', () => {
    beforeEach(async () => {
      await connectAdapter();
      // the login call is not what these assertions are about
      mockHttpClient.mockClear();
      mockHttpClient.mockResolvedValue(makeOkResponse());
    });

    it('POSTs to /api/files/local', async () => {
      await adapter.send(REMOTE_PATH, gcode());
      expect(mockHttpClient).toHaveBeenCalledWith(
        'http://octoprint.local/api/files/local',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('includes X-Api-Key header', async () => {
      await adapter.send(REMOTE_PATH, gcode());
      expect(mockHttpClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { 'X-Api-Key': 'test-key' } })
      );
    });

    it('sends a FormData body', async () => {
      await adapter.send(REMOTE_PATH, gcode());
      const init = mockHttpClient.mock.calls[0][1];
      expect(init?.body).toBeInstanceOf(FormData);
    });

    // AIDEV-NOTE: the caller says where it goes. This used to build the folder name itself, which
    // was one client's filing scheme baked into a printer - two paths, because one would be
    // satisfied by ignoring the argument and hardcoding the old answer.
    it.each([
      ['plates/tray.gcode', 'plates', 'tray.gcode'],
      ['3d-print-shop/job-7.gcode', '3d-print-shop', 'job-7.gcode'],
    ])('files %s under %s', async (remotePath, folder, filename) => {
      await adapter.send(remotePath, gcode());
      const form = mockHttpClient.mock.calls[0][1]?.body as FormData;

      expect(form.get('path')).toBe(folder);
      expect((form.get('file') as File).name).toBe(filename);
    });

    it('files a job with no folder at the root', async () => {
      await adapter.send('tray.gcode', gcode());
      const form = mockHttpClient.mock.calls[0][1]?.body as FormData;

      expect(form.get('path')).toBe('');
    });

    it('sends the gcode it was given', async () => {
      await adapter.send(REMOTE_PATH, Readable.from(['G1 X1 Y2\n']));
      const form = mockHttpClient.mock.calls[0][1]?.body as FormData;

      expect(await (form.get('file') as File).text()).toBe('G1 X1 Y2\n');
    });

    it('sets print=true in form data', async () => {
      await adapter.send(REMOTE_PATH, gcode());
      const form = mockHttpClient.mock.calls[0][1]?.body as FormData;
      expect(form.get('print')).toBe('true');
    });

    // AIDEV-NOTE: the machine says where it FILED it, and that is the path its completion event will
    // carry. OctoPrint transliterates a name it cannot store, so the shop's guess and the machine's
    // answer are not always the same string - and the watcher matches on the string.
    it('answers with the path the machine filed it under', async () => {
      mockHttpClient.mockResolvedValue(makeOkResponse({ done: true, files: { local: { path: 'plates/umlaut.gcode' } } }));

      expect(await adapter.send('plates/ümläut.gcode', gcode())).toBe('plates/umlaut.gcode');
    });

    // The upload has already succeeded, so a body this cannot read must not become a failed print -
    // it falls back to the guess the shop made for every print before it read the answer at all.
    it.each([
      ['says nothing about where it went', { done: true }],
      ['names no path', { files: { local: { name: 'tray.gcode' } } }],
      ['gives a path that is not a string', { files: { local: { path: 7 } } }],
      ['answers with no body at all', undefined],
    ])('answers with the path it asked for when the machine %s', async (_case, body) => {
      mockHttpClient.mockResolvedValue(makeOkResponse(body));

      expect(await adapter.send(REMOTE_PATH, gcode())).toBe(REMOTE_PATH);
    });

    // A 2xx whose body is not JSON - a proxy's HTML, a truncated answer. The file is on the machine
    // either way, so this is the same fallback and not an exception thrown out of a print.
    it('answers with the path it asked for when the answer cannot be read', async () => {
      mockHttpClient.mockResolvedValue({
        ok: true,
        json: jest.fn<() => Promise<unknown>>().mockRejectedValue(new SyntaxError('Unexpected token <')),
      } as unknown as Response);

      expect(await adapter.send(REMOTE_PATH, gcode())).toBe(REMOTE_PATH);
    });

    it('throws when upload response is not ok', async () => {
      mockHttpClient.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));
      await expect(adapter.send(REMOTE_PATH, gcode())).rejects.toThrow(
        'OctoPrint upload failed: 500 Internal Server Error'
      );
    });

    // The machine ANSWERED. Asking again re-sends the plate to be told the same thing, so this is
    // not the kind of failure the shop retries.
    it('does not call an upload the machine turned down being out of reach', async () => {
      mockHttpClient.mockResolvedValue(makeErrorResponse(400, 'Bad Request'));

      await expect(adapter.send(REMOTE_PATH, gcode())).rejects.not.toBeInstanceOf(CouldNotReach);
    });
  });

  describe('awaitOutcome()', () => {
    beforeEach(async () => {
      await connectAdapter();
    });

    it('resolves with complete on PrintDone event', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      sendEvent('PrintDone');
      await expect(promise).resolves.toBe('finished');
    });

    it('resolves with error on PrintFailed event', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      sendEvent('PrintFailed');
      await expect(promise).resolves.toBe('failed');
    });

    it('resolves with cancelled on PrintCancelled event', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      sendEvent('PrintCancelled');
      await expect(promise).resolves.toBe('cancelled');
    });

    it('ignores non-terminal events', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      sendEvent('PrintStarted');
      sendEvent('PrintPaused');
      sendEvent('PrintDone');
      await expect(promise).resolves.toBe('finished');
    });

    it('ignores terminal events for a different print job', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      let settled = false;
      promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );

      sendEvent('PrintFailed', 'plates/other.gcode');
      await Promise.resolve();
      expect(settled).toBe(false);

      sendEvent('PrintDone', 'plates/tray.gcode');
      await expect(promise).resolves.toBe('finished');
    });

    it('does not miss a completion event that arrives before awaitOutcome is called', async () => {
      sendEvent('PrintDone', 'plates/tray.gcode');
      await expect(adapter.awaitOutcome('plates/tray.gcode')).resolves.toBe('finished');
    });

    it('reconnects instead of failing on an unexpected close', async () => {
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      const promise = adapter.awaitOutcome('plates/tray.gcode');
      mockWs.onclose!();
      await settle();

      expect(mockWsFactory).toHaveBeenCalledTimes(2);

      secondWs.onopen!();
      sendEvent('PrintDone', 'plates/tray.gcode', secondWs);
      await expect(promise).resolves.toBe('finished');
    });

    // A fresh passive login runs per reconnect, so a session the server expired during a long
    // outage is not reused.
    it('re-authenticates with a fresh session after reconnecting', async () => {
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      mockWs.onclose!();
      await settle();

      secondWs.onopen!();
      expect(secondWs.send).toHaveBeenCalledWith(JSON.stringify({ auth: 'operator:sess-1' }));
    });

    it('keeps retrying with increasing attempt numbers across repeated closes', async () => {
      const secondWs = makeMockWs();
      const thirdWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs).mockReturnValueOnce(thirdWs);

      mockWs.onclose!();
      await settle();
      secondWs.onclose!();
      await settle();

      expect(mockReconnectDelay).toHaveBeenNthCalledWith(1, 1, expect.any(AbortSignal));
      expect(mockReconnectDelay).toHaveBeenNthCalledWith(2, 2, expect.any(AbortSignal));
      expect(mockWsFactory).toHaveBeenCalledTimes(3);
    });

    it('resets the attempt count after a successful reconnect', async () => {
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      mockWs.onclose!();
      await settle();
      secondWs.onopen!();

      secondWs.onclose!();
      await settle();

      expect(mockReconnectDelay).toHaveBeenNthCalledWith(2, 1, expect.any(AbortSignal));
    });
  });

  describe('reconnectAfter()', () => {
    const timersArmed = (): number => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

    it('lets go of the timer it is waiting on when it is cancelled', async () => {
      const stopWaiting = new AbortController();
      const armed = timersArmed();

      const waited = reconnectAfter(20, stopWaiting.signal);
      expect(timersArmed()).toBe(armed + 1);

      stopWaiting.abort();

      await expect(waited).resolves.toBeUndefined();
      expect(timersArmed()).toBe(armed);
    });
  });

  describe('reconnectDelayMs()', () => {
    it('doubles the delay with each attempt', () => {
      expect(reconnectDelayMs(1)).toBe(500);
      expect(reconnectDelayMs(2)).toBe(1000);
      expect(reconnectDelayMs(3)).toBe(2000);
    });

    it('caps the delay at 60 seconds', () => {
      expect(reconnectDelayMs(20)).toBe(60_000);
    });
  });

  describe('cancelJob()', () => {
    beforeEach(() => {
      mockHttpClient.mockResolvedValue(makeOkResponse());
    });

    it('POSTs cancel command to /api/job', async () => {
      await adapter.cancel();
      expect(mockHttpClient).toHaveBeenCalledWith(
        'http://octoprint.local/api/job',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: 'cancel' }),
        })
      );
    });

    it('includes X-Api-Key and Content-Type headers', async () => {
      await adapter.cancel();
      expect(mockHttpClient).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'X-Api-Key': 'test-key', 'Content-Type': 'application/json' },
        })
      );
    });

    it('throws when response is not ok', async () => {
      mockHttpClient.mockResolvedValue(makeErrorResponse(409, 'Conflict'));
      await expect(adapter.cancel()).rejects.toThrow(
        'OctoPrint cancel failed: 409 Conflict'
      );
    });
  });

  describe('reconnect attempts that themselves fail', () => {
    beforeEach(async () => {
      await connectAdapter();
    });

    // A discarded reconnect failure used to end reconnection for good after one bad attempt,
    // leaving every in-flight job's promise unresolved forever.
    it('retries after a reconnect attempt is refused', async () => {
      mockHttpClient.mockResolvedValueOnce(makeErrorResponse(503, 'Service Unavailable'));

      mockWs.onclose!();
      await settle();

      expect(mockReconnectDelay).toHaveBeenNthCalledWith(2, 2, expect.any(AbortSignal));
      expect(mockWsFactory).toHaveBeenCalledTimes(2);
    });
  });

  // AIDEV-NOTE: OctoPrint does not replay the completion events that fired while the socket was
  // down, but it does send a status frame on connect naming the job the printer is running now.
  // These cover using that frame to settle what the outage hid - and, where it is unreadable or
  // the job is still running, refusing to guess.
  describe('reconciling a print whose events were missed', () => {
    const TRAY_PATH = 'plates/tray.gcode';
    const TRAY_FILE_URL = 'http://octoprint.local/api/files/local/plates/tray.gcode';

    // OctoPrint keeps naming the last job after it ends, so the flags - never the job path alone -
    // are what say whether it is still running.
    function idleStatus(path: string = TRAY_PATH): unknown {
      return { state: { flags: { printing: false, paused: false, pausing: false, cancelling: false } }, job: { file: { path } } };
    }

    function inFlightStatus(flag: string): unknown {
      return { state: { flags: { printing: false, paused: false, pausing: false, cancelling: false, [flag]: true } }, job: { file: { path: TRAY_PATH } } };
    }

    function respondTo(routes: Record<string, Response>): void {
      mockHttpClient.mockImplementation((url) =>
        Promise.resolve(routes[url] ?? makeOkResponse({ name: 'operator', session: 'sess-1' }))
      );
    }

    function sendStatus(ws: MockPushSocket, status: unknown, key: 'history' | 'current' = 'history'): void {
      ws.onmessage!(JSON.stringify({ [key]: status }));
    }

    async function reconnectReporting(status: unknown): Promise<MockPushSocket> {
      const nextWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(nextWs);

      mockWs.onclose!();
      await settle();
      nextWs.onopen!();
      await settle();
      sendStatus(nextWs, status);
      await settle();

      return nextWs;
    }

    beforeEach(async () => {
      await connectAdapter();
    });

    it('resolves a print that finished while the socket was down', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: true } } }) });

      await reconnectReporting(idleStatus());

      await expect(promise).resolves.toBe('finished');
    });

    // OctoPrint's print history records a cancelled run as a failure, so a reconciled outcome
    // cannot report 'cancelled' - only an event delivered live on the socket can.
    it('reports a print that failed while the socket was down as an error', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: false } } }) });

      await reconnectReporting(idleStatus());

      await expect(promise).resolves.toBe('failed');
    });

    // The history read here belongs to the previous copy - the same path is printed once per copy -
    // so taking an outcome from it while the job is still running would settle the wrong print. A
    // paused or cancelling print has not reached its outcome either; only its event will say.
    it.each(['printing', 'paused', 'pausing', 'cancelling'])('keeps waiting while the printer reports %s', async (flag) => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: true } } }) });

      await reconnectReporting(inFlightStatus(flag));

      await expectPending(promise);
    });

    // state.text is documented as human-readable and is deliberately not matched on. A frame whose
    // flags this adapter cannot read has to mean "still printing", or an unfamiliar status would
    // end the wait early and hand back the previous copy's outcome.
    it('keeps waiting when the status frame carries no readable flags', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: true } } }) });

      await reconnectReporting({ state: { text: 'Printing from SD' }, job: { file: { path: TRAY_PATH } } });

      await expectPending(promise);
    });

    it('keeps waiting for a job OctoPrint has no record of printing', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { failure: 0, success: 0 } }) });

      await reconnectReporting(idleStatus());

      await expectPending(promise);
    });

    it('keeps waiting when the print history cannot be read', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeErrorResponse(503, 'Service Unavailable') });

      await reconnectReporting(idleStatus());

      await expectPending(promise);
    });

    // Piece names become file names, and they are only barred from holding a separator or a control
    // character - a space or a '#' reaches the URL and would truncate it unencoded.
    it('encodes the job path when asking for its print history', async () => {
      const promise = adapter.awaitOutcome('plates/player box #2.gcode');
      respondTo({
        'http://octoprint.local/api/files/local/plates/player%20box%20%232.gcode': makeOkResponse({
          prints: { last: { success: true } },
        }),
      });

      await reconnectReporting(idleStatus('plates/player box #2.gcode'));

      await expect(promise).resolves.toBe('finished');
    });

    // Between submit() and the printer actually starting, the printer is idle and the file's
    // history still holds the previous copy's outcome. Reconciling on every status frame rather
    // than only the first after an outage would settle the new job from that stale result.
    it('does not settle a job from a status frame outside an outage', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: true } } }) });

      sendStatus(mockWs, idleStatus());

      await expectPending(promise);
    });

    // 'history' is what OctoPrint sends on connect, but a 'current' frame can land first and
    // carries the same payload - reconciling must not depend on which arrives.
    it('reconciles from a current frame just as it does from a history frame', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeOkResponse({ prints: { last: { success: true } } }) });

      const nextWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(nextWs);
      mockWs.onclose!();
      await settle();
      nextWs.onopen!();
      await settle();
      sendStatus(nextWs, idleStatus(), 'current');
      await settle();

      await expect(promise).resolves.toBe('finished');
    });

    it('reconciles only once per outage', async () => {
      const promise = adapter.awaitOutcome(TRAY_PATH);
      respondTo({ [TRAY_FILE_URL]: makeErrorResponse(503, 'Service Unavailable') });

      const secondWs = await reconnectReporting(idleStatus());
      mockHttpClient.mockClear();

      sendStatus(secondWs, idleStatus());
      await settle();

      expect(mockHttpClient).not.toHaveBeenCalledWith(TRAY_FILE_URL, expect.anything());
      await expectPending(promise);
    });
  });

  // The bound is on time out of contact, not on how long a print may take - prints legitimately
  // run for hours.
  describe('losing contact with the printer', () => {
    const TRAY_FILE_URL = 'http://octoprint.local/api/files/local/plates/tray.gcode';
    let currentTimeMs: number;

    function sendStatus(ws: MockPushSocket): void {
      const status = { state: { flags: { printing: false, paused: false, pausing: false, cancelling: false } }, job: { file: { path: 'plates/tray.gcode' } } };
      ws.onmessage!(JSON.stringify({ history: status }));
    }

    beforeEach(async () => {
      currentTimeMs = 0;
      adapter = new OctoPrint(
        { ...config, lostContactTimeoutMs: 60_000 },
        mockHttpClient,
        mockWsFactory,
        mockReconnectDelay,
        () => currentTimeMs
      );
      await connectAdapter();
    });

    it('tells the caller the print outcome is unknown rather than waiting forever', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');

      mockWs.onclose!();
      currentTimeMs = 60_000;

      await expect(promise).rejects.toThrow('Lost contact with OctoPrint at http://octoprint.local for 60s');
    });

    it('keeps waiting while contact has been lost for less than the timeout', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');

      mockWs.onclose!();
      currentTimeMs = 59_000;

      await expectPending(promise);
    });

    // The outage is one continuous stretch however many attempts it spans. Timing each attempt
    // separately would never reach the timeout, because the backoff itself is capped below it.
    it('measures the outage from when contact was first lost, not from the last attempt', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      mockReconnectDelay.mockImplementation(() => {
        currentTimeMs += 35_000;
        return Promise.resolve();
      });
      mockHttpClient
        .mockResolvedValueOnce(makeErrorResponse(503, 'Service Unavailable'))
        .mockResolvedValueOnce(makeErrorResponse(503, 'Service Unavailable'));

      mockWs.onclose!();

      await expect(promise).rejects.toThrow('for 70s');
    });

    // An unauthenticated socket is answered with silence rather than an error, so a socket that
    // opens and then says nothing is still a lost connection. Only a frame arriving ends an outage.
    it('keeps counting the outage when a reconnected socket opens but says nothing', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      mockWs.onclose!();
      await settle();
      secondWs.onopen!();
      await settle();

      secondWs.onclose!();
      currentTimeMs = 60_000;

      await expect(promise).rejects.toThrow('Lost contact with OctoPrint');
    });

    it('restarts the outage clock once a reconnected socket sends a frame', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      mockWs.onclose!();
      currentTimeMs = 55_000;
      await settle();
      secondWs.onopen!();
      await settle();
      sendStatus(secondWs);
      await settle();

      secondWs.onclose!();
      currentTimeMs = 100_000;

      await expectPending(promise);
    });

    it('stops asking OctoPrint about a job it has given up on', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');
      const secondWs = makeMockWs();
      mockWsFactory.mockReturnValueOnce(secondWs);

      mockWs.onclose!();
      currentTimeMs = 60_000;
      await expect(promise).rejects.toThrow('Lost contact');

      await settle();
      secondWs.onopen!();
      await settle();
      sendStatus(secondWs);
      await settle();

      expect(mockHttpClient).not.toHaveBeenCalledWith(TRAY_FILE_URL, expect.anything());
    });
  });

  describe('malformed push frames', () => {
    beforeEach(async () => {
      await connectAdapter();
    });

    // A throw out of the message handler escapes the socket's own close/reconnect handling and can
    // take the CLI process down mid-print.
    it('survives a frame that is not JSON and still handles later events', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');

      expect(() => mockWs.onmessage!('<html>gateway timeout</html>')).not.toThrow();

      sendEvent('PrintDone');
      await expect(promise).resolves.toBe('finished');
    });

    it('survives a binary frame and still handles later events', async () => {
      const promise = adapter.awaitOutcome('plates/tray.gcode');

      expect(() => mockWs.onmessage!(new ArrayBuffer(8))).not.toThrow();

      sendEvent('PrintDone');
      await expect(promise).resolves.toBe('finished');
    });
  });
});
