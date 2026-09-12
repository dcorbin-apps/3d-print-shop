#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { HttpShop, SHOP_URL_ENV, defaultShopUrl, defaultToken } from '@3d-print-shop/client';
import type { Role } from '@3d-print-shop/client';
import { DEFAULT_PORT, LOOPBACK, serve } from './api.js';
import { Foreman, RETRY_TICK_MS } from './Foreman.js';
import { OctoPrintMachines } from './OctoPrintMachines.js';
import type { PrinterApi } from './Printer.js';
import { JobStore, MAX_GCODE_ENV } from './JobStore.js';
import {
  ETC_ENV,
  callersIn,
  defaultEtc,
  printerKeysIn,
  rereadCallers,
  rereadPrinterKeys,
  setPassword,
  whosePasswordChanged,
  writePrinterKey,
} from './credentials.js';
import { SESSIONS_FILE, Sessions } from './sessions.js';
import type { Callers } from './credentials.js';
import { judgeJob, listJobs, whatToLoadNext } from './jobAdmin.js';
import { redacting, toStdout } from './log.js';
import { addSomebody, askForANewPassword, changePassword, giveAToken, listCallers, migrateTheCallers } from './callerAdmin.js';
import { initialiseShop } from './shopAdmin.js';
import { addPrinter, listPrinters, loadFilament, pausePrinter, removePrinter, resumePrinter, shutDownShop } from './printerAdmin.js';
import { claimData } from './dataLock.js';
import { DATA_ROOT_ENV, defaultLayout, layoutUnder } from './dataLayout.js';

