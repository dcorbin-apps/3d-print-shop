export type CompletionEventType = 'PrintDone' | 'PrintFailed' | 'PrintCancelled';

export interface PrintHistory {
  success: number;
  failure: number;
  last: { date: number; printTime: number; success: boolean };
}

export interface FiledJob {
  name: string;
  path: string;
  type: 'machinecode';
  prints?: PrintHistory;
}

/** A printer already running something takes nothing else. */
export class Busy extends Error {}

const SIMULATED_USER = 'operator';

// AIDEV-NOTE: OctoPrint's own sockjs.py splits the auth payload on ':' and requires exactly two
// parts, `<user id>:<session key>`, where the session came from a login call. Matched here rather
// than waved through, because a simulator that accepts any shape is what let this codebase send
// `apikey:<the api key>` for months without anything noticing.
export function parseAuthFrame(raw: string): { name: string; session: string } | undefined {
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

/**
 * The printer octo-sim pretends to be: what it has been told, what it is running, and what it has
 * run. It knows nothing of HTTP or of a socket - `octoPrintServer` is the transport over it, and
 * keeping the two apart is what lets every rule here be asked directly.
 */
export class SimulatedPrinter {
  private readonly issuedSessions = new Map<string, string>();
  private readonly printHistory = new Map<string, PrintHistory>();
  private readonly uploadedFiles = new Set<string>();
  private running: string | null = null;
  private lastJob: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newSession: () => string = () => `sess-${Math.random().toString(36).slice(2)}`,
  ) {}

  // AIDEV-NOTE: the key is not checked, on login or anywhere else - this is a test double and not a
  // security boundary. What IS enforced is that a session was issued at all, which is the protocol
  // conformance a client can get wrong.
  /** Passive login: the step that yields the session key the push socket's auth frame requires. */
  logIn(): { name: string; session: string } {
    const session = this.newSession();
    this.issuedSessions.set(session, SIMULATED_USER);

    return { name: SIMULATED_USER, session };
  }

  /** Whether a push socket presenting this frame is entitled to events. Anything else is not. */
  authenticates(raw: string): boolean {
    const auth = parseAuthFrame(raw);

    return auth !== undefined && this.issuedSessions.get(auth.session) === auth.name;
  }

  /** What it is running, if anything - the one job a real machine can have on the bed. */
  busyWith(): string | null {
    return this.running;
  }

  // AIDEV-NOTE: the path the CLIENT asked for. The folder used to be decided here - one client's
  // filing scheme baked into the simulator - so a client uploading anywhere else was told its print
  // had finished under a path it had never named, and waited for an event that could not come.
  /** Take a job, answering where it was filed. Refuses a second one while the first is running. */
  take(filename: string, folder: string): string {
    if (this.running !== null) throw new Busy(`Printer is busy: ${this.running} is still printing`);

    const remotePath = folder === '' ? filename : `${folder}/${filename}`;
    this.running = remotePath;
    this.lastJob = remotePath;
    this.uploadedFiles.add(remotePath);

    return remotePath;
  }

  // AIDEV-NOTE: OctoPrint records a cancelled print as a failure, not a third outcome - so does
  // this. A client reconciling after the fact genuinely cannot tell the two apart; pretending
  // otherwise here would let a test pass that the real server would fail.
  /** The job on the bed has ended, however it ended. */
  finished(remotePath: string, type: CompletionEventType): void {
    this.running = null;
    const success = type === 'PrintDone';
    const previous = this.printHistory.get(remotePath) ?? { success: 0, failure: 0 };
    this.printHistory.set(remotePath, {
      success: previous.success + (success ? 1 : 0),
      failure: previous.failure + (success ? 0 : 1),
      last: { date: Math.floor(this.now() / 1000), printTime: 1, success },
    });
  }

  /** The bed is free again, with nothing recorded - a job handler that threw rather than finished. */
  gaveUp(): void {
    this.running = null;
  }

  /** What the shop can read back about a file, or nothing for one this printer never had. */
  filed(remotePath: string): FiledJob | undefined {
    if (!this.uploadedFiles.has(remotePath)) return undefined;

    const prints = this.printHistory.get(remotePath);

    return {
      name: remotePath.split('/').pop() ?? remotePath,
      path: remotePath,
      type: 'machinecode',
      // Real OctoPrint leaves `prints` out entirely for a file it has never printed.
      ...(prints ? { prints } : {}),
    };
  }

  // AIDEV-NOTE: the shape real OctoPrint pushes as `history` (once, on connect, to bring a fresh
  // client up to date) and `current` (as things change). `state.text` is here for faithfulness
  // only - it is documented as human-readable, and a client that decides anything from it rather
  // than from the flags is the bug this payload exists to catch.
  //
  // AIDEV-NOTE: `job.file.path` goes on naming the last job after it ends, as OctoPrint does -
  // `state.flags` is the only thing that says whether it is still running. Clearing it to null on
  // completion (as this server used to) made the path harmless to ignore, which let a client that
  // reads the wrong field look correct here and fail against a real printer.
  /** What this printer says about itself, in the shape a push socket carries. */
  statusPayload(): unknown {
    return {
      state: {
        text: this.running === null ? 'Operational' : 'Printing',
        flags: {
          operational: true,
          printing: this.running !== null,
          paused: false,
          pausing: false,
          cancelling: false,
          sdReady: false,
          error: false,
          ready: this.running === null,
          closedOrError: false,
        },
      },
      job: { file: { path: this.lastJob } },
      progress: { completion: this.running === null ? null : 0, printTimeLeft: null },
      logs: [],
    };
  }
}
