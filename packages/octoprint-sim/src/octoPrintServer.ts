import http from 'node:http';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';

export type CompletionEventType = 'PrintDone' | 'PrintFailed' | 'PrintCancelled';

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
   * which is the only way to exercise OctoPrintAdapter's reconnect recovery.
   */
  dropConnections(): void;
  /**
   * Test control: how many push sockets have been accepted. A test that severs the connection
   * asserts on this to prove the client really did reconnect, rather than passing because the
   * disconnect never happened.
   */
  connectionsAccepted(): number;
  /**
   * Test control: every api key a request has presented, in the order they arrived. Still not
   * checked - this remains a test double - but a client that was rebuilt with a corrected key is
   * otherwise indistinguishable from one that kept the old one.
   */
  keysPresented(): string[];
  close(): Promise<void>;
}

interface PrintHistory {
  success: number;
  failure: number;
  last: { date: number; printTime: number; success: boolean };
}

// AIDEV-NOTE: OctoPrint's own sockjs.py splits the auth payload on ':' and requires exactly two
// parts, `<user id>:<session key>`, where the session came from a login call. Matched here rather
// than waved through, because a simulator that accepts any shape is what let this codebase send
// `apikey:<the api key>` for months without anything noticing.
function parseAuthFrame(raw: string): { name: string; session: string } | undefined {
  try {
    const message = JSON.parse(raw) as { auth?: unknown };
    if (typeof message.auth !== 'string') return undefined;

    const parts = message.auth.split(':');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined;

    return { name: parts[0], session: parts[1] };
  } catch {
    return undefined;
  }
}

