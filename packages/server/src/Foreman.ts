import type { JobStore } from './JobStore.js';
import { silent } from './log.js';
import type { Log } from './log.js';
import type { Printer } from './printing.js';
import { recordOutcome, startNextPrint } from './printing.js';
import type { RegisteredPrinter } from './Printer.js';

/** How a registration becomes something that can actually be talked to. */
export type Machines = (printer: RegisteredPrinter) => Promise<Printer>;

// AIDEV-NOTE: what tells "I could not get to that machine" apart from everything else that can go
// wrong while starting a print. Only this stops a printer, because only this is about the printer:
// a store or spool fault is the shop's own, and stopping a machine over one puts a person in front
// of a message that names the wrong thing.
/** The machine could not be got to at all - nothing listening, no key, a login it would not grant. */
export class CouldNotReach extends Error {}

/** How often the shop reaches for the machines it could not get to. Each printer waits its own turn. */
export const RETRY_TICK_MS = 30_000;

const FIRST_RETRY_MS = 30_000;
const LONGEST_RETRY_MS = 10 * 60_000;

// AIDEV-NOTE: what decides that now is a moment to start something. It is called after EVERY change
// the shop makes rather than from the handful of places that obviously matter - a curated list of
// triggers is a list somebody forgets to add to, and a missed wake-up is a job that sits for ever.
// The cost of a wasted look is one directory scan.
//
// The moments that do matter, for the record: a job submitted, a verdict given, filament loaded, a
// printer resumed or added, and starting up. Every one of them is a change.
export class Foreman {
  // AIDEV-NOTE: serialised because two overlapping looks would both find the same printer free and
  // both start something on it. The store would refuse the second, but the job would already have
  // been sent to the machine twice.
  private looking: Promise<unknown> = Promise.resolve();

  // One watcher per printer, so a second look while a print is running does not start a second one
  // waiting on the same path.
  private readonly watching = new Map<string, Promise<void>>();

  private stopping = false;

  // AIDEV-NOTE: how long each unreachable printer waits before the next try, in memory and
  // deliberately not written down. A restart is a fine moment to try a machine again - one login
  // is worth less than remembering how the last attempt went.
  private readonly waiting = new Map<string, { attempt: number; until: number }>();

  private retrying: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly shop: JobStore,
    private readonly machines: Machines,
    private readonly log: Log = silent,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * The shop is closing. Nothing more is started, and a watcher that loses its print on the way out
   * is not a fault - disconnecting the machines is what took it, and the print is still on the bed
   * for the next run to pick up.
   */
  stop(): void {
    this.stopping = true;
  }

  /** Settles when nothing is watching any more, so a caller can wait for the shop to go quiet. */
  async watchersSettled(): Promise<void> {
    await Promise.allSettled([...this.watching.values()]);
  }

  /** Start something on every printer that is free to take it. */
  considerStarting(): Promise<void> {
    if (this.stopping) return Promise.resolve();

    const look = this.looking.then(
      () => this.startWhatCanBeStarted(),
      () => this.startWhatCanBeStarted()
    );
    this.looking = look.catch(() => undefined);

    return look;
  }

  /**
   * Reach for the machines the shop could not get to, and let go of the fact for any that answer.
   *
   * Driven by a clock rather than by a change, because a printer nobody can reach makes none - and
   * everything that ends one of these is outside the shop: a machine switched on, a key corrected,
   * a router fixed. None of them announces itself, so trying is the only way to find out.
   */
  retryUnreachable(): Promise<void> {
    if (this.stopping) return Promise.resolve();

    const retry = this.retrying.then(
      () => this.reachForWhatIsOutOfReach(),
      () => this.reachForWhatIsOutOfReach()
    );
    this.retrying = retry.catch(() => undefined);

    return retry;
  }

  /**
   * Pick up prints that were already running, and answer with the printers whose prints it took on.
   * A restart does not stop a machine, so a printer whose status says it is printing is a print
   * still worth watching - and its outcome is written down by whoever is watching, which after a
   * restart is nobody until this runs.
   */
  async resumeWatching(): Promise<string[]> {
    const picked: string[] = [];

    for (const printer of await this.shop.printers()) {
      // Only a print still running. One waiting for a verdict has already ended, and there is
      // nothing left to hear about it.
      if (printer.holding?.phase === 'printing' && this.watch(printer.name)) {
        // AIDEV-NOTE: invisible until now. A shop that came back up and picked a print back up said
        // nothing about it, so the one moment an operator would want confirmation - did it lose my
        // eight-hour print? - was the one the shop had no answer for.
        this.log.info('picked up a print already running', { printer: printer.name, job: printer.holding.job });
        picked.push(printer.name);
      }
    }

    return picked;
  }

  private async reachForWhatIsOutOfReach(): Promise<void> {
    let anyAnswered = false;

    for (const printer of await this.shop.printers()) {
      // An operator's stop is not lifted by a machine answering: it is a fact about the room, and
      // reaching the machine says nothing about it.
      if (!printer.unreachable || printer.paused) continue;
      if (this.now().getTime() < (this.waiting.get(printer.name)?.until ?? 0)) continue;

      anyAnswered = (await this.tryAgain(printer)) || anyAnswered;
    }

    if (anyAnswered) await this.considerStarting();
  }

