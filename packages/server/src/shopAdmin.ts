import * as path from 'node:path';
import { TOKEN_ENV, TOKEN_FILE_FOR_ANYONE } from '@3d-print-shop/client';
import { CALLERS_FILE, writeFirstCaller } from './credentials.js';

// AIDEV-NOTE: the one operator command that is NOT a client of a running shop, and cannot be: every
// route names its caller, so until this has run there is nobody a shop would answer - and a shop
// with no callers refuses to start at all. It writes the file `serve` then reads.
export async function initialiseShop(etc: string, name: string, password: string): Promise<string[]> {
  // AIDEV-NOTE: the id is the name it was given. They are separate fields because an id outlives a
  // name - a job records who owns it and is never rewritten - and this is the one moment there is
  // nothing to tell them apart by. An operator who renames somebody afterwards edits `name` and
  // leaves `id` alone, which is the whole reason the file carries both.
  const token = await writeFirstCaller(etc, name, name, password);

  // AIDEV-NOTE: both, because they are for two different things and a shop wants both from the
  // first minute. The PASSWORD is how a person logs in to the page; the TOKEN is how a program
  // calls - a slicer submitting a job does not have a browser to log in with.
  return [
    `${path.join(etc, CALLERS_FILE)} now names one admin, ${name}`,
    '',
    `${name} logs in to the page with the password you just set.`,
    '',
    'their token, for a program that calls the shop - written nowhere else, and not shown again:',
    '',
    `  ${token}`,
    '',
    `a client looks for it in ${TOKEN_ENV}, or in ${TOKEN_FILE_FOR_ANYONE} of whoever runs it`,
  ];
}
