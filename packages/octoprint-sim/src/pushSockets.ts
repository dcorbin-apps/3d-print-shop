import type { CompletionEventType, SimulatedPrinter } from './simulatedPrinter.js';

/** As much of a socket as the push side uses. `ws` satisfies it; so does a test's stand-in. */
export interface Connected {
  send(message: string): void;
  isOpen(): boolean;
}

/**
 * Who is listening to the printer, and what they are told.
 *
 * AIDEV-NOTE: only sockets that have completed the auth handshake are in here. The api key itself
 * is never checked - this is a test double, not a security boundary - but requiring the handshake
 * to have HAPPENED is protocol conformance, and it is the only cover that the shop's client
 * authenticates at all now that the key no longer rides along in the URL.
 */
export class PushSockets {
  private readonly authenticated = new Set<Connected>();

  constructor(private readonly printer: SimulatedPrinter) {}

  // AIDEV-NOTE: silence IS the rejection, exactly as OctoPrint answers a bad auth frame. Nothing is
  // sent and the socket is left open, so a client that got it wrong waits for events that never
  // come - which is the failure a real printer would give it.
  /** A frame arrived. An acceptable one joins the listeners and is brought up to date at once. */
  said(socket: Connected, raw: string): void {
    if (!this.printer.authenticates(raw)) return;

    this.authenticated.add(socket);
    // Real OctoPrint sends this the moment a client is entitled to it, and a reconnecting client
    // depends on it to learn whether the job it was waiting on is still running.
    socket.send(JSON.stringify({ history: this.printer.statusPayload() }));
  }

  left(socket: Connected): void {
    this.authenticated.delete(socket);
  }

  forgetEveryone(): void {
    this.authenticated.clear();
  }

  /** How many would receive a broadcast now. */
  listening(): number {
    return this.authenticated.size;
  }

  event(type: CompletionEventType, path: string): void {
    this.tell(JSON.stringify({ event: { type, payload: { path } } }));
  }

  status(): void {
    this.tell(JSON.stringify({ current: this.printer.statusPayload() }));
  }

  private tell(message: string): void {
    for (const socket of this.authenticated) {
      if (socket.isOpen()) socket.send(message);
    }
  }
}
