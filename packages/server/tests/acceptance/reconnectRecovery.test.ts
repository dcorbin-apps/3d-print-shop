import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { startOctoPrintServer } from '@3d-print-shop/octoprint-sim';
import type { JobSubmittedHandler, OctoPrintServer } from '@3d-print-shop/octoprint-sim';
import { JobStore } from '../../src/JobStore';
import { OctoPrint } from '../../src/OctoPrint';
import { recordOutcome, startNextPrint } from '../../src/printing';
import type { Printer } from '../../src/printing';
import type { PrinterOutcome } from '../../src/Job';

// AIDEV-NOTE: real sockets against a real OctoPrint stand-in on an ephemeral port - no mocks. The
// unit tests in OctoPrint.test.ts drive reconnect recovery through a fake WebSocket, which can only
// prove the client behaves as its author imagined the protocol works. This proves the protocol
// itself: a socket that really dies, a print that really finishes while nobody is listening, and a
// shop that has to learn the outcome from what the server actually serves on reconnect.
describe('recovering a print outcome across a dropped connection', () => {
  let server: OctoPrintServer | undefined;
  let spool: string;
  let shop: JobStore;
  let machine: OctoPrint | undefined;

  // The real backoff starts at 500ms; nothing here tests how long it waits. What matters is that
  // these two are far apart: a print finishing BEFORE the client is back exercises recovery, and one
  // finishing after it is just an ordinary live event.
  const RECONNECT_DELAY_MS = 80;
  const OUTLASTS_RECONNECT_MS = RECONNECT_DELAY_MS * 4;

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  // Starting a print and hearing how it ended are two calls now; every test here is about the
  // second one, so they go together.
  async function printThrough(machine: Printer): Promise<PrinterOutcome> {
    await startNextPrint(shop, async () => machine, 'mk4');

    return recordOutcome(shop, machine, 'mk4');
  }

  beforeEach(async () => {
    spool = await mkdtemp(path.join(tmpdir(), 'print-shop-reconnect-'));
    shop = new JobStore(spool);
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
    await rm(spool, { recursive: true, force: true });
  });

  function connectedTo(port: number): OctoPrint {
    machine = new OctoPrint({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'acceptance-key' }, undefined, undefined, () =>
      delay(RECONNECT_DELAY_MS)
    );
    return machine;
  }

  const DAVE = 'u-dave';

  async function submit(displayName = 'tray'): Promise<number> {
    const job = await shop.submit({ filaments: ['PLA'], displayName }, Readable.from(['G1 X0 Y0\n']), DAVE);
    return job.id;
  }

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
  });

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
  });

  // AIDEV-NOTE: the hazard this pins down. A rejected print is run again under the SAME remote path,
  // so the file's history holds the FIRST print's outcome while the second is still running. A
  // client that reconnects mid-print and reads that history instead of the printer's flags would
  // resolve the second print early - reporting an outcome for a print still on the bed. Asserting
  // the outcome alone would not catch it, so this asserts the shop was still waiting when the
  // second print really ended.
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
      server!.dropConnections();
      void delay(OUTLASTS_RECONNECT_MS).then(() => {
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
  });

  it('waits for the live event when the print is still running at reconnect', async () => {
    const handler: JobSubmittedHandler = (_job, complete) => {
      server!.dropConnections();
      void delay(OUTLASTS_RECONNECT_MS).then(() => complete('PrintCancelled'));
    };
    server = await startOctoPrintServer(0, handler);
    await submit();

    // 'cancelled' can only have come from an event delivered live - the history cannot express it.
    expect(await printThrough(connectedTo(server.port))).toBe('cancelled');
  });
});
