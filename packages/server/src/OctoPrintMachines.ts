import { OctoPrint } from './OctoPrint.js';
import type { Machines } from './Foreman.js';
import type { Printer } from './printing.js';
import type { RegisteredPrinter } from './Printer.js';

// AIDEV-NOTE: a key belongs in neither of a printer's files. `printer add` would put it in shell
// history and in `ps`, and the spool is the shop's working directory rather than a credential store
// - so it is named after the printer and read from the environment, the way the spool root is.
export function apiKeyVariableFor(printerName: string): string {
  return `PRINT_SHOP_KEY_${printerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/**
 * Turns a registration into something that can actually be talked to.
 *
 * One client per printer, kept: `awaitOutcome` resolves on the socket the client holds open, so a
 * watcher handed a fresh client would wait on a machine nobody was listening to. The client is also
 * connected here rather than on first send, because after a restart the first thing that happens to
 * a printer already printing is being watched, and nothing will have sent it anything.
 */
export class OctoPrintMachines {
  private readonly reached = new Map<string, { address: string; machine: OctoPrint }>();

  readonly reach: Machines = async (printer: RegisteredPrinter): Promise<Printer> => {
    const already = this.reached.get(printer.name);
    if (already?.address === printer.address) return already.machine;

    // The operator moved it. The old client is talking to the wrong machine.
    already?.machine.disconnect();

    const machine = new OctoPrint({ baseUrl: printer.address, apiKey: apiKeyFor(printer.name) });
    await machine.connect();
    this.reached.set(printer.name, { address: printer.address, machine });

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
}

function apiKeyFor(printerName: string): string {
  const variable = apiKeyVariableFor(printerName);
  const key = process.env[variable];
  if (key === undefined || key.trim() === '') {
    throw new Error(`no API key for ${printerName} - the shop reads it from ${variable}`);
  }

  return key;
}
