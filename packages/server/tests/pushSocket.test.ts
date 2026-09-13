import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { pushSocket } from '../src/OctoPrint';
import type { PushSocket } from '../src/OctoPrint';

// AIDEV-NOTE: the adapter from `ws` to the one interface the rest of this shop knows, and the one
// thing about the push side that a fake socket cannot say. `OctoPrint` is driven through an injected
// socket everywhere else - which proves it behaves as its author imagined `ws` behaves, and that is
// exactly the assumption this pins.
//
// Against a real `ws` server in this process. Not because a socket is the claim: what is claimed is
// what THIS code does with what `ws` hands it, and a fake `ws` would be where the belief about what
// `ws` hands over gets written down. What `ws` reports when it cannot connect at all is its own, and
// is in tests/assumptions/pushSocket.test.ts.
describe('the push socket the shop reaches a printer with', () => {
  let server: WebSocketServer;
  let url: string;
  let connected: WebSocket[];
  let opened: PushSocket[];

  const reaching = (): Promise<PushSocket> =>
    new Promise((open) => {
      const socket = pushSocket(url);
      opened.push(socket);
      socket.onopen = () => open(socket);
    });

  const whenAsked = (): Promise<WebSocket> =>
    new Promise((arrived) => {
      if (connected.length > 0) arrived(connected[0]);
      else server.once('connection', (client) => arrived(client));
    });

  beforeEach(async () => {
    connected = [];
    opened = [];
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    server.on('connection', (client) => connected.push(client));
    await new Promise<void>((listening) => server.once('listening', () => listening()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    opened.forEach((socket) => socket.close());
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  it('says when it is open', async () => {
    await expect(reaching()).resolves.toBeDefined();
  });

  // AIDEV-NOTE: a text frame arrives from `ws` as a BUFFER where the DOM would give a string, and
  // everything above this parses what it is handed with `JSON.parse`. Handed the buffer, every frame
  // the printer sends would be unreadable - and no test driving a fake socket would notice, because
  // a fake hands over whatever its author thought `ws` hands over.
  it('hands a text frame over as a string, which is what the shop parses', async () => {
    const socket = await reaching();
    const heard = new Promise<unknown>((said) => (socket.onmessage = said));

    (await whenAsked()).send(JSON.stringify({ history: { state: 'Operational' } }));

    const frame = await heard;
    expect(typeof frame).toBe('string');
    expect(JSON.parse(frame as string)).toEqual({ history: { state: 'Operational' } });
  });

  // A binary frame is passed on as it came, so one this adapter cannot read stays unreadable rather
  // than becoming plausible nonsense.
  it('hands a binary frame over as it came', async () => {
    const socket = await reaching();
    const heard = new Promise<unknown>((said) => (socket.onmessage = said));

    (await whenAsked()).send(Uint8Array.from([1, 2, 3]), { binary: true });

    expect(typeof (await heard)).not.toBe('string');
  });

  it('sends what it is given, so a printer hears the handshake', async () => {
    const socket = await reaching();
    const client = await whenAsked();
    const heard = new Promise<string>((said) => client.once('message', (data) => said(data.toString())));

    socket.send(JSON.stringify({ auth: 'operator:sess-1' }));

    expect(JSON.parse(await heard)).toEqual({ auth: 'operator:sess-1' });
  });

  // What tells the shop a printer has gone quiet, and the only thing that starts a reconnect.
  it('says when the far end has gone', async () => {
    const socket = await reaching();
    const gone = new Promise<void>((closed) => (socket.onclose = closed));

    (await whenAsked()).terminate();

    await expect(gone).resolves.toBeUndefined();
  });

  it('says when it has been closed from this end', async () => {
    const socket = await reaching();
    const gone = new Promise<void>((closed) => (socket.onclose = closed));

    socket.close();

    await expect(gone).resolves.toBeUndefined();
  });
});