// AIDEV-NOTE: thin on purpose. Every printer command is a function in printerAdmin.ts answering with
// lines, and serving is one call into api.ts; this only turns argv into a call and lines into
// output, so the operator's half of the shop can be tested without a process.
//
// The printer commands go through the API, like every other client. They used to write the data directory
// directly, which made this a second writer over files the service was writing at the same time - a
// `stop` landing at the same instant as an `add` could lose one. It also means an operator can mind
// a shop that is running somewhere else, which reaching into a directory could never do.
//
// Only `serve` names a data directory, because only `serve` is the thing that holds it.
export function createCLI(): Command {
  const program = new Command();
  const shop = (options: { shopUrl?: string }): HttpShop => new HttpShop(options.shopUrl ?? defaultShopUrl(), defaultToken());

  program.name('3d-print-shop').description('Run the shop, and mind the printers it prints on');

  const say = (lines: string[]): void => lines.forEach((line) => console.log(line));

  program
    .command('serve')
    .description('Run the shop, so clients can submit work and ask after it')
    .option('--port <port>', 'the port to listen on', readPort, DEFAULT_PORT)
    // No default here: serve() holds it, and a second copy of an address is a second thing to change.
    .option('--listen <address>', 'the address to listen on - loopback unless said otherwise, and anything else is on the network')
    .option('--data <path>', `one directory to keep everything under (or ${DATA_ROOT_ENV}; otherwise this system's own places)`)
    .option(
      '--max-gcode <megabytes>',
      `the largest gcode it will take, and the room it keeps spare for one (or ${MAX_GCODE_ENV})`,
      readMegabytes
    )
    .option('--etc <path>', `where its credentials are kept (or ${ETC_ENV}; defaults to ${defaultEtc()})`)
    // AIDEV-NOTE: a directory, and the server is told nothing else about it. It is the built page,
    // which is a client of this shop - so finding it through the ui package would be the server
    // depending on a client, and that direction never runs.
    .option('--page <path>', 'a directory of files to serve beside the API, so a browser has somewhere to get the page')
    .action(async (options: { port: number; listen?: string; data?: string; maxGcode?: number; etc?: string; page?: string }) => {
      // AIDEV-NOTE: named a place, everything goes under it; named none, each kind goes where this
      // system keeps that kind. The branch is in dataLayout.ts and this is its first caller rather
      // than its home - the server is a library too, and an embedder needs the same answer.
      const where = options.data === undefined ? defaultLayout() : layoutUnder(options.data);
      const store = new JobStore(where, { maxGcodeBytes: options.maxGcode });
      const etc = options.etc ?? defaultEtc();

      // AIDEV-NOTE: credentials come first, and a shop that has none does not start. Every route
      // names its caller, so there is nothing for a shop with no callers to answer - and reading a
      // missing file as "nobody configured yet" is how a fresh machine ends up serving anybody who
      // reaches the port. A file that is THERE and wrong stops it for the same reason: answering a
      // typo in the security file by removing the security is the failure nobody notices.
      let callers: Callers = await callersIn(etc);
      let printerKeys: ReadonlyMap<string, string> = await printerKeysIn(etc);
      const listenOn = options.listen ?? LOOPBACK;

      // AIDEV-NOTE: built from every secret this process HOLDS, which is now the printer keys and
      // nothing else - a caller's token is kept as a digest and a session as a digest of one, so
      // there is no token here to leak. What is left are the keys, which cannot be hashed because
      // the shop has to present them to a machine. Asked for afresh on each line, because a key
      // given while the shop runs is one this process did not hold when the log was made.
      const log = redacting(toStdout(), () => printerKeys.values());

      // Before anything else: a data directory that is not there, or is already being served, is a shop that
      // must refuse to start rather than start and do damage.
      await store.ready();
      const releaseData = await claimData(where.run);

      // AIDEV-NOTE: picked up rather than started empty, so an update at 2am is not a wall display
      // asking to be logged in to in the morning. A file it cannot read logs everybody out and says
      // why - the safe direction, taken out loud rather than quietly.
      const sessions = new Sessions({ keptIn: path.join(where.state, SESSIONS_FILE), log });
      const pickedUpSessions = await sessions.pickUp().catch((failure: unknown) => {
        log.error('could not read who was logged in, so everybody logs in again', { why: (failure as Error).message });

        return 0;
      });

      const machines = new OctoPrintMachines(() => printerKeys);
      const foreman = new Foreman(store, machines.reach, log);

      // AIDEV-NOTE: the one thing the shop does on a clock rather than after a change it made. A
      // machine the shop cannot hear makes no changes, so nothing else would ever ask again - and
      // what ends one of these happens in a room the shop cannot see.
      const reachingAgain = setInterval(() => {
        void foreman
          .reachForWhatIsLost()
          .catch((failure: unknown) => log.error('could not reach for the printers', { why: (failure as Error).message }));
      }, RETRY_TICK_MS);

      // AIDEV-NOTE: every change the API makes is a moment something might be startable, so the
      // foreman is told about all of them rather than about a chosen few. Not awaited: a client
      // waiting on its own submission has no reason to wait for a printer to take a different job.
      const lookForWork = (): void => {
        void foreman.considerStarting().catch((failure: unknown) => log.error('could not look for work', { why: (failure as Error).message }));
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
        clearInterval(reachingAgain);
        foreman.stop();
        machines.closeAll();
        releaseData();

        void foreman.watchersSettled().then(() => {
          log.info('the shop has stopped');
          say(['3d-print-shop has stopped']);
        });
      };

      // An operator's go, which is more than a change: it says which machine, and that somebody has
      // been to look at it.
      const tryEverythingAgain = (name: string): void => {
        void foreman
          .startAgain(name)
          .catch((failure: unknown) => log.error('could not try the printer again', { printer: name, why: (failure as Error).message }));
      };

      // AIDEV-NOTE: written to the file the shop reads AND put into what this process is holding, in
      // that order - so a key given while the shop runs needs no signal and no restart. Then the
      // printer is tried at once, because a machine that had no key is written down as unreachable
      // and would otherwise serve out a backoff before anyone found out the key was right.
      //
      // The log's redactor reads `printerKeys` afresh on every line, so a key that arrives this way
      // cannot reach a log written after it.
      const keepTheKey = async (printer: string, key: string): Promise<void> => {
        printerKeys = await writePrinterKey(etc, printer, key);
        log.info('a printer was given its key', { printer, etc });
        tryEverythingAgain(printer);
      };

      // AIDEV-NOTE: written to the file and then read back into what this process holds, in that
      // order and for the same reason a printer's key is - a password changed while the shop runs
      // needs no signal and no restart. Read back rather than patched in memory so that what is in
      // force is what the FILE says, which is what a re-read or a restart would find.
      const keepTheirNewPassword = async (id: string, password: string): Promise<void> => {
        await setPassword(etc, id, password);
        callers = await callersIn(etc);
      };

      const shopServer = await serve(
        store,
        options.port,
        {
          changed: lookForWork,
          started: tryEverythingAgain,
          shutDown: stopTheShop,
          callers: () => callers,
          sessions,
          keyGiven: keepTheKey,
          passwordChanged: keepTheirNewPassword,
          page: options.page,
          log,
        },
        listenOn
      );

      // What a supervised service is stopped with. `launchd` and `systemd` both send it, and one
      // that ignored it would be killed with prints still being watched.
      process.on('SIGTERM', stopTheShop);
      process.on('SIGINT', stopTheShop);

      // AIDEV-NOTE: SIGHUP is how a credential is changed without stopping the shop, and node ENDS a
      // process that has no handler for it - so a shop under a terminal that closed used to die where
      // it now re-reads. Everything the shop was given is re-read, each independently: a callers file
      // somebody has just broken is no reason to leave a corrected key unread.
      process.on('SIGHUP', () => {
        void rereadCallers(etc, callers, log).then((known) => {
          // AIDEV-NOTE: the other half of what a new password is for. `caller password` says every
          // browser logged in as them is logged out once the shop has re-read this, and this is the
          // sentence that makes it true - without it a stolen password went on working in whatever
          // browser already had a session, which is the one place it was certain to be.
          for (const id of whosePasswordChanged(callers, known)) {
            sessions.endEveryOneOf(id);
            log.info('a changed password logged out every browser it was logged in on', { caller: id });
          }

          callers = known;
        });
        void rereadPrinterKeys(etc, printerKeys, log).then((keys) => (printerKeys = keys));
      });

      // Where it actually IS, not where it was asked to be. Port 0 means "any free one", and
      // an operator who used it has no other way to find out which. The address is said too,
      // because whether this shop can be reached from the network is the difference between the
      // default and `--listen`, and it is worth being able to see which one is running.
      const bound = shopServer.address() as AddressInfo;

      // AIDEV-NOTE: both, and they are not the same thing. `say` is the COMMAND answering the person
      // who typed it - and two test suites read the port back out of that line, so its shape is a
      // contract. The log line is the running SERVICE's record, which is what a supervisor captures
      // and what somebody reads days later asking what this process was.
      // AIDEV-NOTE: which data directory and which credentials, because a process that outlives the run
      // started it is a process somebody has to identify later - and argv alone was not enough to do
      // that for two shops found still listening, one of them 14 hours old.
      log.info('the shop is listening', {
        address: bound.address,
        port: bound.port,
        callers: callers.size,
        sessions: pickedUpSessions,
        jobs: where.jobs,
        state: where.state,
        etc,
        page: options.page,
      });
      say([`3d-print-shop is listening on ${bound.address}:${bound.port}`, `${callers.size} caller(s) may ask`]);

      // A restart does not stop a machine. Prints that were already running are picked up first,
      // then anything that could start now - nothing else will wake this up until a change arrives.
      const pickedUp = await foreman.resumeWatching();
      if (pickedUp.length > 0) log.info('prints picked up after a restart', { printers: pickedUp });

      lookForWork();
    });

  program
    .command('init')
    .description('Set a fresh machine up with one admin, so there is somebody this shop may answer')
    .argument('[name]', 'what to call them, and the id every job of theirs is owned by', 'admin')
    .option('--etc <path>', `where its credentials are kept (or ${ETC_ENV}; defaults to ${defaultEtc()})`)
    .action(async (name: string, options: { etc?: string }) =>
      say(await initialiseShop(options.etc ?? defaultEtc(), name, await askForANewPassword()))
    );

  // AIDEV-NOTE: these write the credentials file rather than asking a running shop, and they are the
  // only operator commands that do. A shop cannot be asked to give somebody a way in that it does
  // not yet answer - and the file is the thing it re-reads, so every one of them ends by saying so.
  const caller = program.command('caller').description('Who this shop answers, and what they present');
  const whereCredentialsAre = (command: Command): Command =>
    command.option('--etc <path>', `where its credentials are kept (or ${ETC_ENV}; defaults to ${defaultEtc()})`);

  whereCredentialsAre(
    caller
      .command('add')
      .description('Add somebody this shop may answer - a person with a password, or a machine with a token')
      .argument('<id>', 'what every job of theirs is owned by, and what they log in as')
      .argument('[name]', 'what a log and the page call them')
      .option('--role <role>', 'admin or user', readRole, 'user')
      .option('--machine', 'a program rather than a person: issue a token instead of asking for a password')
  ).action(async (id: string, name: string | undefined, options: { role: Role; machine?: boolean; etc?: string }) =>
    say(await addSomebody(options.etc ?? defaultEtc(), id, name ?? id, options.role, options.machine === true))
  );

  whereCredentialsAre(caller.command('password').description('Set what somebody logs in with').argument('<id>', 'which caller')).action(
    async (id: string, options: { etc?: string }) => say(await changePassword(options.etc ?? defaultEtc(), id))
  );

  whereCredentialsAre(
    caller.command('token').description('Issue another token, for another machine').argument('<id>', 'which caller')
  ).action(async (id: string, options: { etc?: string }) => say(await giveAToken(options.etc ?? defaultEtc(), id)));

  whereCredentialsAre(caller.command('list').description('Who this shop answers, and what each of them has')).action(
    async (options: { etc?: string }) => say(await listCallers(options.etc ?? defaultEtc()))
  );

  whereCredentialsAre(
    caller.command('migrate').description('Hash the tokens in a credentials file that still holds them in the clear')
  ).action(async (options: { etc?: string }) => say(await migrateTheCallers(options.etc ?? defaultEtc())));

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
    .command('waiting')
    .description('What the queued work is waiting for, busiest first - what to load next')
    .argument('[printer]', 'only the work this printer could take, rather than the whole shop')
    .action(async (printer: string | undefined) => say(await whatToLoadNext(shop(job.opts()), printer)));

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

// AIDEV-NOTE: commander answers a --help anywhere in argv, and BEFORE it has decided whether the
// command in front of it is one it has. So `3d-print-shop add printer add --help` - a typo, one word
// too many - printed the general help and exited 0, and `printer nonsense --help` printed the
// printer help and did the same. Neither is distinguishable from having asked for help and got it,
// which is the failure a script cannot see.
//
// Walked rather than looked up once, because the same thing happens at every level that has
// subcommands. It stops at the first command that has none: everything after that is an argument,
// and `job approve 7` must not have 7 read as a command it does not have.
/** The word that was asked for as a command and is not one, so a typo is not answered as a cry for help. */
// AIDEV-NOTE: the whole of what `main.ts` does, here rather than there, so that the ORDER can be
// asked about. The check has to run BEFORE commander is given argv - commander answers a --help
// further along the line first and exits 0, which a script cannot tell from success - and a module
// body that does this on import can only be proved by spawning a process. main.ts is now the one
// line that calls this.
/** Run a command line, answering the exit code it earned. */
export async function run(argv: string[], complain: (message: string) => void = console.error): Promise<number> {
  const cli = createCLI();

  const unknown = unknownCommandIn(cli, argv.slice(2));
  if (unknown !== undefined) {
    // Worded as commander words its own, so the two read the same to an operator.
    complain(`error: unknown command '${unknown}'`);

    return 1;
  }

  try {
    // AIDEV-NOTE: parseAsync, not parse - commander only awaits an action's returned promise in the
    // async variant, so with plain parse() every command would be a floating promise and a failure
    // would surface as an unhandled rejection after the process had decided its own exit code.
    await cli.parseAsync(argv);

    return 0;
  } catch (error) {
    // Only the message. An operator adding a printer wants "cannot read 250x210 as a build volume",
    // not a stack through commander.
    complain((error as Error).message);

    return 1;
  }
}

export function unknownCommandIn(program: Command, args: string[]): string | undefined {
  let at = program;
  let skipping = false;

  for (const word of args) {
    if (skipping) {
      skipping = false;
      continue;
    }

    if (word.startsWith('-')) {
      skipping = carriesAValue(at, word);
      continue;
    }

    // `help` is commander's own and is in no list to be found in; what follows it is commander's to
    // judge. Everything after a command with no subcommands is an argument rather than a command.
    if (word === 'help' || at.commands.length === 0) return undefined;

    const found = at.commands.find((command) => command.name() === word || command.aliases().includes(word));
    if (found === undefined) return word;

    at = found;
  }

  return undefined;
}

// Whether the next word belongs to this option rather than being a command. Only the options
// declared HERE: commander lets one written after a subcommand belong to its parent, and a word this
// misses is a word that lands on a command with no subcommands and is let past as an argument.
function carriesAValue(at: Command, word: string): boolean {
  if (word.includes('=')) return false;

  const option = at.options.find((declared) => declared.short === word || declared.long === word);

  return option?.required === true || option?.optional === true;
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

// The two there are, said back rather than let through as whatever was typed - a role nobody
// recognises would be written into the file and refused by the shop on its next read.
export function readRole(value: string): Role {
  if (value !== 'admin' && value !== 'user') throw new InvalidArgumentError(`a role is "admin" or "user", not ${JSON.stringify(value)}`);

  return value;
}

// Digits and nothing else, because Number() reads an empty --port as 0 - which listens on whatever
// port is free, and an operator who mistyped would never find out where the shop went.
export function readPort(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new InvalidArgumentError(`cannot read "${value}" as a port`);
  }

  return Number(value);
}
