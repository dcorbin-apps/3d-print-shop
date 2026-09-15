import { describe, it, expect } from '@jest/globals';
import { pushSocket, whySocketFailed } from '../../src/OctoPrint';
import type { PushSocket } from '../../src/OctoPrint';

// AIDEV-NOTE: a real connection to a port nothing is on. What an operator is told depends entirely
// on which socket is underneath: node's built-in reports a refused connection, a name that does not
// resolve and a rejected handshake as one sentence - "Received network error or non-101 status
// code." - with no code and no cause, so nothing above it can say more. `ws` raises the libuv error
// itself. A unit test with a fake socket cannot tell the two apart; this can.
describe('a push socket that cannot connect', () => {
  const NOTHING_LISTENS_THERE = 'ws://127.0.0.1:1/sockjs/websocket';

  it('reports the reason libuv gave, not a sentence that fits every failure', async () => {
    let socket: PushSocket | undefined;

    const failure = await new Promise<unknown>((reported) => {
      socket = pushSocket(NOTHING_LISTENS_THERE);
      socket.onerror = reported;
    });
    socket?.close();

    expect(whySocketFailed(failure, 'http://127.0.0.1:1')).toBe(
      'the push socket to http://127.0.0.1:1 closed before it opened: nothing is listening at http://127.0.0.1:1 (ECONNREFUSED)',
    );
  });
});
