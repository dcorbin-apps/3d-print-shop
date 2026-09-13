import { describe, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';

// AIDEV-NOTE: two things node does that the shop is built on, and neither is the shop's to prove.
// They are here rather than in an acceptance test because that is what they are: facts about the
// runtime, which cannot change because somebody edited this repository.
//
// What the shop DOES about them - which signals it answers, what each one does, and what stopping
// lets go of in what order - is tests/signals.test.ts and tests/running.test.ts, where it can be
// asked without a process at all.
describe('what node does with a signal', () => {
  const nodeDoing = (script: string, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
    new Promise((ended, failed) => {
      const child = spawn('node', ['-e', script]);
      child.on('error', failed);
      child.on('close', (code, by) => ended({ code, signal: by }));
      // Sent once the script has said it is ready, so the handler is registered before it arrives.
      child.stdout.once('data', () => child.kill(signal));
    });

  // AIDEV-NOTE: the whole reason the shop registers a SIGHUP handler at all. A shop under a terminal
  // that closed used to DIE where it now re-reads its credentials - and nothing in the shop's own
  // code says so, because the behaviour being avoided is node's default.
  it('ends a process that has no handler for SIGHUP', async () => {
    const waiting = "console.log('ready'); setInterval(() => {}, 1000);";

    expect(await nodeDoing(waiting, 'SIGHUP')).toMatchObject({ signal: 'SIGHUP' });
  });

  it('leaves a process that has one running, to answer it in its own time', async () => {
    const answering = "process.on('SIGHUP', () => { console.error('heard'); process.exit(7); }); console.log('ready'); setInterval(() => {}, 1000);";

    expect(await nodeDoing(answering, 'SIGHUP')).toMatchObject({ code: 7 });
  });

  // AIDEV-NOTE: what makes `stopTheShop` enough. Nothing is killed - the listener is closed, the
  // timers are cleared and the sockets let go, and node ends the process because there is then
  // nothing left holding the loop open.
  it('ends a process once nothing is left holding the event loop open', async () => {
    const letting = "const t = setInterval(() => {}, 1000); console.log('ready'); setTimeout(() => clearInterval(t), 50);";

    await expect(
      new Promise<number | null>((ended, failed) => {
        const child = spawn('node', ['-e', letting]);
        child.on('error', failed);
        child.on('close', (code) => ended(code));
      })
    ).resolves.toBe(0);
  });
});
