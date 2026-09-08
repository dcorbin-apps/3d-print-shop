import { basename, dirname } from 'node:path';
import type { Readable } from 'node:stream';
import { WebSocket as WsWebSocket, type RawData } from 'ws';
import type { PrinterOutcome } from './Job.js';
import type { Printer } from './printing.js';

export interface OctoPrintConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * How long to keep waiting for a print's outcome while the push socket is down. Reconnection
   * itself never gives up; this only bounds how long a caller is left holding an unresolved
   * waitForCompletion() before it is told the outcome is unknown.
   */
  lostContactTimeoutMs?: number;
}

export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * What this adapter needs of a socket, said in the shop's terms rather than the DOM's: the payload
 * of a frame, and the failure underneath a close - which is the only thing that says why a printer
 * went quiet.
 */
export interface PushSocket {
  onopen: (() => void) | null;
  onmessage: ((frame: unknown) => void) | null;
  onerror: ((failure: unknown) => void) | null;
  onclose: (() => void) | null;
  send(frame: string): void;
  close(): void;
}

export type PushSocketFactory = (url: string) => PushSocket;

// AIDEV-NOTE: `ws`, not node's built-in WebSocket. The built-in reports every failure as the same
// sentence - "Received network error or non-101 status code." - with no code and no cause, so a
// refused connection, a name that does not resolve and a 404 handshake are one thing to an
// operator. `ws` hands over the error libuv raised, which is what whyUnreachable() has words for.
export const pushSocket: PushSocketFactory = (url) => {
  const socket = new WsWebSocket(url);
  const port: PushSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (frame) => socket.send(frame),
    close: () => socket.close(),
  };

  socket.on('open', () => port.onopen?.());
  // A text frame arrives here as a Buffer where the DOM gives a string. A binary one is passed on
  // as it came, so a frame this adapter cannot read stays unreadable rather than becoming
  // plausible nonsense.
  socket.on('message', (data: RawData, isBinary: boolean) => port.onmessage?.(isBinary ? data : data.toString()));
  socket.on('error', (failure: Error) => port.onerror?.(failure));
  socket.on('close', () => port.onclose?.());

  return port;
};

/**
  * Waits out the backoff before attempt `n`. Settles early when `cancelled` fires, and must let go
  * of whatever it is waiting on when it does - see `reconnectAfter`.
  */
export type ReconnectDelay = (attempt: number, cancelled: AbortSignal) => Promise<void>;

const MAX_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_UNIT_MS = 500;
const DEFAULT_LOST_CONTACT_TIMEOUT_MS = 10 * 60_000;

export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BACKOFF_UNIT_MS * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
}

// AIDEV-NOTE: an armed timer keeps the event loop open, so a backoff left running is a process that
// will not exit until it fires - which is a shop ignoring SIGTERM for as long as a minute while a
// supervisor waits to kill it. Clearing on cancel is the whole point; resolving without clearing
// would settle the promise and leave the process alive anyway.
export const reconnectAfter: ReconnectDelay = (attempt, cancelled) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, reconnectDelayMs(attempt));

    cancelled.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

// AIDEV-NOTE: "fetch failed" is the whole of what node says when it cannot reach a machine at all,
// and it names neither the address nor the reason. That message is not thrown away here: it ends up
// in `printer.paused.reason` and in the log, which is all an operator gets when a printer goes
// quiet - "could not start anything on mk4: fetch failed" tells them nothing they can act on.
//
// The reason is in the error's `cause`, as a libuv code. These are the ones a printer on a LAN
// actually produces; anything else keeps its own message rather than being guessed at.
const UNREACHABLE: Record<string, (where: string, host: string) => string> = {
  ECONNREFUSED: (where) => `nothing is listening at ${where}`,
  ENOTFOUND: (_where, host) => `the name ${host} does not resolve`,
  EAI_AGAIN: (_where, host) => `the name ${host} could not be looked up`,
  ETIMEDOUT: (where) => `${where} did not answer in time`,
  UND_ERR_CONNECT_TIMEOUT: (where) => `${where} did not answer in time`,
  UND_ERR_HEADERS_TIMEOUT: (where) => `${where} took too long to answer`,
  ECONNRESET: (where) => `${where} closed the connection`,
  EHOSTUNREACH: (_where, host) => `there is no route to ${host}`,
  ENETUNREACH: (_where, host) => `there is no network route to ${host}`,
  EPIPE: (where) => `${where} closed the connection part way through`,
};

