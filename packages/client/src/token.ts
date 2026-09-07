import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const TOKEN_ENV = 'PRINT_SHOP_TOKEN';

// AIDEV-NOTE: a caller's own token, and nothing like the shop's /etc files - it is ONE string, it
// belongs to whoever is calling rather than to the machine, and the caller is often not on the same
// machine at all. The environment suits a program; the file suits a person's shell, where an
// environment variable would have to be set by something.
export function defaultTokenFile(): string {
  const configured = process.env.XDG_CONFIG_HOME;

  return path.join(configured ?? path.join(homedir(), '.config'), '3d-print-shop', 'token');
}

/**
 * The token to present, or undefined when there is none to present - which is right for a shop that
 * has no callers configured, and is refused by one that has.
 *
 * Read synchronously and once: every caller needs it before its first request, and a token that
 * changed part way through a run would be worse than one that did not.
 */
export function defaultToken(): string | undefined {
  const said = process.env[TOKEN_ENV]?.trim();
  if (said !== undefined && said !== '') return said;

  try {
    const held = readFileSync(defaultTokenFile(), 'utf-8').trim();

    return held === '' ? undefined : held;
  } catch {
    return undefined;
  }
}
