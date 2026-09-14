import { readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const TOKEN_ENV = 'PRINT_SHOP_TOKEN';

/** A token file somebody other than its owner can read. Refused rather than presented. */
export class UnusableToken extends Error {}

// AIDEV-NOTE: a caller's own token, and nothing like the shop's /etc files - it is ONE string, it
// belongs to whoever is calling rather than to the machine, and the caller is often not on the same
// machine at all. The environment suits a program; the file suits a person's shell, where an
// environment variable would have to be set by something.
export function defaultTokenFile(): string {
  const configured = process.env.XDG_CONFIG_HOME;

  return path.join(configured ?? path.join(homedir(), '.config'), '3d-print-shop', 'token');
}

/**
 * The token to present, or undefined when there is none to present - which every shop refuses,
 * because no route there answers a caller it cannot name.
 *
 * Read synchronously and once: every caller needs it before its first request, and a token that
 * changed part way through a run would be worse than one that did not.
 */
export function defaultToken(): string | undefined {
  const said = process.env[TOKEN_ENV]?.trim();
  if (said !== undefined && said !== '') return said;

  // The file is only judged when it is the thing being used. An environment that named a token has
  // already answered, and what a file nobody is reading is set to is nobody's business.
  const file = defaultTokenFile();
  const found = whatIsThere(file);
  if (found === undefined) return undefined;

  requireOnlyItsOwnerCanRead(file, found.mode);

  try {
    const held = readFileSync(file, 'utf-8').trim();

    return held === '' ? undefined : held;
  } catch {
    return undefined;
  }
}

// Not there is no token, which is what it has always been - and so is a directory this cannot look
// into. Neither is a thing to complain about; what is, is a file that IS there and is open to others.
function whatIsThere(file: string): Stats | undefined {
  try {
    return statSync(file, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

// AIDEV-NOTE: the mode is checked rather than assumed, the way ssh refuses a private key anyone can
// read and the way the shop refuses its own credential files - see `readOnlyByItsOwner` in the
// server's credentials.ts, which says the same thing about the files at the other end. What is in
// here is a BEARER credential: whoever presents it is that caller with that caller's role, and on an
// ordinary install it is the first admin's, which is every printer and every job and the power to
// stop the shop. So a file left 0644 by a stray redirect hands all of that to any account on the
// machine, silently, while every command still works - and the installer already tells whoever pastes
// a token in here to chmod it 600.
//
// Refused rather than ignored. Ignoring it would answer 401 - "this shop does not know that token" -
// with the right token sitting on disk, which sends somebody looking anywhere but at the mode.
//
// Group and other, not owner: what matters is that nobody ELSE can read it.
function requireOnlyItsOwnerCanRead(file: string, mode: number): void {
  if ((mode & 0o077) === 0) return;

  throw new UnusableToken(
    `${file} can be read by somebody other than its owner (mode ${(mode & 0o777).toString(8)}) - ` +
      `it is the token this shop knows you by, so it must be 0600: chmod 600 ${file}`
  );
}
