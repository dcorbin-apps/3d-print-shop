import { expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Jest's own answer for where the running test is, because `import.meta` is not on in this transform
// and a path from the working directory would depend on where somebody ran the suite from.
const installSh = (): string => path.resolve(path.dirname(expect.getState().testPath ?? ''), '..', 'install.sh');

/** Where the server and the page sit relative to the installer, which is the whole of what npm varies. */
export type Layout = 'nested' | 'hoisted' | 'both' | 'neither' | 'checkout';

export interface Fixture {
  /** The directory the copied install.sh sits in - what `$HERE` becomes when it is sourced. */
  here: string;
  root: string;
}

/**
 * A tree with install.sh in it, shaped the way one of its callers would leave it. The script is
 * COPIED rather than linked, because `$HERE` is resolved through the link and a link would put every
 * fixture back in the source directory.
 */
export function aTreeWith(layout: Layout, engines = '>=24.16 <25'): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'installer-'));
  const here = layout === 'checkout' ? path.join(root, 'packages', 'installer') : path.join(root, 'node_modules', '@3d-print-shop', 'installer');

  mkdirSync(here, { recursive: true });
  copyFileSync(installSh(), path.join(here, 'install.sh'));
  chmodSync(path.join(here, 'install.sh'), 0o755);
  writeFileSync(path.join(here, 'package.json'), JSON.stringify({ name: '@3d-print-shop/installer', engines: { node: engines } }, null, 2));

  const nested = path.join(here, 'node_modules', '@3d-print-shop');
  const hoisted = path.join(here, '..');
  const besides = {
    nested: [nested],
    hoisted: [hoisted],
    both: [nested, hoisted],
    checkout: [path.join(root, 'packages')],
    neither: [],
  }[layout];

  for (const beside of besides) {
    mkdirSync(path.join(beside, 'server', 'dist'), { recursive: true });
    writeFileSync(path.join(beside, 'server', 'dist', 'main.js'), '');
    mkdirSync(path.join(beside, 'ui', 'dist'), { recursive: true });
  }

  if (layout === 'checkout') writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: engines } }, null, 2));

  return { here, root };
}

/** An `$ETC` holding a credentials file, which is what a shop somebody has already run `init` on has. */
export function anEtcWithCallers({ root }: Fixture): string {
  const etc = path.join(root, 'etc-with-callers');

  mkdirSync(etc, { recursive: true });
  writeFileSync(path.join(etc, 'callers.json'), '{}');

  return etc;
}

/** An `$ETC` with nothing in it, which is a machine the shop has never been initialised on. */
export function anEmptyEtc({ root }: Fixture): string {
  return path.join(root, 'etc-with-nothing');
}

/** An executable that answers `-v` the way a node of that version would, and nothing else. */
export function aNodeSaying(version: string, at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `#!/bin/sh\n[ "$1" = "-v" ] && echo "v${version}"\n`);
  chmodSync(at, 0o755);

  return at;
}

export interface Answer {
  stdout: string;
  stderr: string;
  status: number;
}

export interface Asked {
  /** Forces the platform, by answering `uname` before the script reads it. */
  platform?: 'Darwin' | 'Linux';
  env?: Record<string, string>;
  /** Run after the script is sourced, by which point every decision is made and nothing is written. */
  then: string;
}

// AIDEV-NOTE: SOURCED, so nothing installs - the guard at the foot of install.sh holds `main` back
// when `$0` is not the script. Everything under test has been decided by the time `then` runs.
// `uname` is shadowed as a FUNCTION, which a command substitution inherits, so the platform this is
// running on decides nothing here - that is what lets the macOS half be read from Linux.
export function asked({ here }: Fixture, { platform, env, then }: Asked): Answer {
  const preamble = platform === undefined ? '' : `uname() { [ "$1" = "-s" ] && echo ${platform} || command uname "$@"; };\n`;

  try {
    const stdout = execFileSync('bash', ['-c', `${preamble}source "${here}/install.sh"\n${then}`], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { stdout, stderr: '', status: 0 };
  } catch (thrown) {
    const failure = thrown as { stdout?: string; stderr?: string; status?: number };

    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', status: failure.status ?? -1 };
  }
}
