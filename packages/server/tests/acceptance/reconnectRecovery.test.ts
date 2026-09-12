import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { startOctoPrintServer } from '@3d-print-shop/octoprint-sim';
import type { JobSubmittedHandler, OctoPrintServer } from '@3d-print-shop/octoprint-sim';
import { JobStore } from '../../src/JobStore';
import { OctoPrint } from '../../src/OctoPrint';
import { recordOutcome, startNextPrint } from '../../src/printing';
import type { Printer } from '../../src/printing';
import type { PrinterOutcome } from '../../src/Job';
import { aDataDirectory, parentOf } from '../aDataDirectory';
import type { DataLayout } from '../../src/dataLayout';

// AIDEV-NOTE: real sockets against a real OctoPrint stand-in on an ephemeral port - no mocks. The
// unit tests in OctoPrint.test.ts drive reconnect recovery through a fake WebSocket, which can only
// prove the client behaves as its author imagined the protocol works. This proves the protocol
// itself: a socket that really dies, a print that really finishes while nobody is listening, and a
// shop that has to learn the outcome from what the server actually serves on reconnect.
describe('recovering a print outcome across a dropped connection', () => {
  let server: OctoPrintServer | undefined;
  let where: DataLayout;
  let shop: JobStore;
  let machine: OctoPrint | undefined;

  // The real backoff starts at 500ms; nothing here tests how long it waits. What matters is only
  // which side of the reconnect a print ends on.
  const RECONNECT_DELAY_MS = 80;

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // AIDEV-NOTE: a print that has to end AFTER the client is back used to wait four reconnect delays
  // and assume. That is a race dressed as a wait: the assumption is real wall time on a machine
  // running four jest projects at once, and when it missed, the event fired at nobody and the test
  // failed sixty seconds later having proved nothing. This waits for the thing it was assuming.
  //
  // BOTH conditions, because they are a round trip apart. A socket is counted when it is accepted
  // and only becomes a listener once it has presented its session - so `listening()` alone would
  // still read 1 in the instant after `dropConnections()`, before the close has been processed, and
  // the wait would fall straight through.
  async function whenListeningAgain(acceptedBefore: number): Promise<void> {
    const giveUpAt = Date.now() + 30_000;

    while (server!.connectionsAccepted() <= acceptedBefore || server!.listening() === 0) {
      if (Date.now() > giveUpAt) {
        throw new Error(
          `the client never came back: ${server!.connectionsAccepted()} accepted (was ${acceptedBefore}), ${server!.listening()} listening`,
        );
      }
      await delay(5);
    }
  }

  // Starting a print and hearing how it ended are two calls now; every test here is about the
  // second one, so they go together.
  async function printThrough(machine: Printer): Promise<PrinterOutcome> {
    await startNextPrint(shop, async () => machine, 'mk4');

    return recordOutcome(shop, machine, 'mk4');
  }

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-reconnect-');
    shop = new JobStore(where);
    await shop.addPrinter({ name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4' });
    await shop.load('mk4', ['PLA']);
  });

  // AIDEV-NOTE: the client must be disconnected even when a test fails. Left connected it
  // reconnects forever - by design, since an in-flight print has no other way to learn its outcome -
  // and those timers keep the event loop alive so jest never exits. One failing assertion would
  // otherwise hang the whole suite.
  afterEach(async () => {
    machine?.disconnect();
    machine = undefined;
    await server?.close();
    server = undefined;
    await rm(parentOf(where), { recursive: true, force: true });
  });

  function connectedTo(port: number): OctoPrint {
    machine = new OctoPrint({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'acceptance-key' }, undefined, undefined, () =>
      delay(RECONNECT_DELAY_MS),
    );
    return machine;
  }

  const DAVE = 'u-dave';

  async function submit(displayName = 'tray'): Promise<number> {
    const job = await shop.submit({ filaments: ['PLA'], displayName }, Readable.from(['G1 X0 Y0\n']), DAVE);
    return job.id;
  }

  // AIDEV-NOTE: 60s on every test here, where jest's default is 5. Nothing in this file WANTS more
  // than a second - what it buys is room for the whole suite running in parallel, where a worker
  // holding real sockets can stall on a loaded machine. At the default this file failed about one
  // full-suite run in six while passing 15 of 15 on its own: a busy machine, not a slow shop.
  //
  // Raised from 30s when the shop learned passwords. scrypt is memory-hard ON PURPOSE - 32MB and
  // ~50ms a time - and the suites that exercise it run in parallel with this one, so the machine
  // this waits on is busier than it was. Two full runs in four failed at 30s; none in eight at 60.
  // The number is a contention budget and nothing else, which is why it is allowed to grow.
  it('learns an outcome that was announced while the socket was down', async () => {
    // The completion event fires with no socket attached to hear it, exactly as OctoPrint would -
    // it pushes events forward and replays nothing to a client that reconnects later. No delay:
    // dropConnections() empties the subscriber set synchronously, so the event that follows is
    // broadcast to nobody, and the client is still 80ms from returning.
    const handler: JobSubmittedHandler = (_job, complete) => {
      server!.dropConnections();
      complete('PrintDone');
    };
    server = await startOctoPrintServer(0, handler);
    await submit();

    const attempt = await printThrough(connectedTo(server.port));

    expect(attempt).toBe('finished');
    // Proves the outcome was recovered across a real reconnect rather than delivered live.
    expect(server.connectionsAccepted()).toBeGreaterThan(1);
  }, 60_000);

  // AIDEV-NOTE: OctoPrint's history records a cancelled print as a failure, so a run reconciled
  // after the fact cannot be told from a genuine error. Only a live event reports 'cancelled'.
  it('learns a failure that was announced while the socket was down', async () => {
    const handler: JobSubmittedHandler = (_job, complete) => {
      server!.dropConnections();
      complete('PrintFailed');
    };
    server = await startOctoPrintServer(0, handler);
    await submit();

    expect(await printThrough(connectedTo(server.port))).toBe('failed');
  }, 60_000);

  // AIDEV-NOTE: a rejected print is run again under the SAME remote path, so the file's history holds
  // the FIRST print's outcome while the second is still running - and a client that read that
  // history instead of the printer's flags would report an outcome for a print still on the bed.
  //
  // What THIS proves is that the sequence works against a real server: two prints down one path,
  // across a real reconnect, and the shop still waiting when the second really ended. It does not
  // pin the reading of the flags, and measurably does not - taking out the in-flight check leaves it
  // green. That is `keeps waiting while the printer reports %s` in OctoPrint.test.ts, which stubs
  // the history to a success and holds the printer printing, and which the same mutation fails at
  // once. The logic is the unit test's; the protocol is this one's.
  it('does not mistake an earlier print of the same job for the one still running', async () => {
    let prints = 0;
    let secondPrintFinished = false;

    const handler: JobSubmittedHandler = (_job, complete) => {
      prints++;
      if (prints === 1) {
        complete('PrintDone');
        return;
      }

      // The second print outlasts the reconnect, so the client is back and asking while it runs.
      const accepted = server!.connectionsAccepted();
      server!.dropConnections();
      void whenListeningAgain(accepted).then(() => {
        secondPrintFinished = true;
        complete('PrintDone');
      });
    };
    server = await startOctoPrintServer(0, handler);
    const id = await submit();
    const printer = connectedTo(server.port);

    await printThrough(printer);
    await shop.reject(id);

    expect(await printThrough(printer)).toBe('finished');
    expect(secondPrintFinished).toBe(true);
  }, 60_000);

  it('waits for the live event when the print is still running at reconnect', async () => {
    const handler: JobSubmittedHandler = (_job, complete) => {
      const accepted = server!.connectionsAccepted();
      server!.dropConnections();
      void whenListeningAgain(accepted).then(() => complete('PrintCancelled'));
    };
    server = await startOctoPrintServer(0, handler);
    await submit();

    // 'cancelled' can only have come from an event delivered live - the history cannot express it.
    expect(await printThrough(connectedTo(server.port))).toBe('cancelled');
  }, 60_000);
});
