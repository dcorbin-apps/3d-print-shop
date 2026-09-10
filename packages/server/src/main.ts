#!/usr/bin/env node
import { createCLI, unknownCommandIn } from './cli.js';

// AIDEV-NOTE: parseAsync, not parse - commander only awaits an action's returned promise in the
// async variant, so with plain parse() every command here would be a floating promise and a failure
// would surface as an unhandled rejection after the process had decided its own exit code.
//
// Only the message is printed. An operator adding a printer wants "cannot read 250x210 as a build
// volume", not a stack through commander.
const cli = createCLI();

// Before commander, which would answer a --help further along the line first and exit 0 - see
// `unknownCommandIn`. Worded as commander words its own, so the two read the same to an operator.
const unknown = unknownCommandIn(cli, process.argv.slice(2));

if (unknown === undefined) {
  cli.parseAsync(process.argv).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
} else {
  console.error(`error: unknown command '${unknown}'`);
  process.exitCode = 1;
}
