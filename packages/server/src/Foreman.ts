import { WrongState } from './JobStore.js';
import type { JobStore } from './JobStore.js';
import { silent } from './log.js';
import type { Log } from './log.js';
import type { Printer } from './printing.js';
import { CouldNotReach, recordOutcome, startNextPrint } from './printing.js';
import type { RegisteredPrinter } from './Printer.js';

/** How a registration becomes something that can actually be talked to. */
export type Machines = (printer: RegisteredPrinter) => Promise<Printer>;

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

  // The machines already telling this foreman how they are, so nothing is subscribed to twice.
  private readonly listeningTo = new Set<string>();

  // Work the shop has started that is not a watcher, so that `watchersSettled` can wait for it.
  private readonly alsoInFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly shop: JobStore,
    private readonly machines: Machines,
    private readonly log: Log = silent,
    private readonly now: () => Date = () => new Date(),
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
    // Settled rather than settled-once: finishing one can start another - a print picked up, a
    // machine saying it is well again - and a shutdown wants the end of all of it.
    while (this.watching.size > 0 || this.alsoInFlight.size > 0) {
      await Promise.allSettled([...this.watching.values(), ...this.alsoInFlight]);
    }
  }

  /** Keep hold of work that is not a watcher, so that going quiet waits for it too. */
  private track<T>(work: Promise<T>): Promise<T> {
    const held = work.finally(() => this.alsoInFlight.delete(held));
    this.alsoInFlight.add(held);

    return held;
  }

  /** Start something on every printer that is free to take it. */
  considerStarting(): Promise<void> {
    if (this.stopping) return Promise.resolve();

    const look = this.looking.then(
      () => this.startWhatCanBeStarted(),
      () => this.startWhatCanBeStarted(),
    );
    this.looking = look.catch(() => undefined);

    return look;
  }

  /**
   * Reach for every machine the shop has lost hold of - the ones it could not get to, and the ones
   * whose print it stopped hearing about - and let go of the fact for any that answer.
   *
   * Driven by a clock rather than by a change, because a machine nobody can hear makes none - and
   * everything that ends one of these is outside the shop: a machine switched on, a key corrected,
   * a router fixed. None of them announces itself, so asking is the only way to find out.
   */
  reachForWhatIsLost(): Promise<void> {
    if (this.stopping) return Promise.resolve();

    const retry = this.retrying.then(
      () => this.reachForEverythingLost(),
      () => this.reachForEverythingLost(),
    );
    this.retrying = retry.catch(() => undefined);

    return retry;
  }

  /**
   * An operator says go. Whatever this printer was waiting to try again, it tries now: the backoff
   * it was serving is forgotten, a print nobody is hearing is picked back up, and the queue is
   * looked at. Somebody who has just put a machine right should not wait out a wait the shop
   * decided on before they did.
   */
  async startAgain(name: string): Promise<void> {
    this.waiting.delete(name);

    // A printer that is holding a print is not started ON, so looking for work would pass it by -
    // and after an operator's go there is nothing written against it to say a watch was ever lost.
    await this.resumeWatching();
    await this.considerStarting();
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

  private async reachForEverythingLost(): Promise<void> {
    // Before anything else: a machine registered since the last tick has nobody listening to it yet.
    await this.keepInTouch();

    let anyAnswered = false;

    for (const printer of await this.shop.printers()) {
      // An operator's stop is not lifted by a machine answering: it is a fact about the room, and
      // reaching the machine says nothing about it.
      if (printer.paused) continue;
      if (this.now().getTime() < (this.waiting.get(printer.name)?.until ?? 0)) continue;

      // A print nobody is hearing about is picked back up rather than started again: the printer
      // still has its job, and listening again is what settles how it went.
      if (printer.outOfContact) this.watch(printer.name);
      else if (printer.unreachable) anyAnswered = (await this.tryAgain(printer)) || anyAnswered;
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

    // AIDEV-NOTE: the wait is NOT forgotten here. A machine can answer a login and still refuse the
    // upload that follows - a client is kept once it has connected, so the answer costs nothing to
    // give - and forgetting the wait on that would put the shop back to re-sending a whole plate
    // every thirty seconds. It is forgotten when a print actually starts.
    await this.shop.reachedAgain(printer);
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
      if (printer.unreadable || printer.paused || printer.unreachable || printer.refused || printer.holding) continue;
      // The machine itself says it cannot print. Sending anyway costs a whole plate to be told no.
      if (printer.unavailable) continue;

      await this.start(printer);
    }
  }

  private async start(printer: RegisteredPrinter): Promise<void> {
    try {
      const attempt = await startNextPrint(this.shop, () => this.reach(printer), printer.name);

      if (attempt.did === 'started') {
        // It is working. Whatever it had been waiting out is over.
        this.waiting.delete(printer.name);

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

        // The machine went away part way through rather than answering. That is the same fact as a
        // login that could not be made, and it earns the same retry: one login, not another plate.
        if (attempt.failure instanceof CouldNotReach) {
          await this.cannotGetTo(printer, attempt.failure.message);

          return;
        }

        this.log.error('could not send a job to the printer', {
          printer: printer.name,
          job: attempt.job.id,
          why: attempt.failure.message,
        });

        // AIDEV-NOTE: THIS printer takes nothing more - the machine ANSWERED, and the next plate
        // gets the same answer for another upload's cost. A fault worth one message would otherwise
        // produce one per job held. Only this one: another printer that is working has no reason to
        // stand idle.
        await this.shop.wouldNotTake(printer, `${attempt.remotePath} - ${attempt.failure.message}`);
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
      await this.cannotGetTo(printer, failure.message);
    }
  }

  private async cannotGetTo(printer: RegisteredPrinter, why: string): Promise<void> {
    const name = printer.name;
    this.log.error('could not reach the printer', { printer: name, why });
    await this.shop.couldNotReach(printer, why);

    // AIDEV-NOTE: it goes on from where this printer left off rather than starting at thirty
    // seconds. A machine can answer a login and still fail the upload that follows - the client is
    // kept once it has connected, so the answer costs it nothing - and starting over on that would
    // re-send a whole plate every thirty seconds for as long as it kept doing it. The count is
    // forgotten when a print actually starts, which is the only thing that says it works.
    this.waitBeforeTrying(name, (this.waiting.get(name)?.attempt ?? 0) + 1);
  }

  private async reach(printer: RegisteredPrinter): Promise<Printer> {
    try {
      const machine = await this.machines(printer);
      this.listenForWhatItCanDo(printer.name, machine);

      return machine;
    } catch (failure) {
      throw new CouldNotReach((failure as Error).message);
    }
  }

  // AIDEV-NOTE: subscribed once per machine and never unsubscribed - `OctoPrintMachines` hands back
  // the SAME client for an unchanged address and key, so re-subscribing on every reach would be
  // harmless and pointless, and a client it replaces is disconnected and dropped with its listener.
  private listenForWhatItCanDo(name: string, machine: Printer): void {
    if (this.listeningTo.has(name)) return;

    // Recorded on REACHING rather than on subscribing, because what this answers for `keepInTouch`
    // is "is there a line open to this machine" - and a machine that cannot say how it is still has
    // one. Keyed on the subscribe instead, a printer that never tells would be reached every tick.
    this.listeningTo.add(name);
    machine.saysWhatItCanDo?.((canPrint, why) => {
      // AIDEV-NOTE: a machine says how it is whenever it likes, including while the shop is on its
      // way out - so this is TRACKED rather than merely started. `watchersSettled` is what a shutdown
      // waits on, and an untracked write here is the shop writing to a store after it has said it
      // went quiet. It showed up as ENOTEMPTY in a test whose teardown removed the data directory
      // underneath one, which is the same fault wearing a smaller hat.
      if (this.stopping) return;

      this.track(this.writeDownWhatItSaid(name, canPrint, why)).catch((failure: unknown) =>
        this.log.error('could not write down what a printer said about itself', { printer: name, why: (failure as Error).message }),
      );
    });
  }

  private async writeDownWhatItSaid(name: string, canPrint: boolean, why: string): Promise<void> {
    const printer = await this.shop.printerNamed(name);

    if (canPrint) {
      await this.shop.saidItCanPrint(printer);
      this.log.info('a printer says it can print again', { printer: name, after: printer.unavailable?.reason });

      // It just became somewhere a plate could go, and nothing else will notice.
      await this.considerStarting();

      return;
    }

    await this.shop.saidItCannotPrint(printer, why);
    this.log.info('a printer says it cannot print', { printer: name, why });
  }

  // AIDEV-NOTE: EAGER, and the note in printing.ts about reaching a machine only when there is
  // something to print no longer holds: a machine that is only reached when work arrives is one
  // whose own state the shop cannot know until it is too late to act on it. What that note was
  // guarding against is a connection per idle printer, which is the cost now being paid on purpose -
  // it buys a shop that knows a printer went offline before it picks one to print on.
  // AIDEV-NOTE: the job is deliberately NOT let go of here, and the bed is not cleared. Cancelling
  // says stop; what happened then is the machine's to report, and it reports it the way every other
  // ending is reported - a PrintCancelled event the watcher is already waiting on, which writes the
  // outcome down and leaves the job where a finished one goes. Anything else here would be the shop
  // deciding what came off a bed it cannot see.
  /** Tell a printer to stop what it is printing. What the bed is owed afterwards is a verdict. */
  async cancelPrintOn(name: string): Promise<void> {
    const printer = await this.shop.printerNamed(name);
    const machine = await this.reach(printer);

    if (machine.cancel === undefined) throw new WrongState(`${name} cannot be told to stop`);

    await machine.cancel();
  }

  /** Open a line to every machine the shop has, so that each can say how it is. */
  async keepInTouch(): Promise<void> {
    for (const printer of await this.shop.printers()) {
      if (this.listeningTo.has(printer.name)) continue;

      // AIDEV-NOTE: everything already in trouble is somebody else's to reach. An operator's stop is
      // about the room; a refusal waits for a person and must NOT be retried on a clock; and a
      // machine that is unreachable or out of contact belongs to the retry path below, which owns
      // the backoff. Reaching them here would hammer a machine the shop has agreed to leave alone,
      // which is what it did when this was written without these clauses.
      if (printer.paused || printer.refused || printer.unreadable) continue;
      if (printer.unreachable || printer.outOfContact) continue;
      if (this.now().getTime() < (this.waiting.get(printer.name)?.until ?? 0)) continue;

      // A machine that will not answer is not written down as anything here - being unable to open a
      // line before there is work is not a fault worth reporting, and the start path says so
      // properly when it matters. What it does earn is the same wait as any other failed reach.
      await this.reach(printer).catch(() => this.waitBeforeTrying(printer.name, (this.waiting.get(printer.name)?.attempt ?? 0) + 1));
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
      this.watchToTheEnd(name).finally(() => this.watching.delete(name)),
    );

    return true;
  }

  private async watchToTheEnd(name: string): Promise<void> {
    try {
      const printer = await this.shop.printerNamed(name);
      const machine = await this.machines(printer);

      // AIDEV-NOTE: having the machine in hand IS contact. What it makes of the print comes after,
      // from the adapter's own reconciliation, and waiting for that to call it contact would leave
      // the shop saying it cannot hear a machine it is already talking to.
      //
      // The wait IS forgotten here, unlike a machine that could not be reached: a silence after
      // contact is a new silence, and losing a watch again costs one login rather than a plate - so
      // starting the waiting over cannot run away, and the adapter's own ten minutes bounds it.
      if (printer.outOfContact) {
        this.waiting.delete(name);
        await this.shop.inContactAgain(printer);
        this.log.info('hearing the printer again', { printer: name, after: printer.outOfContact.reason });
      }

      const outcome = await recordOutcome(this.shop, machine, name);

      // What the PRINTER said, which is not a verdict - the bed is still held until a person judges
      // what came off it.
      this.log.info('print ended', { printer: name, outcome });
    } catch (failure) {
      // On the way out this is expected, and stopping every printer on a shutdown would leave a
      // shop that comes back up refusing to print for a reason nobody caused.
      if (this.stopping) return;

      // AIDEV-NOTE: NOT a stop. The machine is very likely still printing, the printer keeps its
      // job, and nothing is idled that the print was not idling already - so there is nothing for a
      // person to do and nothing for them to confirm. It is written down, and listened for again.
      const why = (failure as Error).message;
      this.log.error('lost track of the print', { printer: name, why });
      this.waitBeforeTrying(name, (this.waiting.get(name)?.attempt ?? 0) + 1);
      // Resolved again rather than kept from above, because what failed may be the lookup itself -
      // and a printer that has since been taken out of the shop has nothing left to write this on.
      await this.shop
        .printerNamed(name)
        .then((printer) => this.shop.lostContact(printer, why))
        .catch(() => undefined);
    }
  }
}
