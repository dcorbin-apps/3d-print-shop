#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import type { AddressInfo } from 'node:net';
import { HttpShop, SHOP_URL_ENV, defaultShopUrl } from '@3d-print-shop/client';
import { DEFAULT_PORT, serve } from './api.js';
import { Foreman } from './Foreman.js';
import { OctoPrintMachines } from './OctoPrintMachines.js';
import type { PrinterApi } from './Printer.js';
import { JobStore, MAX_GCODE_ENV } from './JobStore.js';
import { judgeJob, listJobs } from './jobAdmin.js';
import { addPrinter, listPrinters, loadFilament, pausePrinter, removePrinter, resumePrinter, shutDownShop } from './printerAdmin.js';
import { claimSpool } from './spoolLock.js';
import { SPOOL_ROOT_ENV, defaultSpoolRoot } from './spoolRoot.js';

// AIDEV-NOTE: thin on purpose. Every printer command is a function in printerAdmin.ts answering with
// lines, and serving is one call into api.ts; this only turns argv into a call and lines into
// output, so the operator's half of the shop can be tested without a process.
//
// The printer commands go through the API, like every other client. They used to write the spool
// directly, which made this a second writer over files the service was writing at the same time - a
// `stop` landing at the same instant as an `add` could lose one. It also means an operator can mind
// a shop that is running somewhere else, which reaching into a directory could never do.
//
// Only `serve` names a spool, because only `serve` is the thing that holds it.
export function createCLI(): Command {
  const program = new Command();
  const shop = (options: { shopUrl?: string }): HttpShop => new HttpShop(options.shopUrl ?? defaultShopUrl());

  program.name('3d-print-shop').description('Run the shop, and mind the printers it prints on');

  const say = (lines: string[]): void => lines.forEach((line) => console.log(line));

  program
    .command('serve')
    .description('Run the shop, so clients can submit work and ask after it')
    .option('--port <port>', 'the port to listen on', readPort, DEFAULT_PORT)
    // No default here: serve() holds it, and a second copy of an address is a second thing to change.
    .option('--listen <address>', 'the address to listen on - loopback unless said otherwise, and anything else is on the network')
    .option('--spool <path>', `where the shop keeps its work (or ${SPOOL_ROOT_ENV}; defaults to ${defaultSpoolRoot()})`)
    .option(
      '--max-gcode <megabytes>',
      `the largest gcode it will take, and the room it keeps spare for one (or ${MAX_GCODE_ENV})`,
      readMegabytes
    )
    .action(async (options: { port: number; listen?: string; spool?: string; maxGcode?: number }) => {
      const store = new JobStore(options.spool ?? defaultSpoolRoot(), { maxGcodeBytes: options.maxGcode });

      // Before anything else: a spool that is not there, or is already being served, is a shop that
      // must refuse to start rather than start and do damage.
      await store.ready();
      const releaseSpool = await claimSpool(options.spool ?? defaultSpoolRoot());

      const machines = new OctoPrintMachines();
      const foreman = new Foreman(store, machines.reach);

      // AIDEV-NOTE: every change the API makes is a moment something might be startable, so the
      // foreman is told about all of them rather than about a chosen few. Not awaited: a client
      // waiting on its own submission has no reason to wait for a printer to take a different job.
      const lookForWork = (): void => {
        void foreman.considerStarting().catch((failure: unknown) => console.error((failure as Error).message));
      };

      // AIDEV-NOTE: stopping the listener is what makes the process end - nothing else here holds
      // the event loop open once the printers are let go. Idempotent, because the operator can ask
      // over the API and the supervisor can signal at the same moment.
      let stopping = false;

      const stopTheShop = (): void => {
        if (stopping) return;
        stopping = true;

        // In this order: take no more requests, start nothing more, then let the machines go -
        // which is what settles the watchers waiting on them.
        shopServer.close();
        foreman.stop();
        machines.closeAll();
        releaseSpool();

        void foreman.watchersSettled().then(() => say(['3d-print-shop has stopped']));
      };

      const shopServer = await serve(store, options.port, { changed: lookForWork, shutDown: stopTheShop }, options.listen);

      // What a supervised service is stopped with. `launchd` and `systemd` both send it, and one
      // that ignored it would be killed with prints still being watched.
      process.on('SIGTERM', stopTheShop);
      process.on('SIGINT', stopTheShop);

      // Where it actually IS, not where it was asked to be. Port 0 means "any free one", and
      // an operator who used it has no other way to find out which. The address is said too,
      // because whether this shop can be reached from the network is the difference between the
      // default and `--listen`, and it is worth being able to see which one is running.
      const bound = shopServer.address() as AddressInfo;
      say([`3d-print-shop is listening on ${bound.address}:${bound.port}`]);

      // A restart does not stop a machine. Prints that were already running are picked up first,
      // then anything that could start now - nothing else will wake this up until a change arrives.
      await foreman.resumeWatching();
      lookForWork();
    });

  const reachingTheShop = (command: Command): Command =>
    command.option('--shop-url <url>', `where the shop answers (or ${SHOP_URL_ENV}; defaults to ${defaultShopUrl()})`);

  const shutdown = reachingTheShop(
    program.command('shutdown').description('Ask the shop to stop - prints already running are picked up again next time')
  );
  shutdown.action(async () => say(await shutDownShop(shop(shutdown.opts()))));

  const job = reachingTheShop(program.command('job').description('The work this shop is holding'));

  job
    .command('list')
    .description('What the shop is holding, and where each of it has got to')
    .action(async () => say(await listJobs(shop(job.opts()))));

  job
    .command('approve')
    .description('Say a print is good - the job leaves the shop, gcode and all')
    .argument('<id>', 'which job', readJobId)
    .action(async (id: number) => say(await judgeJob(shop(job.opts()), id, 'approved')));

  job
    .command('reject')
    .description('Say a print is not usable - the job goes back to be printed again')
    .argument('<id>', 'which job', readJobId)
    .action(async (id: number) => say(await judgeJob(shop(job.opts()), id, 'rejected')));

  job
    .command('abandon')
    .description('Give up on a print - the job leaves the shop, and is not printed again')
    .argument('<id>', 'which job', readJobId)
    .action(async (id: number) => say(await judgeJob(shop(job.opts()), id, 'abandoned')));

  const printer = program
    .command('printer')
    .description('The printers this shop prints on');
  reachingTheShop(printer);

  printer
    .command('add')
    .description('Add a printer, or change what the shop knows about one already here')
    .argument('<name>', 'what to call it')
    .argument('<volume>', 'build volume as <width>x<depth>x<height> in mm, e.g. 250x210x220')
    .argument('<address>', 'where the machine answers, e.g. http://octopi.local')
    // AIDEV-NOTE: no key argument, deliberately. A key typed here is in shell history and in `ps`;
    // the service reads it from the environment - see design/3d-print-shop.md.
    .option('--api <protocol>', 'what it speaks', 'octoprint')
    .action(async (name: string, volume: string, address: string, options: { api: PrinterApi }) =>
      say(await addPrinter(shop(printer.opts()), name, volume, address, options.api))
    );

  printer
    .command('load')
    .description('Say what filament is on a printer now - name none to say it is empty')
    .argument('<name>', 'which printer')
    .argument('[filaments...]', "the printer's own names for what is loaded, in extruder order")
    .action(async (name: string, filaments: string[]) => say(await loadFilament(shop(printer.opts()), name, filaments)));

  printer
    .command('list')
    .description('What printers this shop has, and which are stopped')
    .action(async () => say(await listPrinters(shop(printer.opts()))));

  printer
    .command('remove')
    .description('Take a printer out of the shop')
    .argument('<name>', 'which printer')
    .action(async (name: string) => say(await removePrinter(shop(printer.opts()), name)));

  printer
    .command('stop')
    .description('Stop a printer taking work')
    .argument('<name>', 'which printer')
    .argument('<reason>', 'what an operator should know')
    .action(async (name: string, reason: string) => say(await pausePrinter(shop(printer.opts()), name, reason)));

  printer
    .command('start')
    .description('Let a stopped printer take work again')
    .argument('<name>', 'which printer')
    .action(async (name: string) => say(await resumePrinter(shop(printer.opts()), name)));

  return program;
}

// The shop's own ids are counting numbers, so anything else is a typo rather than a job it has not
// got - and saying so here is better than a 404 about job NaN.
export function readJobId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw new InvalidArgumentError(`cannot read "${value}" as a job id`);
  }

  return Number(value);
}

// In whole megabytes, because that is the unit gcode is talked about in. Zero would be a shop that
// refuses everything, which is a typo rather than a thing anyone means.
export function readMegabytes(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw new InvalidArgumentError(`cannot read "${value}" as a number of megabytes`);
  }

  return Number(value) * 1024 * 1024;
}

// Digits and nothing else, because Number() reads an empty --port as 0 - which listens on whatever
// port is free, and an operator who mistyped would never find out where the shop went.
export function readPort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new InvalidArgumentError(`cannot read "${value}" as a port`);
  }

  return Number(value);
}
