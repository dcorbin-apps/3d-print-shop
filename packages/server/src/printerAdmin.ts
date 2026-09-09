import type { BuildVolume } from './Job.js';
import type { PrinterApi } from './Printer.js';
import type { Shop } from '@3d-print-shop/client';

export class UnreadableVolume extends Error {}

// AIDEV-NOTE: the operator's half of the shop, kept apart from the command line that calls it.
// Everything here answers with LINES rather than printing, so it can be tested without a process
// and so that whatever reaches it later - a GUI - is not stuck behind stdout.
//
// It goes through the API like every other client. It used to write the spool directly, which made
// the command line a second writer over files the service was writing at the same time.

// The shop answers before it stops, so this reports what it agreed to do rather than what it did.
export async function shutDownShop(shop: Shop): Promise<string[]> {
  await shop.shutDown();

  return ['the shop is stopping'];
}

export function parseBuildVolume(text: string): BuildVolume {
  const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) {
    throw new UnreadableVolume(`cannot read "${text}" as a build volume - expected <width>x<depth>x<height> in mm`);
  }

  return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

export async function addPrinter(shop: Shop, name: string, volume: string, address: string, api: PrinterApi): Promise<string[]> {
  const buildVolume = parseBuildVolume(volume);
  const { created } = await shop.addPrinter({ name, buildVolume, api, address });

  // Said out loud, because adding a printer that is already here silently replaces what the shop
  // knew about it, and an operator correcting a typo in a name would otherwise think they had.
  return [created ? `added ${name}, ${volume}mm ${api} at ${address}` : `${name} is now a ${volume}mm ${api} at ${address}`];
}

export async function removePrinter(shop: Shop, name: string): Promise<string[]> {
  await shop.removePrinter(name);

  return [`removed ${name}`];
}

export async function listPrinters(shop: Shop): Promise<string[]> {
  const printers = await shop.printers();
  if (printers.length === 0) {
    return ['no printers - add one before anything can be printed'];
  }

  return printers.map((printer) => {
    const { x, y, z } = printer.buildVolume;
    const loaded = printer.loaded.length > 0 ? printer.loaded.join(', ') : 'nothing loaded';
    const doing = printer.holding ? `${printer.holding.phase} job ${printer.holding.job}` : 'idle';
    const stopped = printer.paused ? `  STOPPED: ${printer.paused.reason}` : '';
    // Said even though nobody has to act on it: an operator looking at a machine that is taking no
    // work is owed the reason, and "the shop cannot get to it" is a different thing to go and look
    // at than "somebody stopped it".
    const outOfReach = printer.unreachable ? `  UNREACHABLE: ${printer.unreachable.reason}` : '';
    // The one the shop writes that waits for a person, so it has to read like something to go and
    // deal with rather than like something the shop is still working on.
    const refused = printer.refused ? `  REFUSED: ${printer.refused.reason}` : '';

    return `${printer.name}  ${x}x${y}x${z}mm  ${printer.address}  ${loaded}  ${doing}${stopped}${outOfReach}${refused}`;
  });
}

// AIDEV-NOTE: the operator's word for it, because the printers here do not report their own
// filament - SpoolManager existed once and is gone. Nothing may be designed on the assumption that
// a machine can answer this.
export async function loadFilament(shop: Shop, name: string, filaments: string[]): Promise<string[]> {
  const printer = await shop.load(name, filaments);

  return [filaments.length === 0 ? `${name} has nothing loaded` : `${printer.name} has ${filaments.join(', ')} loaded`];
}

export async function pausePrinter(shop: Shop, name: string, reason: string): Promise<string[]> {
  await shop.pause(name, reason);

  return [`${name} stopped: ${reason}`];
}

// AIDEV-NOTE: the shop stops a printer by itself when an upload fails, and nothing but this starts
// it again. Without it a shop that lost its printer for a moment stays stopped for good.
export async function resumePrinter(shop: Shop, name: string): Promise<string[]> {
  // Read before it is changed, because what stopped it is the useful half of the answer and is gone
  // the moment it starts again.
  const was = (await shop.printers()).find((printer) => printer.name === name);
  const trouble = was?.paused ?? was?.refused ?? was?.unreachable;

  const printer = await shop.resume(name);

  return [trouble ? `${printer.name} running again, after ${trouble.reason}` : `${printer.name} was not stopped`];
}