// AIDEV-NOTE: node tries A and AAAA at once and reports both failures together, so a machine that is
// simply not there arrives as an AggregateError whose own message is empty. The first error in it is
// the one worth saying.
// The error underneath, which is the one that knows anything. By shape rather than by `instanceof
// AggregateError`: that is ES2021, and an error crossing a realm is not an instance of anything here.
function underneath(failure: unknown): unknown {
  const cause = (failure as { cause?: unknown })?.cause ?? failure;
  const collected = (cause as { errors?: unknown })?.errors;

  return Array.isArray(collected) ? (collected[0] as unknown) : cause;
}

function codeOf(failure: unknown): string | undefined {
  return (underneath(failure) as { code?: unknown } | undefined)?.code as string | undefined;
}

function hostIn(where: string): string {
  try {
    return new URL(where).host;
  } catch {
    return where;
  }
}

/**
 * Why a push socket closed without ever opening. The reason reaches an operator as
 * `printer.paused.reason`, so it says the same things a failed request says; a close with no error
 * before it has nothing to add, which is what a machine that answered and then hung up looks like.
 */
export function whySocketFailed(failure: unknown, where: string): string {
  const closed = `the push socket to ${where} closed before it opened`;

  return failure === null || failure === undefined ? closed : `${closed}: ${whyUnreachable(failure, where)}`;
}

/** Why a machine could not be reached, in words an operator can act on, and the code to search for. */
export function whyUnreachable(failure: unknown, where: string): string {
  const code = codeOf(failure);
  const inWords = code === undefined ? undefined : UNREACHABLE[code];

  if (inWords) return `${inWords(where, hostIn(where))} (${code})`;
  if (code !== undefined) return `${where} could not be reached (${code})`;

  // The CAUSE's message, not the outer one: node's outer message is "fetch failed" for everything,
  // where the cause says something like "bad port" - which is the half worth passing on.
  const said = (underneath(failure) as Error | undefined)?.message || (failure as Error)?.message;

  return `${where} could not be reached: ${said ?? String(failure)}`;
}

// AIDEV-NOTE: none of these is a verdict. `PrintDone` says the machine reached the end of the file,
// which is not the same as the result being usable - the shop asks a person about that.
const OUTCOME_BY_EVENT: Record<string, PrinterOutcome | undefined> = {
  PrintDone: 'finished',
  PrintFailed: 'failed',
  PrintCancelled: 'cancelled',
};

// AIDEV-NOTE: OctoPrint pushes two shapes this adapter reads. `event` frames announce a print
// ending. `history` (sent once on connect, to bring a fresh client up to date) and `current`
// frames carry the printer's live state - which is how a reconnect learns what it missed without
// asking REST. See docs.octoprint.org/en/master/api/push.html.
interface OctoPrintPushMessage {
  event?: {
    type?: string;
    payload?: { path?: string };
  };
  current?: OctoPrintStatusPayload;
  history?: OctoPrintStatusPayload;
}

interface OctoPrintStatusPayload {
  state?: { flags?: PrinterStateFlags };
  job?: { file?: { path?: string } };
}

// The machine-readable half of OctoPrint's printer state. Its sibling `state.text` is documented
// as a human-readable string kept for backwards compatibility, so it is not matched on here: a
// wording this adapter did not anticipate would read as "not printing" and end a wait early.
interface PrinterStateFlags {
  printing?: boolean;
  paused?: boolean;
  pausing?: boolean;
  cancelling?: boolean;
}

