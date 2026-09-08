import * as path from 'node:path';
import { TOKEN_ENV, defaultTokenFile } from '@3d-print-shop/client';
import { CALLERS_FILE, writeFirstCaller } from './credentials.js';

// AIDEV-NOTE: the one operator command that is NOT a client of a running shop, and cannot be: every
// route names its caller, so until this has run there is nobody a shop would answer - and a shop
// with no callers refuses to start at all. It writes the file `serve` then reads.
export async function initialiseShop(etc: string, name: string): Promise<string[]> {
  // AIDEV-NOTE: the id is the name it was given. They are separate fields because an id outlives a
  // name - a job records who owns it and is never rewritten - and this is the one moment there is
  // nothing to tell them apart by. An operator who renames somebody afterwards edits `name` and
  // leaves `id` alone, which is the whole reason the file carries both.
  const token = await writeFirstCaller(etc, name, name);

  return [
    `${path.join(etc, CALLERS_FILE)} now names one admin, ${name}`,
    '',
    'their token, which is written nowhere else and will not be shown again:',
    '',
    `  ${token}`,
    '',
    `a client looks for it in ${TOKEN_ENV}, or in ${defaultTokenFile()}`,
  ];
}
