import http from 'node:http';
import express from 'express';
import type { Express } from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import { Busy, SimulatedPrinter } from './simulatedPrinter.js';
import { PushSockets } from './pushSockets.js';
import type { CompletionEventType } from './simulatedPrinter.js';
import type { Connected } from './pushSockets.js';

export interface SubmittedJob {
  remotePath: string;
  filename: string;
  gcode: Buffer;
}

export type CompleteJob = (type: CompletionEventType) => void;

export type JobSubmittedHandler = (job: SubmittedJob, complete: CompleteJob) => void | Promise<void>;

// AIDEV-NOTE: loopback, and nothing configurable. This is a test double with no api key check and
// an unauthenticated upload endpoint; binding every interface put that on the LAN while the banner
// promised http://localhost. If octo-sim ever needs to be reachable from another machine, that
// should be an explicit --host flag, not the default it used to be by omission.
const LOOPBACK = '127.0.0.1';

// AIDEV-NOTE: memoryStorage with no limit meant one upload could exhaust the heap. 200MB is
// generous against a large kit's gcode and still bounded. Injectable only so a test can prove the
// limit is wired up without posting 200MB.
export const UPLOAD_LIMIT_BYTES = 200 * 1024 * 1024;

export interface OctoPrintServer {
  port: number;
  /** Read back off the socket, so a caller cannot be misled about its reach. */
  host: string;
  /** The cap actually in force, for the same reason. */
  uploadLimitBytes: number;
  broadcastEvent(type: CompletionEventType, path: string): void;
  /**
   * Test control: severs every live push socket without stopping the server, the way a network
   * blip does. The "printer" keeps going - a client has to reconnect and work out what it missed,
   * which is the only way to exercise the shop's reconnect recovery.
   */
  dropConnections(): void;
  /**
   * Test control: how many push sockets have been accepted. A test that severs the connection
   * asserts on this to prove the client really did reconnect, rather than passing because the
   * disconnect never happened.
   */
  connectionsAccepted(): number;
  /**
   * Test control: how many sockets are authenticated, and so would receive a broadcast now.
   *
   * Apart from `connectionsAccepted` because they answer different questions, and the gap between
   * them is where a test goes flaky: a socket is COUNTED when it is accepted and only becomes a
   * listener once it has presented a session, which is a round trip later. A test that fires an
   * event when the count rises is firing it at a client that cannot hear it yet.
   */
  listening(): number;
  /**
   * Test control: every api key a request has presented, in the order they arrived. Still not
   * checked - this remains a test double - but a client that was rebuilt with a corrected key is
   * otherwise indistinguishable from one that kept the old one.
   */
  keysPresented(): string[];
  close(): Promise<void>;
}

/** What an app hands back besides itself, so a caller can see what it has been told. */
export interface OctoPrintApp {
  app: Express;
  keysPresented(): string[];
}

/**
 * The HTTP half, over a printer and its listeners. Built apart from `startOctoPrintServer` so that
 * every route can be driven without a port: an express app is a function of a request.
 */
export function createOctoPrintApp(
  printer: SimulatedPrinter,
  pushes: PushSockets,
  onJobSubmitted: JobSubmittedHandler,
  uploadLimitBytes: number = UPLOAD_LIMIT_BYTES
): OctoPrintApp {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitBytes } });

  const keysPresented: string[] = [];
  app.use((req, _res, next) => {
    const presented = req.header('X-Api-Key');
    if (presented !== undefined) keysPresented.push(presented);

    next();
  });

  app.post('/api/files/local', upload.single('file'), (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'missing file' });
      return;
    }

    const folder = typeof req.body?.path === 'string' ? (req.body.path as string) : '';

    let remotePath: string;
    try {
      remotePath = printer.take(file.originalname, folder);
    } catch (refusal) {
      if (!(refusal instanceof Busy)) throw refusal;
      res.status(409).json({ error: refusal.message });
      return;
    }

    // AIDEV-NOTE: the shape OctoPrint documents for an upload, not a bare `done`. The client reads
    // `files.local.path` back to learn where the file actually went, so a simulator that answered
    // only `done` could not tell it - and the one thing this answer proves is that the client takes
    // the path from the machine rather than from its own guess.
    res.status(200).json({ done: true, files: { local: { name: file.originalname, path: remotePath, origin: 'local' } } });
    pushes.status();

    const complete: CompleteJob = (type) => {
      printer.finished(remotePath, type);
      // State first, then the event. A client that reacts to the event must not find the printer
      // still claiming to run the job it was just told had finished.
      pushes.status();
      pushes.event(type, remotePath);
    };

    // AIDEV-NOTE: a plain `Promise.resolve(onJobSubmitted(...)).catch(...)` only catches a rejected
    // promise - a synchronous throw happens before Promise.resolve() is reached and would leave the
    // printer stuck running for ever. Wrapping the call itself is what catches both.
    void (async () => {
      try {
        await onJobSubmitted({ remotePath, filename: file.originalname, gcode: file.buffer }, complete);
      } catch (error) {
        printer.gaveUp();
        console.error(`octo-sim: job handler failed for ${remotePath}:`, error);
      }
    })();
  });

  app.post('/api/login', express.json(), (_req, res) => {
    res.status(200).json(printer.logIn());
  });

  app.post('/api/job', express.json(), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const FILE_ROUTE_PREFIX = '/api/files/local/';

  app.get(/^\/api\/files\/local\/.+/, (req, res) => {
    const asked = req.path
      .slice(FILE_ROUTE_PREFIX.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');

    const filed = printer.filed(asked);
    if (filed === undefined) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.status(200).json(filed);
  });

  return { app, keysPresented: () => [...keysPresented] };
}

/** Implements just enough of OctoPrint's real HTTP and WebSocket protocol to drive a client at. */
export function startOctoPrintServer(
  port: number,
  onJobSubmitted: JobSubmittedHandler,
  uploadLimitBytes: number = UPLOAD_LIMIT_BYTES
): Promise<OctoPrintServer> {
  const printer = new SimulatedPrinter();
  const pushes = new PushSockets(printer);
  const { app, keysPresented } = createOctoPrintApp(printer, pushes, onJobSubmitted, uploadLimitBytes);

  const sockets = new Set<WebSocket>();
  let connectionsAccepted = 0;

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/sockjs/websocket' });

  wss.on('connection', (ws) => {
    connectionsAccepted++;
    sockets.add(ws);

    const socket: Connected = { send: (message) => ws.send(message), isOpen: () => ws.readyState === WebSocket.OPEN };

    ws.on('message', (raw) => pushes.said(socket, raw.toString()));
    ws.on('close', () => {
      pushes.left(socket);
      sockets.delete(ws);
    });
  });

  const severEveryone = (): void => {
    // terminate(), not close() - a close handshake is an orderly goodbye, and the failure being
    // simulated is a connection that simply stops.
    for (const client of sockets) client.terminate();
    sockets.clear();
    pushes.forgetEveryone();
  };

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, LOOPBACK, () => {
      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;

      resolve({
        port: boundPort,
        host: typeof address === 'object' && address ? address.address : LOOPBACK,
        uploadLimitBytes,
        broadcastEvent: (type, path) => pushes.event(type, path),
        connectionsAccepted: () => connectionsAccepted,
        listening: () => pushes.listening(),
        keysPresented,
        dropConnections: severEveryone,
        close: () =>
          new Promise<void>((closed) => {
            // httpServer.close() waits for open connections to end, and a push socket never ends on
            // its own - without this the server hangs on any client still attached.
            severEveryone();
            wss.close();
            httpServer.close(() => closed());
          }),
      });
    });
  });
}
