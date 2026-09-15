import type { Job, RegisteredPrinter } from '@3d-print-shop/client/browser';

// AIDEV-NOTE: the shop has no shop-level status to ask for - `printers()` is the closest thing it
// has, and a fault that touches every machine at once has nowhere to be reported. So this is
// DERIVED from what the shop does answer, and it says only what those answers actually support.
// When the shop can say how IT is, this is where that belongs. See PLAN.md.

/** What a machine is doing, in one word an operator can read across a room. */
export type PrinterCondition =
  'printing' | 'awaiting-approval' | 'stopped' | 'unavailable' | 'unreachable' | 'refused' | 'out-of-contact' | 'unreadable' | 'idle';

/** What is wrong, when something is - the reason a person was given or the shop found. */
export interface PrinterState {
  condition: PrinterCondition;
  why?: string;
}

// AIDEV-NOTE: the order is the order an operator has to act in, and it is not the order the fields
// are declared in. A stopped printer that is also holding a print is STOPPED - somebody said so
// about the room, and no machine can contradict that - where a bed waiting to be cleared beats a
// machine nobody can reach, because clearing it is the thing a person can actually do.
export function stateOf(printer: RegisteredPrinter): PrinterState {
  // First of all of them: a machine whose own files the shop cannot read is one where nothing else it
  // says about that machine is worth reading either.
  if (printer.unreadable) return { condition: 'unreadable', why: printer.unreadable.reason };
  if (printer.paused) return { condition: 'stopped', why: printer.paused.reason };
  if (printer.refused) return { condition: 'refused', why: printer.refused.reason };
  if (printer.holding?.phase === 'awaiting-approval') return { condition: 'awaiting-approval' };
  // The machine's own no, above the shop's reading of it: a printer answering http perfectly well
  // and saying its hardware is down is not unreachable, and calling it that sends somebody looking
  // at the network. Below awaiting-approval, because a bed with a print on it still wants clearing
  // whatever the machine thinks of itself, and that is a thing a person can actually go and do.
  if (printer.unavailable) return { condition: 'unavailable', why: printer.unavailable.reason };
  if (printer.unreachable) return { condition: 'unreachable', why: printer.unreachable.reason };
  if (printer.outOfContact) return { condition: 'out-of-contact', why: printer.outOfContact.reason };
  if (printer.holding) return { condition: 'printing' };

  return { condition: 'idle' };
}

/** What the whole shop is doing, counted rather than judged - the shop itself says nothing yet. */
export interface ShopSummary {
  printers: number;
  printing: number;
  needingSomebody: number;
  queued: number;
  awaitingApproval: number;
}

// AIDEV-NOTE: "needing somebody" is the only number here that is a judgement, and it is the one an
// operator is looking for: a machine nobody has to touch does not belong in it. A print waiting for
// a verdict is somebody's to give; a machine out of contact is not, because the shop is already
// listening again and nothing a person does makes it answer sooner.
export function summarise(printers: RegisteredPrinter[], jobs: Job[]): ShopSummary {
  const states = printers.map(stateOf);

  return {
    printers: printers.length,
    printing: states.filter((state) => state.condition === 'printing').length,
    needingSomebody: states.filter(
      ({ condition }) => condition === 'stopped' || condition === 'refused' || condition === 'awaiting-approval' || condition === 'unavailable',
    ).length,
    queued: jobs.filter((job) => job.state === 'queued').length,
    awaitingApproval: jobs.filter((job) => job.state === 'awaiting-approval').length,
  };
}
