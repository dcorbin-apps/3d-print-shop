import { TOKEN_ENV, defaultTokenFile } from '@3d-print-shop/client';
import type { Role } from '@3d-print-shop/client';
import { addCaller, callersIn, issueToken, migrateCallers, setPassword } from './credentials.js';
import { askSecretlyTwice } from './prompt.js';

// AIDEV-NOTE: the operator's half of WHO, kept apart from the command line that calls it and
// answering with lines rather than printing - the same shape as printerAdmin.ts and jobAdmin.ts,
// and for the same reasons. Unlike those, these are not clients of a running shop: they write the
// file `serve` reads, because a shop cannot be asked to give somebody a way in that it does not yet
// answer. What they all end with is the same reminder, since a running shop is holding the old file.
const AND_SIGNAL = 'the shop re-reads this on SIGHUP - `kill -HUP <pid>`, `systemctl reload 3d-print-shop`, or `launchctl kill HUP system/com.dcorbin.3d-print-shop`';

/** A password, asked for twice, because nobody can see what they typed the first time. */
export async function askForANewPassword(asking = 'password: ', again = 'and again: '): Promise<string> {
  const [said, confirmed] = await askSecretlyTwice(asking, again);

  if (said !== confirmed) throw new Error('those are not the same password, and nothing was changed');

  return said;
}

/** Add somebody this shop may answer: a person with a password, or a machine with a token. */
export async function addSomebody(etc: string, id: string, name: string, role: Role, asAMachine: boolean): Promise<string[]> {
  const token = await addCaller(etc, id, name, role, asAMachine ? undefined : await askForANewPassword());

  if (token === undefined) return [`${name} is an ${role} of this shop, and logs in with the password you just set.`, '', AND_SIGNAL];

  return [`${name} is an ${role} of this shop.`, '', 'their token, written nowhere else and not shown again:', '', `  ${token}`, '', AND_SIGNAL];
}

/**
 * Set what somebody logs in with.
 *
 * Their tokens are left alone: a password is a person's and a token is a machine's, so changing one
 * is not a reason to go round every machine they slice with.
 */
export async function changePassword(etc: string, id: string): Promise<string[]> {
  await setPassword(etc, id, await askForANewPassword());

  return [`${id} has a new password.`, '', 'every browser logged in as them is logged out once the shop has re-read this.', '', AND_SIGNAL];
}

/** Issue another token, for another machine - said once here and stored as a digest. */
export async function giveAToken(etc: string, id: string): Promise<string[]> {
  const token = await issueToken(etc, id);

  return [
    `${id} has another token, written nowhere else and not shown again:`,
    '',
    `  ${token}`,
    '',
    `a client looks for it in ${TOKEN_ENV}, or in ${defaultTokenFile()}`,
    '',
    AND_SIGNAL,
  ];
}

// What a caller HAS rather than what it is, because "can this person log in" is the question an
// operator is actually asking, and the answer is not in a file they can read the secrets out of.
export async function listCallers(etc: string): Promise<string[]> {
  const known = (await callersIn(etc)).all();
  if (known.length === 0) return ['nobody - this shop would answer no one, and would refuse to start'];

  const widest = Math.max(...known.map(({ caller }) => caller.id.length));

  return known.map(({ caller, credentials }) => {
    const tokens = credentials.filter(({ kind }) => kind === 'token').length;
    const has = [
      credentials.some(({ kind }) => kind === 'password') ? 'a password' : 'no password',
      tokens === 1 ? '1 token' : `${tokens} tokens`,
    ];

    return `${caller.id.padEnd(widest)}  ${caller.role.padEnd(5)}  ${caller.name}  (${has.join(', ')})`;
  });
}

/** Turn a file of plaintext tokens into one of hashes, which is the one thing that reads the old shape. */
export async function migrateTheCallers(etc: string): Promise<string[]> {
  const hashed = await migrateCallers(etc);

  if (hashed === 0) return ['nothing to migrate - no token in that file is in the clear'];

  return [
    `${hashed === 1 ? '1 token is' : `${hashed} tokens are`} now stored as a digest rather than in the clear.`,
    '',
    'every one of them still works: what a client holds has not changed, only what the file remembers of it.',
    '',
    'nobody has a password yet - `3d-print-shop caller password <id>` is how somebody gets one.',
  ];
}
