import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PushSockets } from '../src/pushSockets';
import { SimulatedPrinter } from '../src/simulatedPrinter';
import type { Connected } from '../src/pushSockets';

// AIDEV-NOTE: silence IS the rejection, which is what OctoPrint answers a bad auth frame with - so
// what these assert is that nothing was SENT, not that something was refused. A socket stood in for
// rather than opened: what is claimed is what this class does with a frame, and a socket is not that.
describe('who hears the printer', () => {
  let printer: SimulatedPrinter;
  let pushes: PushSockets;
  let issued: number;

  interface Listener extends Connected {
    heard: string[];
  }

  function aSocket(open = true): Listener {
    const heard: string[] = [];

    return {
      heard,
      send: jest.fn<(message: string) => void>((message) => heard.push(message)),
      isOpen: jest.fn<() => boolean>(() => open),
    };
  }

  const presenting = (auth: string): string => JSON.stringify({ auth });

  function loggedIn(): string {
    const { name, session } = printer.logIn();

    return presenting(`${name}:${session}`);
  }

  beforeEach(() => {
    issued = 0;
    printer = new SimulatedPrinter(
      () => 1_700_000_000_000,
      () => `sess-${++issued}`,
    );
    pushes = new PushSockets(printer);
  });

  describe('a socket presenting a session the printer issued', () => {
    it("is told the printer's history at once, unprompted", () => {
      const socket = aSocket();

      pushes.said(socket, loggedIn());

      expect(socket.heard).toHaveLength(1);
      expect(JSON.parse(socket.heard[0])).toHaveProperty('history');
    });

    it('is listening afterwards', () => {
      const socket = aSocket();

      pushes.said(socket, loggedIn());

      expect(pushes.listening()).toBe(1);
    });
  });

  // AIDEV-NOTE: the shape this codebase really sent until 2026-08-26, and two more. A simulator that
  // waved any of them through is what let the mistake stand for months without anything noticing.
  describe('a socket presenting anything else', () => {
    it.each([
      ['an api key in place of an issued session', JSON.stringify({ auth: 'apikey:test-key' })],
      ['a session it never issued', JSON.stringify({ auth: 'operator:sess-invented' })],
      ['a frame that is not an auth frame at all', JSON.stringify({ subscribe: 'everything' })],
      ['an auth payload of three parts', JSON.stringify({ auth: 'operator:sess-1:extra' })],
      ['an auth payload of one part', JSON.stringify({ auth: 'operator' })],
    ])('is told nothing at all for %s', (_case, frame) => {
      printer.logIn();
      const socket = aSocket();

      pushes.said(socket, frame);

      expect(socket.send).not.toHaveBeenCalled();
    });

    it('is not listening afterwards', () => {
      printer.logIn();
      const socket = aSocket();

      pushes.said(socket, JSON.stringify({ auth: 'apikey:test-key' }));

      expect(pushes.listening()).toBe(0);
    });

    // Left open rather than closed, so a client that got it wrong waits for events that never come -
    // which is what a real printer gives it.
    it('hears nothing later either, when the printer has something to say', () => {
      printer.logIn();
      const socket = aSocket();
      pushes.said(socket, JSON.stringify({ auth: 'apikey:test-key' }));

      pushes.status();
      pushes.event('PrintDone', 'plates/tray.gcode');

      expect(socket.heard).toEqual([]);
    });
  });

  // A socket that has said nothing at all, which is every socket before its first frame.
  it('tells a socket that never presented anything nothing at all', () => {
    expect(pushes.listening()).toBe(0);
  });

  describe('what a listener is told', () => {
    let socket: Listener;

    beforeEach(() => {
      socket = aSocket();
      pushes.said(socket, loggedIn());
      socket.heard.length = 0;
    });

    it("is the printer's state when it changes", () => {
      pushes.status();

      expect(JSON.parse(socket.heard[0])).toHaveProperty('current');
    });

    it('is the event, naming the type and the path', () => {
      pushes.event('PrintDone', 'plates/tray.gcode');

      expect(JSON.parse(socket.heard[0])).toEqual({ event: { type: 'PrintDone', payload: { path: 'plates/tray.gcode' } } });
    });

    it('is nothing once it has gone', () => {
      pushes.left(socket);
      pushes.status();

      expect(socket.heard).toEqual([]);
    });

    it('is nothing once everyone has been forgotten', () => {
      pushes.forgetEveryone();
      pushes.status();

      expect(socket.heard).toEqual([]);
      expect(pushes.listening()).toBe(0);
    });

    // A socket still in the set but no longer open is one the far end has already gone from.
    it('is nothing to a socket that is no longer open', () => {
      const closed = aSocket(false);
      pushes.said(closed, loggedIn());
      closed.heard.length = 0;

      pushes.status();

      expect(closed.heard).toEqual([]);
    });
  });

  it('tells every listener, and not only the first', () => {
    const one = aSocket();
    const two = aSocket();
    pushes.said(one, loggedIn());
    pushes.said(two, loggedIn());

    pushes.event('PrintDone', 'plates/tray.gcode');

    expect(one.heard).toHaveLength(2);
    expect(two.heard).toHaveLength(2);
  });
});