interface OctoPrintFileInfo {
  prints?: { last?: { success?: boolean } };
}

interface CompletionWaiter {
  resolve: (status: PrinterOutcome) => void;
  reject: (error: Error) => void;
}

function parsePushMessage(data: unknown): OctoPrintPushMessage | null {
  if (typeof data !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as OctoPrintPushMessage) : null;
  } catch {
    return null;
  }
}

// An unreadable status must never end a wait early, so anything short of a clear "the printer is
// idle" counts as still printing.
function printIsInFlight(status: OctoPrintStatusPayload): boolean {
  const flags = status.state?.flags;
  if (!flags) return true;

  return Boolean(flags.printing || flags.paused || flags.pausing || flags.cancelling);
}

export class OctoPrint implements Printer {
  // AIDEV-NOTE: an event can arrive before waitForCompletion() is called for its path (a
  // fast print finishing before the caller gets around to awaiting it). arrivedCompletions
  // holds that result until it's claimed; pendingCompletions holds the reverse case, where
  // waitForCompletion() is already waiting and the event hasn't arrived yet.
  private readonly pendingCompletions = new Map<string, CompletionWaiter>();
  private readonly arrivedCompletions = new Map<string, PrinterOutcome>();
  private socket: PushSocket | null = null;
  private connected = false;
  private disconnectRequested = false;
  private reconnectAttempt = 0;
  private lostContactAt: number | null = null;
  private reconcileOnNextStatus = false;

  // Aborted by disconnect(), so a backoff that is already waiting stops waiting rather than holding
  // the process open until it fires. Replaced on connect(), because an abort is permanent.
  private stopWaiting = new AbortController();

  constructor(
    private readonly config: OctoPrintConfig,
    private readonly httpClient: HttpClient = globalThis.fetch.bind(globalThis),
    private readonly socketFactory: PushSocketFactory = pushSocket,
    private readonly reconnectDelay: ReconnectDelay = reconnectAfter,
    private readonly now: () => number = Date.now
  ) {}

  connect(): Promise<void> {
    this.disconnectRequested = false;
    this.stopWaiting = new AbortController();
    this.reconnectAttempt = 0;
    this.lostContactAt = null;
    this.reconcileOnNextStatus = false;
    return this.openSocket();
  }

