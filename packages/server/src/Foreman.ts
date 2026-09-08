import type { JobStore } from './JobStore.js';
import { silent } from './log.js';
import type { Log } from './log.js';
import type { Printer } from './printing.js';
import { recordOutcome, startNextPrint } from './printing.js';
import type { RegisteredPrinter } from './Printer.js';

/** How a registration becomes something that can actually be talked to. */
export type Machines = (printer: RegisteredPrinter) => Promise<Printer>;

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

  constructor(
    private readonly shop: JobStore,
    private readonly machines: Machines,
    private readonly log: Log = silent
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

  private async startWhatCanBeStarted(): Promise<void> {
    for (const printer of await this.shop.printers()) {
      // Holding anything at all means the bed is not clear, verdict or no verdict.
      if (printer.paused || printer.holding) continue;

      await this.start(printer);
    }
  }

  private async start(printer: RegisteredPrinter): Promise<void> {
    try {
      const attempt = await startNextPrint(this.shop, () => this.machines(printer), printer.name);

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
        this.log.error('could not send a job to the printer', {
          printer: printer.name,
          job: attempt.job.id,
          why: attempt.failure.message,
        });
      }
    } catch (failure) {
      // AIDEV-NOTE: on the way out this is expected and must not stop anything - the same rule
      // `watchToTheEnd` follows, and for the same reason: a shop that came back up with every
      // machine stopped, for a fault nobody caused, is worse than one that simply tries again.
      // An attempt already in flight when the shutdown arrives fails BECAUSE of the shutdown -
      // seen for real, as `printer stopped` written after `the shop has stopped`.
      if (this.stopping) return;

      // AIDEV-NOTE: a machine that cannot even be built - no key, an address nothing answers at -
      // would otherwise be tried again on every single change, one failure per change. It stops for
      // the same reason a failed upload stops it: the next attempt will fail the same way.
      const why = `could not start anything on ${printer.name}: ${(failure as Error).message}`;
      this.log.error('printer stopped', { printer: printer.name, why });
      await this.shop.pause(printer.name, why);
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