  private async tryAgain(printer: RegisteredPrinter): Promise<boolean> {
    try {
      await this.machines(printer);
    } catch {
      this.waitBeforeTrying(printer.name, (this.waiting.get(printer.name)?.attempt ?? 1) + 1);

      return false;
    }

    this.waiting.delete(printer.name);
    await this.shop.reachedAgain(printer.name);
    this.log.info('reached the printer again', { printer: printer.name, after: printer.unreachable?.reason });

    return true;
  }

  private waitBeforeTrying(name: string, attempt: number): void {
    const wait = Math.min(FIRST_RETRY_MS * 2 ** (attempt - 1), LONGEST_RETRY_MS);

    this.waiting.set(name, { attempt, until: this.now().getTime() + wait });
  }

  private async startWhatCanBeStarted(): Promise<void> {
    for (const printer of await this.shop.printers()) {
      // Holding anything at all means the bed is not clear, verdict or no verdict.
      if (printer.paused || printer.unreachable || printer.holding) continue;

      await this.start(printer);
    }
  }

  private async start(printer: RegisteredPrinter): Promise<void> {
    try {
      const attempt = await startNextPrint(this.shop, () => this.reach(printer), printer.name);

      if (attempt.did === 'started') {
        this.log.info('started printing', {
          printer: printer.name,
          job: attempt.job.id,
          displayName: attempt.job.displayName,
          gcodeBytes: attempt.job.gcodeBytes,
        });
        this.watch(printer.name);
      }

      if (attempt.did === 'could-not-start') {
        // On the way out the send failed BECAUSE the machines were disconnected, so there is
        // nothing here an operator has to act on.
        if (this.stopping) return;

        this.log.error('could not send a job to the printer', {
          printer: printer.name,
          job: attempt.job.id,
          why: attempt.failure.message,
        });

        // AIDEV-NOTE: THIS printer stops - whatever stopped the upload will stop the next one, and
        // a fault worth one message would otherwise produce one per job held. Only this one:
        // another printer that is working has no reason to stand idle.
        await this.shop.pause(printer.name, `could not send ${attempt.remotePath} to the printer: ${attempt.failure.message}`);
      }
    } catch (failure) {
      // AIDEV-NOTE: on the way out this is expected and must not stop anything - the same rule
      // `watchToTheEnd` follows, and for the same reason: a shop that came back up with every
      // machine stopped, for a fault nobody caused, is worse than one that simply tries again.
      // An attempt already in flight when the shutdown arrives fails BECAUSE of the shutdown -
      // seen for real, as `printer stopped` written after `the shop has stopped`.
      if (this.stopping) return;

      if (!(failure instanceof CouldNotReach)) {
        // Nothing here is the machine's fault, and it is not the machine that has to be put right -
        // so the next look tries again, and a person who types `printer start` is not made to clear
        // a fault that was never about the printer.
        this.log.error('could not start anything', { printer: printer.name, why: (failure as Error).message });

        return;
      }

      // AIDEV-NOTE: a machine that cannot even be built - no key, an address nothing answers at -
      // would otherwise be tried again on every single change, one failure per change. Written down
      // so the next look leaves it alone, and NOT as a stop: nothing about the room changed, and an
      // operator asked to clear it would be confirming something they cannot see.
      this.log.error('could not reach the printer', { printer: printer.name, why: failure.message });
      await this.shop.couldNotReach(printer.name, failure.message);

      // From the start, whatever this printer's last spell out of reach cost: it was reachable a
      // moment ago, so this is a new fault rather than the continuation of an old one.
      this.waitBeforeTrying(printer.name, 1);
    }
  }

  private async reach(printer: RegisteredPrinter): Promise<Printer> {
    try {
      return await this.machines(printer);
    } catch (failure) {
      throw new CouldNotReach((failure as Error).message);
    }
  }

  // AIDEV-NOTE: deliberately not awaited. A print runs for hours and the change that prompted it -
  // an HTTP request, usually - has nothing to wait for; what the printer is holding is on disk, so
  // the watch is recoverable rather than something a caller has to keep hold of.
  //
  // Answers whether it took this one on, which is false when somebody is already watching it.
  private watch(name: string): boolean {
    if (this.watching.has(name)) return false;

    this.watching.set(
      name,
      this.watchToTheEnd(name).finally(() => this.watching.delete(name))
    );

    return true;
  }

  private async watchToTheEnd(name: string): Promise<void> {
    try {
      const printer = await this.shop.printerNamed(name);
      const outcome = await recordOutcome(this.shop, await this.machines(printer), name);

      // What the PRINTER said, which is not a verdict - the bed is still held until a person judges
      // what came off it.
      this.log.info('print ended', { printer: name, outcome });
    } catch (failure) {
      // On the way out this is expected, and stopping every printer on a shutdown would leave a
      // shop that comes back up refusing to print for a reason nobody caused.
      if (this.stopping) return;

      // Losing track leaves a job that says it is printing and a machine nobody is listening to.
      // Stopping the printer is what puts that in front of an operator instead of leaving it.
      const why = `lost track of the print on ${name}: ${(failure as Error).message}`;
      this.log.error('printer stopped', { printer: name, why });
      await this.shop.pause(name, why).catch(() => undefined);
    }
  }
}