  // AIDEV-NOTE: OctoPrint's push socket does not authenticate from an API key. Its auth frame wants
  // `<user id>:<session key>`, and the session key comes from a login call - see
  // docs.octoprint.org/en/master/api/push.html and OctoPrint's own server/util/sockjs.py, which
  // splits the payload on ':' and rejects anything that is not exactly two parts.
  //
  // This used to send `apikey:<the api key>`, which OctoPrint reads as user id "apikey" with the
  // key as a session token. That fails validation, resets the connection to anonymous and replies
  // reauthRequired - and an anonymous socket receives no status messages at all, so
  // waitForCompletion() would simply never fire. It went unnoticed because an OctoPrint that grants
  // guests read permissions (common on a single-user LAN install) delivers events anyway.
  //
  // Done per connection rather than once, so a reconnect after a long gap does not reuse a session
  // the server has since expired.
  // Every call the shop makes to a machine goes through here, so a machine that cannot be reached
  // says so once, the same way, wherever the shop was in the middle of.
  private async reach(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.httpClient(url, init);
    } catch (failure) {
      throw new Error(whyUnreachable(failure, this.config.baseUrl));
    }
  }

  private async passiveLogin(): Promise<{ name: string; session: string }> {
    const response = await this.reach(`${this.config.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ passive: true }),
    });

    if (!response.ok) {
      throw new Error(`OctoPrint login failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { name?: unknown; session?: unknown };
    if (typeof body.session !== 'string' || typeof body.name !== 'string' || body.name === '') {
      // A guest login returns no name, which means the api key was not accepted as a user.
      throw new Error(
        `OctoPrint passive login did not return a usable session (name: ${JSON.stringify(body.name)}, session: ${JSON.stringify(body.session)}). Check the API key.`
      );
    }

    return { name: body.name, session: body.session };
  }

  disconnect(): void {
    this.disconnectRequested = true;
    this.stopWaiting.abort();
    this.connected = false;
    this.lostContactAt = null;
    this.reconcileOnNextStatus = false;
    this.socket?.close();
    this.socket = null;

    for (const waiter of this.pendingCompletions.values()) {
      waiter.reject(new Error('OctoPrint connection was closed before print completion'));
    }
    this.pendingCompletions.clear();
    this.arrivedCompletions.clear();
  }

  // AIDEV-NOTE: the caller says where it goes. This used to build the folder name itself, which was
  // one client's filing scheme baked into a printer.
  //
  // The stream is read whole for the upload, because a multipart body built from FormData wants a
  // Blob and a Blob wants its bytes. It arrives as a stream so the shop never holds a gcode it is
  // only storing; holding one it is about to send is a shorter-lived cost, and streaming the upload
  // would mean writing the multipart body by hand. See PLAN.
  async send(remotePath: string, gcode: Readable): Promise<string> {
    await this.ensureConnected();

    const folder = dirname(remotePath);
    const form = new FormData();
    form.append('file', new Blob([await readWhole(gcode)], { type: 'text/plain' }), basename(remotePath));
    form.append('path', folder === '.' ? '' : folder);
    form.append('print', 'true');

    const response = await this.reach(`${this.config.baseUrl}/api/files/local`, {
      method: 'POST',
      headers: { 'X-Api-Key': this.config.apiKey },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`OctoPrint upload failed: ${response.status} ${response.statusText}`);
    }

    return filedAt(await response.json().catch(() => undefined), remotePath);
  }

  // AIDEV-NOTE: connected on first use and kept open. A service prints for as long as it runs, so
  // there is no call that owns the connection's lifetime the way a one-shot command did.
  private async ensureConnected(): Promise<void> {
    if (!this.connected) await this.connect();
  }

  awaitOutcome(remotePath: string): Promise<PrinterOutcome> {
    const arrived = this.arrivedCompletions.get(remotePath);
    if (arrived !== undefined) {
      this.arrivedCompletions.delete(remotePath);
      return Promise.resolve(arrived);
    }

    return new Promise<PrinterOutcome>((resolve, reject) => {
      this.pendingCompletions.set(remotePath, { resolve, reject });
    });
  }

  // AIDEV-NOTE: the key is NOT in the URL. It used to be appended as ?apikey=..., which puts a
  // credential everywhere URLs are recorded - proxy logs, server access logs, error reports - and
  // it was never encoded, so a key containing & or # would have broken the URL besides. OctoPrint's
  // documented handshake is the {"auth":"apikey:..."} frame sent on open, which carries the key in
  // the payload instead. That also partly undoes the deliberate carve-out in cli/core/printConfig.ts,
  // which refuses a --octoprint-api-key flag precisely to keep the key out of `ps` and shell history.
  //
  // A header would be the other option, but the WebSocket constructor this uses is the standard
  // one, which has no way to set request headers - hence the auth frame, not a header.
  //
  // The returned promise always settles for the socket it opened: resolved on open, rejected if
  // that socket closes first. Deciding what a failure means is the caller's - connect() reports it,
  // a reconnect re-enters its backoff loop - which is why nothing here reconnects on its own.
  private async openSocket(): Promise<void> {
    const { name, session } = await this.passiveLogin();
    // AIDEV-NOTE: OctoPrint uses SockJS; this URL works for direct WS transport but may need
    // SockJS path format (/<3digits>/<sessionid>/websocket) for some deployments.
    const wsUrl = `${this.config.baseUrl.replace(/^http/, 'ws')}/sockjs/websocket`;

    return new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(wsUrl);
      this.socket = socket;
      let opened = false;
      let failure: unknown = null;

      socket.onopen = () => {
        opened = true;
        this.connected = true;
        this.reconnectAttempt = 0;
        socket.send(JSON.stringify({ auth: `${name}:${session}` }));
        resolve();
      };

      socket.onmessage = (frame) => this.handleMessage(frame);

      // AIDEV-NOTE: onerror never reconnects - an error is always followed by a close, on both
      // browser and ws-in-node implementations, and that is where the decision lives. What it is
      // for is the reason: this is the only place the cause is offered, and a close carries none.
      socket.onerror = (thrown) => {
        failure = thrown;
      };

      // AIDEV-NOTE: a close here doesn't mean any print stopped - OctoPrint keeps printing
      // independently of who's listening. Reconnect indefinitely (backoff capped at
      // MAX_RECONNECT_DELAY_MS) instead of giving up, since jobs already in flight have no
      // other way to learn their outcome.
      socket.onclose = () => {
        this.connected = false;
        if (this.disconnectRequested) return;

        if (!opened) {
          reject(new Error(whySocketFailed(failure, this.config.baseUrl)));
          return;
        }

        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.disconnectRequested) return;
    if (this.lostContactAt === null) this.lostContactAt = this.now();

    this.reconnectAttempt++;
    void this.reconnectDelay(this.reconnectAttempt, this.stopWaiting.signal)
      .then(async () => {
        if (this.disconnectRequested) return;
        this.failPendingWhenContactLostTooLong();
        await this.openSocket();
        // Set only once the socket is open, so the status frame OctoPrint sends on connect is the
        // one that settles what the outage hid. Ordering is safe: this continuation is a microtask
        // and the frame cannot arrive before it runs.
        this.reconcileOnNextStatus = true;
      })
      .catch(() => {
        // AIDEV-NOTE: a reconnect that fails - refused login, socket closed before opening - has to
        // re-enter the backoff loop. Discarding it here ended reconnection permanently after one
        // bad attempt and left every in-flight job's promise unresolved forever.
        this.scheduleReconnect();
      });
  }

  // AIDEV-NOTE: OctoPrint's push socket does not replay the completion events that fired while it
  // was down, so a print that ended during the outage is never announced. What it does send on
  // connect is a status frame, and that frame names the job the printer is running now - so any
  // job still pending that the printer is NOT running has already finished, and only its outcome
  // is left to look up.
  private async reconcilePendingCompletions(status: OctoPrintStatusPayload): Promise<void> {
    if (this.pendingCompletions.size === 0) return;

    const inFlightPath = printIsInFlight(status) ? (status.job?.file?.path ?? null) : null;

    for (const path of [...this.pendingCompletions.keys()]) {
      if (path === inFlightPath) continue;

      const outcome = await this.lastPrintOutcome(path);
      if (outcome) this.settleCompletion(path, outcome);
    }
  }

  // AIDEV-NOTE: OctoPrint's print history records a cancelled print as a failure, so a run
  // reconciled after the fact cannot be told apart from a genuine error and reports 'failed'.
  // Only an event delivered live on the socket can report 'cancelled'.
  private async lastPrintOutcome(path: string): Promise<PrinterOutcome | null> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const info = await this.getJson<OctoPrintFileInfo>(`/api/files/local/${encodedPath}`);
    const success = info?.prints?.last?.success;

    if (typeof success !== 'boolean') return null;
    return success ? 'finished' : 'failed';
  }

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const response = await this.reach(`${this.config.baseUrl}${path}`, {
        headers: { 'X-Api-Key': this.config.apiKey },
      });
      if (!response.ok) return null;

      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private failPendingWhenContactLostTooLong(): void {
    if (this.lostContactAt === null || this.pendingCompletions.size === 0) return;

    const outOfContactMs = this.now() - this.lostContactAt;
    if (outOfContactMs < (this.config.lostContactTimeoutMs ?? DEFAULT_LOST_CONTACT_TIMEOUT_MS)) return;

    const error = new Error(
      `Lost contact with OctoPrint at ${this.config.baseUrl} for ${Math.round(outOfContactMs / 1000)}s; the outcome of the print is unknown. Check the printer before printing anything else.`
    );
    for (const waiter of this.pendingCompletions.values()) {
      waiter.reject(error);
    }
    this.pendingCompletions.clear();
  }

  // AIDEV-NOTE: OctoPrint pushes plenty of frames this adapter has no interest in, and a malformed
  // or binary one must not escape the handler - a throw here bypasses the socket's own
  // close/reconnect handling and can take the CLI process down mid-print.
  private handleMessage(frame: unknown): void {
    const message = parsePushMessage(frame);
    if (!message) return;

    // Any frame OctoPrint sends us is proof the socket is live AND authorized - an unauthenticated
    // one is answered with silence, not an error - so this, not the socket opening, is what ends an
    // outage. See the passiveLogin() note on how a bad auth frame used to hang every job.
    this.lostContactAt = null;

    if (message.event) {
      this.handleCompletionEvent(message.event.type, message.event.payload?.path);
      return;
    }

    const status = message.current ?? message.history;
    if (status) this.handleStatus(status);
  }

  private handleCompletionEvent(type: string | undefined, path: string | undefined): void {
    if (!type || !path) return;

    const status = OUTCOME_BY_EVENT[type];
    if (!status) return;

    this.settleCompletion(path, status);
  }

  private handleStatus(status: OctoPrintStatusPayload): void {
    if (!this.reconcileOnNextStatus) return;

    // Only the first status frame after an outage reconciles. Doing it on every frame would race
    // the window between submit() and the printer actually starting, where the printer is idle and
    // the file's history still holds the previous copy's outcome.
    this.reconcileOnNextStatus = false;
    void this.reconcilePendingCompletions(status);
  }

  private settleCompletion(path: string, status: PrinterOutcome): void {
    const waiter = this.pendingCompletions.get(path);
    if (waiter) {
      this.pendingCompletions.delete(path);
      waiter.resolve(status);
      return;
    }

    this.arrivedCompletions.set(path, status);
  }

  // AIDEV-NOTE: not on the Printer port - nothing asks a printer to stop mid-print yet. Kept rather
  // than deleted because an operator will want it and this is proven against a real OctoPrint; see
  // PLAN. OctoPrint cancels whatever is running, so it takes no argument.
  async cancel(): Promise<void> {
    const response = await this.reach(`${this.config.baseUrl}/api/job`, {
      method: 'POST',
      headers: {
        'X-Api-Key': this.config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ command: 'cancel' }),
    });

    if (!response.ok) {
      throw new Error(`OctoPrint cancel failed: ${response.status} ${response.statusText}`);
    }
  }
}

async function readWhole(stream: Readable): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(new Uint8Array(Buffer.from(chunk as Buffer)));

  const total = chunks.reduce((bytes, chunk) => bytes + chunk.length, 0);
  const whole = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }

  return whole;
}

// AIDEV-NOTE: read back rather than assumed. OctoPrint answers an upload with what it FILED, and the
// name it used is not always the one it was given - the docs show `20mm-ümläut-böx.gcode` stored as
// `20mm-umlaut-box.gcode`. A print's completion event carries that stored path and the watcher
// matches on the string, so a rename the shop did not follow is a print nobody hears the end of.
//
// The asked-for path is the fallback rather than a refusal: the upload has already SUCCEEDED, and
// turning that into a failed print over a body this cannot read would be worse than the guess the
// shop made for every print before this. Confirming the rule against a real machine is in PLAN.md.
function filedAt(answer: unknown, asked: string): string {
  const filed = (answer as { files?: { local?: { path?: unknown } } } | undefined)?.files?.local?.path;

  return typeof filed === 'string' && filed.trim() !== '' ? filed : asked;
}