// AIDEV-NOTE: implements just enough of OctoPrint's real HTTP/WebSocket protocol for
// OctoPrintAdapter (packages/printer) to talk to this unmodified - see design/octo-sim.md.
// Does not validate the X-Api-Key header or the api key itself; this is a test double, not a
// security boundary. It does require the websocket auth handshake to have happened - see below.
export function startOctoPrintServer(
  port: number,
  onJobSubmitted: JobSubmittedHandler,
  uploadLimitBytes: number = UPLOAD_LIMIT_BYTES
): Promise<OctoPrintServer> {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: uploadLimitBytes } });

  const keysPresented: string[] = [];
  app.use((req, _res, next) => {
    const presented = req.header('X-Api-Key');
    if (presented !== undefined) keysPresented.push(presented);

    next();
  });

  // AIDEV-NOTE: only clients that have completed the {"auth":"apikey:..."} handshake receive
  // events. The key itself is still not checked - this remains a test double, not a security
  // boundary - but requiring the handshake to have HAPPENED is protocol conformance, and it is the
  // only end-to-end cover that OctoPrintAdapter authenticates at all now that the key no longer
  // rides along in the URL where a connection would carry it implicitly.
  const authenticated = new Set<WebSocket>();
  const sockets = new Set<WebSocket>();

  // AIDEV-NOTE: OctoPrint records a cancelled print as a failure, not a third outcome - so does
  // this. A client reconciling after the fact genuinely cannot tell the two apart; pretending
  // otherwise here would let a test pass that the real server would fail.
  const printHistory = new Map<string, PrintHistory>();
  const uploadedFiles = new Set<string>();
  let connectionsAccepted = 0;

  // AIDEV-NOTE: sessions this server has actually issued via POST /api/login. A socket must present
  // one; the api key alone is not accepted, exactly as OctoPrint behaves. The key itself still is
  // not checked on login - this remains a test double, not a security boundary.
  const issuedSessions = new Map<string, string>();
  const SIMULATED_USER = 'operator';

  const sendToAuthenticated = (message: string): void => {
    for (const client of authenticated) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  };

  const broadcastEvent = (type: CompletionEventType, path: string): void => {
    sendToAuthenticated(JSON.stringify({ event: { type, payload: { path } } }));
  };

  // AIDEV-NOTE: the shape real OctoPrint pushes as `history` (once, on connect, to bring a fresh
  // client up to date) and `current` (as things change). `state.text` is here for faithfulness
  // only - it is documented as human-readable, and a client that decides anything from it rather
  // than from the flags is the bug this payload exists to catch.
  const statusPayload = (): unknown => ({
    state: {
      text: activeJobPath === null ? 'Operational' : 'Printing',
      flags: {
        operational: true,
        printing: activeJobPath !== null,
        paused: false,
        pausing: false,
        cancelling: false,
        sdReady: false,
        error: false,
        ready: activeJobPath === null,
        closedOrError: false,
      },
    },
    job: { file: { path: lastJobPath } },
    progress: { completion: activeJobPath === null ? null : 0, printTimeLeft: null },
    logs: [],
  });

  const broadcastStatus = (): void => {
    sendToAuthenticated(JSON.stringify({ current: statusPayload() }));
  };

  const recordPrint = (path: string, success: boolean): void => {
    const previous = printHistory.get(path) ?? { success: 0, failure: 0 };
    printHistory.set(path, {
      success: previous.success + (success ? 1 : 0),
      failure: previous.failure + (success ? 0 : 1),
      last: { date: Math.floor(Date.now() / 1000), printTime: 1, success },
    });
  };

  // AIDEV-NOTE: a real printer can only run one job at a time. Tracking this here (not
  // left to callers) means a queue bug that submits out of turn gets a hard 409 instead of
  // silently overlapping jobs. This also means InteractiveJobQueue's multi-job queuing
  // (packages/octo-sim/src/core/InteractiveJobQueue.ts) is unreachable via the real
  // protocol from a well-behaved client - it remains a defensive fallback, not dead code
  // to delete, since nothing here prevents it from being exercised directly.
  let activeJobPath: string | null = null;

  // AIDEV-NOTE: real OctoPrint goes on naming the last job in /api/job and its status frames after
  // that job ends - `state.flags` is the only thing that says whether it is still running. Clearing
  // this to null on completion (as this server used to) made the path harmless to ignore, which let
  // a client that reads the wrong field look correct here and fail against a real printer.
  let lastJobPath: string | null = null;

  app.post(
    '/api/files/local',
    (_req, res, next) => {
      if (activeJobPath !== null) {
        res.status(409).json({ error: `Printer is busy: ${activeJobPath} is still printing` });
        return;
      }
      next();
    },
    upload.single('file'),
    (req, res) => {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'missing file' });
        return;
      }

      // AIDEV-NOTE: the path the CLIENT asked for, which is what real OctoPrint files an upload
      // under. The folder used to be hardcoded here - one client's filing scheme baked into the
      // simulator - so a client uploading anywhere else was told its print had finished under a
      // path it had never named, and waited for an event that could not come.
      const folder = typeof req.body?.path === 'string' ? (req.body.path as string) : '';
      const remotePath = folder === '' ? file.originalname : `${folder}/${file.originalname}`;
      activeJobPath = remotePath;
      lastJobPath = remotePath;
      uploadedFiles.add(remotePath);
      // AIDEV-NOTE: the shape OctoPrint documents for an upload, not a bare `done`. The client reads
      // `files.local.path` back to learn where the file actually went, so a simulator that answered
      // only `done` could not tell it - and the one thing this answer proves is that the client
      // takes the path from the machine rather than from its own guess.
      res.status(200).json({
        done: true,
        files: { local: { name: file.originalname, path: remotePath, origin: 'local' } },
      });
      broadcastStatus();

      const complete: CompleteJob = (type) => {
        activeJobPath = null;
        recordPrint(remotePath, type === 'PrintDone');
        // State first, then the event. A client that reacts to the event must not find the
        // printer still claiming to run the job it was just told had finished.
        broadcastStatus();
        broadcastEvent(type, remotePath);
      };

      // AIDEV-NOTE: a plain `Promise.resolve(onJobSubmitted(...)).catch(...)` only catches
      // a rejected promise - a synchronous throw from onJobSubmitted happens before
      // Promise.resolve() is ever reached and would leave activeJobPath stuck forever,
      // permanently blocking the "printer". Wrapping the call itself in the try is what
      // catches both.
      (async () => {
        try {
          await onJobSubmitted({ remotePath, filename: file.originalname, gcode: file.buffer }, complete);
        } catch (error) {
          activeJobPath = null;
          console.error(`octo-sim: job handler failed for ${remotePath}:`, error);
        }
      })();
    }
  );

  // Passive login: the step that yields the session key the push socket's auth frame requires.
  app.post('/api/login', express.json(), (_req, res) => {
    const session = `sess-${Math.random().toString(36).slice(2)}`;
    issuedSessions.set(session, SIMULATED_USER);
    res.status(200).json({ name: SIMULATED_USER, session });
  });

  app.post('/api/job', express.json(), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const FILE_ROUTE_PREFIX = '/api/files/local/';

  app.get(/^\/api\/files\/local\/.+/, (req, res) => {
    const requestedPath = req.path
      .slice(FILE_ROUTE_PREFIX.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');

    if (!uploadedFiles.has(requestedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    const prints = printHistory.get(requestedPath);
    res.status(200).json({
      name: requestedPath.split('/').pop(),
      path: requestedPath,
      type: 'machinecode',
      // Real OctoPrint leaves `prints` out entirely for a file it has never printed.
      ...(prints ? { prints } : {}),
    });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/sockjs/websocket' });

  wss.on('connection', (ws) => {
    connectionsAccepted++;
    sockets.add(ws);
    ws.on('message', (raw) => {
      const auth = parseAuthFrame(raw.toString());
      if (auth && issuedSessions.get(auth.session) === auth.name) {
        authenticated.add(ws);
        // Real OctoPrint sends this the moment a client is entitled to it, and a reconnecting
        // client depends on it to learn whether the job it was waiting on is still running.
        ws.send(JSON.stringify({ history: statusPayload() }));
      }
    });
    ws.on('close', () => {
      authenticated.delete(ws);
      sockets.delete(ws);
    });
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, LOOPBACK, () => {
      const address = httpServer.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;

      resolve({
        port: boundPort,
        host: typeof address === 'object' && address ? address.address : LOOPBACK,
        uploadLimitBytes,
        broadcastEvent,
        connectionsAccepted: () => connectionsAccepted,
        keysPresented: () => [...keysPresented],
        dropConnections: () => {
          // terminate(), not close() - a close handshake is an orderly goodbye, and the failure
          // being simulated is a connection that simply stops.
          for (const client of sockets) client.terminate();
          sockets.clear();
          authenticated.clear();
        },
        close: () =>
          new Promise<void>((res) => {
            // httpServer.close() waits for open connections to end, and a push socket never ends
            // on its own - without this the server hangs on any client that is still attached.
            for (const client of sockets) client.terminate();
            sockets.clear();
            authenticated.clear();
            wss.close();
            httpServer.close(() => res());
          }),
      });
    });
  });
}
