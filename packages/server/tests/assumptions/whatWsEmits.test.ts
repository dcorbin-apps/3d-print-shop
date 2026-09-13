import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

// AIDEV-NOTE: what `ws` hands a listener, which the shop's adapter is built on and is not the shop's
// to prove. `pushSocket` turns a text frame into a string and leaves a binary one alone, and the
// whole of that rests on the two facts below: a text frame arrives as a BUFFER, not the string the
// DOM would give, and `isBinary` is the only thing that tells the two apart.
//
// The mapping itself is tests/pushSocket.test.ts, asked with a stand-in and no socket at all. Here a
// red line means `ws` changed, not that somebody broke the shop.
describe('what ws hands a listener', () => {
  let server: WebSocketServer;
  let url: string;
  let opened: WebSocket[];

  const talking = (): Promise<{ client: WebSocket; served: WebSocket }> =>
    new Promise((ready) => {
      let served: WebSocket | undefined;
      let client: WebSocket | undefined;
      const bothUp = (): void => {
        if (served !== undefined && client !== undefined) ready({ client, served });
      };

      server.once('connection', (socket) => {
        served = socket;
        bothUp();
      });

      const asking = new WebSocket(url);
      opened.push(asking);
      asking.on('open', () => {
        client = asking;
        bothUp();
      });
    });

  const heardBy = (socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> =>
    new Promise((said) => socket.once('message', (data, isBinary) => said({ data, isBinary })));

  beforeEach(async () => {
    opened = [];
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((listening) => server.once('listening', () => listening()));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    opened.forEach((socket) => socket.terminate());
    await new Promise<void>((closed) => server.close(() => closed()));
  });

  // AIDEV-NOTE: the one that matters. The DOM gives a string here; `ws` gives a Buffer, and anything
  // that parses what it is handed without decoding first reads nothing at all.
  it('gives a text frame as a Buffer, and says it is not binary', async () => {
    const { client, served } = await talking();
    const heard = heardBy(client);

    served.send(JSON.stringify({ history: {} }));

    const { data, isBinary } = await heard;
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(isBinary).toBe(false);
    expect((data as Buffer).toString()).toBe(JSON.stringify({ history: {} }));
  });

  // Two frames, because saying `false` to everything would satisfy the test above.
  it('says a binary frame is binary', async () => {
    const { client, served } = await talking();
    const heard = heardBy(client);

    served.send(Uint8Array.from([1, 2, 3]), { binary: true });

    const { data, isBinary } = await heard;
    expect(isBinary).toBe(true);
    expect([...(data as Buffer)]).toEqual([1, 2, 3]);
  });

  it('says when the far end has gone, without being asked', async () => {
    const { client, served } = await talking();
    const gone = new Promise<void>((closed) => client.once('close', () => closed()));

    served.terminate();

    await expect(gone).resolves.toBeUndefined();
  });
});
