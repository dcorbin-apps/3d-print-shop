import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { OctoPrintMachines } from '../src/OctoPrintMachines';
import type { Machine, MakeMachine } from '../src/OctoPrintMachines';
import type { OctoPrintConfig } from '../src/OctoPrint';
import type { PrinterOutcome } from '../src/Job';
import type { RegisteredPrinter } from '../src/Printer';

// AIDEV-NOTE: the whole of octoPrintMachines' acceptance suite said again with the machine handed
// over rather than built - written to find out what a unit test of this class CAN say. It is kept
// beside the acceptance suite rather than in place of it; what each catches and what only one of
// them catches is recorded in PLAN.md.
describe('reaching a printer', () => {
  let made: { config: OctoPrintConfig; machine: Machine }[];
  let keys: Map<string, string>;
  let machines: OctoPrintMachines;

  const mk4: RegisteredPrinter = {
    name: 'mk4',
    buildVolume: { x: 250, y: 210, z: 220 },
    api: 'octoprint',
    address: 'http://octopi.local',
    camera: 'http://octopi.local/webcam/?action=stream',
    loaded: [],
  };

  const at = (address: string): RegisteredPrinter => ({ ...mk4, address });
  const named = (name: string): RegisteredPrinter => ({ ...mk4, name });

  // A machine that opens nothing. `awaitOutcome` is a promise nobody settles unless `disconnect`
  // does, which is how the fake stands in for a socket being let go of.
  function aMachine(): Machine {
    let giveUp: ((why: Error) => void) | undefined;

    return {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      disconnect: jest.fn<() => void>(() => giveUp?.(new Error('closed'))),
      send: jest.fn<(remotePath: string, gcode: never) => Promise<string>>().mockResolvedValue('plates/job-1.gcode'),
      awaitOutcome: jest.fn<(remotePath: string) => Promise<PrinterOutcome>>(
        () => new Promise<PrinterOutcome>((_settled, failed) => (giveUp = failed))
      ),
    };
  }

  const connectsOf = (machine: Machine): jest.Mock<() => Promise<void>> => machine.connect as jest.Mock<() => Promise<void>>;
  const disconnectsOf = (machine: Machine): jest.Mock<() => void> => machine.disconnect as jest.Mock<() => void>;

  beforeEach(() => {
    made = [];
    keys = new Map([['mk4', 'a-key']]);

    const makeMachine: MakeMachine = (config) => {
      const machine = aMachine();
      made.push({ config, machine });

      return machine;
    };

    machines = new OctoPrintMachines(() => keys, makeMachine);
  });

  // After a restart the first thing that happens to a printer already printing is being WATCHED, and
  // nothing sends it anything - so a client connected lazily on first send never connects.
  it('opens the connection before anything is sent', async () => {
    await machines.reach(mk4);

    expect(made).toHaveLength(1);
    expect(connectsOf(made[0].machine)).toHaveBeenCalledTimes(1);
  });

  // awaitOutcome resolves on the socket its own client holds open, so a watcher handed a fresh
  // client would wait on a machine nobody was listening to.
  it('answers with the same client for the same printer', async () => {
    const first = await machines.reach(mk4);

    expect(await machines.reach(mk4)).toBe(first);
    expect(made).toHaveLength(1);
  });

  // The operator moved the machine. The old client is talking to the wrong address.
  it('answers with a new client when the printer has moved', async () => {
    const first = await machines.reach(mk4);

    expect(await machines.reach(at('http://moved.local'))).not.toBe(first);
    expect(made.map(({ config }) => config.baseUrl)).toEqual(['http://octopi.local', 'http://moved.local']);
  });

  it('lets go of the client it is replacing', async () => {
    await machines.reach(mk4);
    await machines.reach(at('http://moved.local'));

    expect(disconnectsOf(made[0].machine)).toHaveBeenCalledTimes(1);
  });

  it('lets go of every machine when the shop closes', async () => {
    const machine = await machines.reach(mk4);
    const waiting = machine.awaitOutcome('plates/job-1.gcode');

    machines.closeAll();

    await expect(waiting).rejects.toThrow('closed');
  });

  it('reaches a new client once it has let go of the old one', async () => {
    const first = await machines.reach(mk4);
    machines.closeAll();

    expect(await machines.reach(mk4)).not.toBe(first);
  });

  // The operator corrected a key that was wrong. The old client is talking to the right machine with
  // a key it will not accept, and nothing else in the shop would ever notice.
  it('answers with a new client carrying a key that has been corrected', async () => {
    const first = await machines.reach(mk4);
    keys.set('mk4', 'a-corrected-key');

    expect(await machines.reach(mk4)).not.toBe(first);
    expect(made.map(({ config }) => config.apiKey)).toEqual(['a-key', 'a-corrected-key']);
  });

  // An empty variable is a machine somebody meant to configure and did not, which is worth the same
  // message as one nobody set at all.
  it.each([['  '], ['']])('refuses a printer whose key is %j', async (key) => {
    keys.set('mk4', key);

    await expect(machines.reach(mk4)).rejects.toThrow('no API key for mk4');
  });

  it('makes no machine for a printer it has no key for', async () => {
    keys.delete('mk4');

    await expect(machines.reach(mk4)).rejects.toThrow();
    expect(made).toEqual([]);
  });

  // Named rather than numbered, so an operator is told which file to put it in and under what.
  it('refuses a printer nobody has given a key, saying where one goes', async () => {
    await expect(machines.reach(named('mini'))).rejects.toThrow(
      "no API key for mini - the shop reads it from printer-keys.json, keyed by the printer's name"
    );
  });
});
