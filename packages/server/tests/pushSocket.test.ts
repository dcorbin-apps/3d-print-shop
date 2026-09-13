import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { adapting } from '../src/OctoPrint';
import type { PushSocket, WsLike } from '../src/OctoPrint';
import type { RawData } from 'ws';

// AIDEV-NOTE: the mapping from a `ws` socket to the one push socket the rest of the shop knows -
// ours, and asked with a stand-in. The stand-in is not the claim: what is claimed is what this turns
// each thing into, not what `ws` hands it. What `ws` hands it is tests/assumptions/whatWsEmits.test.ts,
// and the two are separate because a red line in each means a different thing - one says somebody
// broke the mapping, the other says the world moved.
describe('the push socket the shop reaches a printer with', () => {
  let listeners: Map<string, (...said: never[]) => void>;
  let sent: string[];
  let closed: number;
  let ws: WsLike;
  let port: PushSocket;

  const arriving = (event: string, ...said: unknown[]): void => {
    listeners.get(event)?.(...(said as never[]));
  };

  beforeEach(() => {
    listeners = new Map();
    sent = [];
    closed = 0;

    ws = {
      on: jest.fn<(event: string, listener: (...said: never[]) => void) => unknown>((event, listener) => {
        listeners.set(event, listener);

        return ws;
      }),
      send: jest.fn<(frame: string) => void>((frame) => sent.push(frame)),
      close: jest.fn<() => void>(() => {
        closed += 1;
      }),
    } as unknown as WsLike;

    port = adapting(ws);
  });

  it('listens for everything the shop is told about, and nothing else', () => {
    expect([...listeners.keys()].sort()).toEqual(['close', 'error', 'message', 'open']);
  });

  it('says when it is open', () => {
    const opened = jest.fn<() => void>();
    port.onopen = opened;

    arriving('open');

    expect(opened).toHaveBeenCalledTimes(1);
  });

  // AIDEV-NOTE: a text frame arrives from `ws` as a BUFFER where the DOM gives a string, and
  // everything above this parses what it is handed with `JSON.parse`. Handed the buffer, every frame
  // a printer sends would be unreadable.
  it('hands a text frame over as a string, which is what the shop parses', () => {
    const heard: unknown[] = [];
    port.onmessage = (frame) => heard.push(frame);

    arriving('message', Buffer.from(JSON.stringify({ history: {} })) as RawData, false);

    expect(heard).toEqual([JSON.stringify({ history: {} })]);
  });

  // A binary frame is passed on as it came, so one this adapter cannot read stays unreadable rather
  // than becoming plausible nonsense.
  it('hands a binary frame over as it came', () => {
    const heard: unknown[] = [];
    port.onmessage = (frame) => heard.push(frame);
    const bytes = Buffer.from([1, 2, 3]);

    arriving('message', bytes as RawData, true);

    expect(heard).toEqual([bytes]);
  });

  it('says nothing to a shop that is not listening for frames', () => {
    expect(() => arriving('message', Buffer.from('{}') as RawData, false)).not.toThrow();
  });

  // The only thing this end is offered a reason by - a close carries none.
  it('says what went wrong when the socket says so', () => {
    const why = new Error('ECONNREFUSED');
    const heard: unknown[] = [];
    port.onerror = (failure) => heard.push(failure);

    arriving('error', why);

    expect(heard).toEqual([why]);
  });

  // What tells the shop a printer has gone quiet, and the only thing that starts a reconnect.
  it('says when the far end has gone', () => {
    const gone = jest.fn<() => void>();
    port.onclose = gone;

    arriving('close');

    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('sends what it is given, so a printer hears the handshake', () => {
    port.send(JSON.stringify({ auth: 'operator:sess-1' }));

    expect(sent).toEqual([JSON.stringify({ auth: 'operator:sess-1' })]);
  });

  it('closes the socket underneath when it is closed', () => {
    port.close();

    expect(closed).toBe(1);
  });
});
