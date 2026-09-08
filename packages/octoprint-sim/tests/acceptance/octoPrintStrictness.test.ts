import { describe, it, expect, afterEach } from '@jest/globals';
import { startOctoPrintServer } from '../../src/octoPrintServer';
import type { JobSubmittedHandler, OctoPrintServer } from '../../src/octoPrintServer';

// AIDEV-NOTE: what octo-sim REFUSES, which is the one thing its own strictness is needed for and
// the one thing no acceptance test of a client can cover.
//
// Everything octo-sim accepts is already exercised by driving a real client at it - packages/cli's
// print acceptance suite and packages/printer's reconnectRecovery. A break in any of that shows up
// at once as an acceptance test that cannot run, which is why those tests were deleted rather than
// rewritten. Strictness is the exception: if this server quietly started accepting a bad auth frame
// or a second job while one was printing, every one of those suites would still pass, and would
// simply have stopped proving the client behaves.
//
// Real sockets, deliberately. Mocking express and ws would leave nothing to refuse.
describe('octo-sim refuses what real OctoPrint refuses', () => {
  let server: OctoPrintServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function connect(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sockjs/websocket`);
    return new Promise((resolve) => {
      ws.onopen = () => resolve(ws);
    });
  }

  // AIDEV-NOTE: the server answers a socket it has just authenticated with a `history` frame, at
  // once and unprompted. So silence IS the rejection, and asking for it needs no broadcast to race
  // against - the earlier version of these tests slept 50ms first, hoping the frame had been
  // handled before it broadcast.
  //
  // A bounded wait is unavoidable here and only here: proving nothing arrives means allowing time
  // for it not to. 300ms against a reply the server sends synchronously on the same socket.
  function repliedWithin(ws: WebSocket, ms: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data as string);
      };
    });
  }

  async function issuedSession(port: number): Promise<{ name: string; session: string }> {
    const response = await fetch(`http://localhost:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passive: true }),
    });
    return (await response.json()) as { name: string; session: string };
  }

  function uploadForm(filename: string): FormData {
    const form = new FormData();
    form.append('file', new Blob(['G1 X0 Y0'], { type: 'text/plain' }), filename);
    form.append('path', 'plates');
    form.append('print', 'true');
    return form;
  }

  function submit(port: number, filename: string): Promise<Response> {
    return fetch(`http://localhost:${port}/api/files/local`, {
      method: 'POST',
      headers: { 'X-Api-Key': 'test-key' },
      body: uploadForm(filename),
    });
  }

  describe('the push socket', () => {
    // The positive case - a session this server issued IS accepted - is what every acceptance run
    // depends on, so it is covered by all of them and is not repeated here.
    it('accepts a session it issued', async () => {
      server = await startOctoPrintServer(0, () => {});
      const { name, session } = await issuedSession(server.port);
      const ws = await connect(server.port);

      ws.send(JSON.stringify({ auth: `${name}:${session}` }));

      expect(await repliedWithin(ws, 300)).toContain('history');
      ws.close();
    });

    // AIDEV-NOTE: the shape this codebase really sent until 2026-08-26. OctoPrint rejects it - the
    // second part must be a session from a login call, not the api key - and a simulator that waved
    // it through is what let the mistake stand for months without anything noticing.
    it.each([
      ['an api key in place of an issued session', { auth: 'apikey:test-key' }],
      ['a session it never issued', { auth: 'operator:sess-invented' }],
      ['a frame that is not an auth frame at all', { subscribe: 'everything' }],
    ])('refuses %s', async (_case, frame) => {
      server = await startOctoPrintServer(0, () => {});
      const ws = await connect(server.port);

      ws.send(JSON.stringify(frame));

      expect(await repliedWithin(ws, 300)).toBeUndefined();
      ws.close();
    });

    it('tells a socket that never authenticated nothing at all', async () => {
      server = await startOctoPrintServer(0, () => {});
      const ws = await connect(server.port);

      expect(await repliedWithin(ws, 300)).toBeUndefined();
      ws.close();
    });
  });

  // AIDEV-NOTE: the client reads this back to learn where the file actually went - a completion event
  // carries the path the machine FILED it under, and OctoPrint does not always file it where it was
  // asked to. A simulator answering a bare `done` leaves the client with nothing but its own guess.
  it('answers an upload with the path it filed it under', async () => {
    server = await startOctoPrintServer(0, () => {});

    const answered = (await submit(server.port, 'tray.gcode')).json();

    expect(await answered).toMatchObject({ done: true, files: { local: { name: 'tray.gcode', path: 'plates/tray.gcode' } } });
  });

  // AIDEV-NOTE: a real printer runs one job at a time. Nothing that drives this submits two at once -
  // a printer already holding a job takes no other - so no acceptance test springs this trap, and a
  // regression here would let a future scheduling bug overlap jobs silently.
  it('refuses a second job while one is still printing', async () => {
    const neverCompletes: JobSubmittedHandler = () => {};
    server = await startOctoPrintServer(0, neverCompletes);

    expect((await submit(server.port, 'first.gcode')).ok).toBe(true);
    expect((await submit(server.port, 'second.gcode')).status).toBe(409);
  });
});
