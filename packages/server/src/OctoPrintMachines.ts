import { OctoPrint } from './OctoPrint.js';
import { PRINTER_KEYS_FILE } from './credentials.js';
import type { Machines } from './Foreman.js';
import type { Printer } from './printing.js';
import type { RegisteredPrinter } from './Printer.js';


/**
 * Turns a registration into something that can actually be talked to.
 *
 * One client per printer, kept: `awaitOutcome` resolves on the socket the client holds open, so a
 * watcher handed a fresh client would wait on a machine nobody was listening to. The client is also
 * connected here rather than on first send, because after a restart the first thing that happens to
 * a printer already printing is being watched, and nothing will have sent it anything.
 */
export class OctoPrintMachines {
  private readonly reached = new Map<string, { address: string; key: string; machine: OctoPrint }>();

  // AIDEV-NOTE: a key belongs in neither of a printer's files. `printer add` would put it in shell
  // history and in `ps`, and the spool is the shop's working directory rather than a credential
  // store - so it is read from a file only its owner can read, and keyed by the printer's own name.
  // It was an environment variable until that had to go into a launchd plist, which is world
  // readable; see design/3d-print-shop.md.
  //
  // AIDEV-NOTE: asked afresh rather than handed over once, because the shop re-reads its keys on
  // SIGHUP - and a key read at startup is the one an operator is correcting.
  constructor(private readonly keys: () => ReadonlyMap<string, string> = () => new Map()) {}

  // AIDEV-NOTE: a key that has changed is compared here and nowhere else, which is what makes
  // correcting one safe while prints are running. Replacing a client DISCONNECTS it, and a watcher
  // is waiting on the socket the old one holds - but this is called only to START a print and to
  // pick one up to watch, and a printer that is holding something is never started on. So the swap
  // waits for the machine to be idle without anything here knowing what is being watched.
  readonly reach: Machines = async (printer: RegisteredPrinter): Promise<Printer> => {
    const key = this.keyFor(printer.name);
    const already = this.reached.get(printer.name);
    if (already?.address === printer.address && already.key === key) return already.machine;

    // The operator moved it, or corrected its key. The old client is talking to the wrong machine,
    // or talking to the right one with a key it will not accept.
    already?.machine.disconnect();

    const machine = new OctoPrint({ baseUrl: printer.address, apiKey: key });
    await machine.connect();
    this.reached.set(printer.name, { address: printer.address, key, machine });

    return machine;
  };

  /**
   * Let go of every machine. A client left connected reconnects for as long as the process lives -
   * by design, since an in-flight print has no other way to report its outcome - so nothing here
   * stops on its own.
   */
  closeAll(): void {
    for (const { machine } of this.reached.values()) machine.disconnect();

    this.reached.clear();
  }

  private keyFor(printerName: string): string {
    const key = this.keys().get(printerName);
    if (key === undefined || key.trim() === '') {
      throw new Error(`no API key for ${printerName} - the shop reads it from ${PRINTER_KEYS_FILE}, keyed by the printer's name`);
    }

    return key;
  }
}
