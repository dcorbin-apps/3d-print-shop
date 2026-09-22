import { expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Jest's own answer for where the running test is, because `import.meta` is not on in this transform
// and a path from the working directory would depend on where somebody ran the suite from.
const installSh = (): string => path.resolve(path.dirname(expect.getState().testPath ?? ''), '..', 'install.sh');

/**
 * Where the PAGE sits relative to the server package, which is the whole of what npm varies. The
 * server itself is not a layout: install.sh ships inside it, so its build is always `$HERE/dist`.
 */
export type Layout = 'nested' | 'hoisted' | 'both' | 'neither' | 'checkout';

export interface Fixture {
  /** The directory the copied install.sh sits in - what `$HERE` becomes when it is sourced. */
  here: string;
  root: string;
}

export interface Shaped {
  engines?: string;
  /** No `dist` at all, which is what a package that arrived without its build looks like. */
  withoutTheBuild?: boolean;
}

/**
 * A tree with install.sh in it, shaped the way one of its callers would leave it. The script is
 * COPIED rather than linked, because `$HERE` is resolved through the link and a link would put every
 * fixture back in the source directory.
 */
export function aTreeWith(layout: Layout, { engines = '>=24.16 <25', withoutTheBuild = false }: Shaped = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'installer-'));
  const here = layout === 'checkout' ? path.join(root, 'packages', 'server') : path.join(root, 'node_modules', '@3d-print-shop', 'server');

  mkdirSync(here, { recursive: true });
  copyFileSync(installSh(), path.join(here, 'install.sh'));
  chmodSync(path.join(here, 'install.sh'), 0o755);
  writeFileSync(
    path.join(here, 'package.json'),
    JSON.stringify({ name: '@3d-print-shop/server', version: '1.2.3', engines: { node: engines } }, null, 2),
  );

  // The server's own build. One place in both modes, because in a checkout `$HERE` IS packages/server.
  if (!withoutTheBuild) {
    mkdirSync(path.join(here, 'dist'), { recursive: true });
    writeFileSync(path.join(here, 'dist', 'main.js'), '');
  }

  const pagesAt = {
    nested: [path.join(here, 'node_modules', '@3d-print-shop')],
    hoisted: [path.join(here, '..')],
    both: [path.join(here, 'node_modules', '@3d-print-shop'), path.join(here, '..')],
    checkout: [path.join(root, 'packages')],
    neither: [],
  }[layout];

  for (const beside of pagesAt) mkdirSync(path.join(beside, 'ui', 'dist'), { recursive: true });

  if (layout === 'checkout') writeFileSync(path.join(root, 'package.json'), JSON.stringify({ engines: { node: engines } }, null, 2));

  return { here, root };
}

/**
 * A link to the script from a directory on PATH, the way npm installs a bin: RELATIVE, from a
 * sibling of the tree - `bin/3d-print-shop-install -> ../node_modules/@3d-print-shop/server/install.sh`.
 * Named `from` another link instead, it is a link to a link, which is what a second bin directory
 * pointing at the first one looks like.
 */
export function aLinkTo({ here, root }: Fixture, named = 'bin', from?: string): string {
  const bin = path.join(root, named);
  const link = path.join(bin, '3d-print-shop-install');

  mkdirSync(bin, { recursive: true });
  symlinkSync(path.relative(bin, from ?? path.join(here, 'install.sh')), link);

  return link;
}

/** An executable that answers `-v` the way a node of that version would, and nothing else. */
export function aNodeSaying(version: string, at: string): string {
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, `#!/bin/sh\n[ "$1" = "-v" ] && echo "v${version}"\n`);
  chmodSync(at, 0o755);

  return at;
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
  /** The path the script is reached by, when it is not its own - a link, as npm puts one on PATH. */
  through?: string;
}

// AIDEV-NOTE: SOURCED, so nothing installs - the guard at the foot of install.sh holds `main` back
// when `$0` is not the script. Everything under test has been decided by the time `then` runs.
// `uname` is shadowed as a FUNCTION, which a command substitution inherits, so the platform this is
// running on decides nothing here - that is what lets the macOS half be read from Linux.

// AIDEV-NOTE: `spawnSync` and not `execFileSync`, because what is written to stderr matters even
// when the command SUCCEEDS - a step that works while complaining into a log is still wrong, and
// execFileSync hands stderr back only on a throw.
export function asked({ here }: Fixture, { platform, env, then, through }: Asked): Answer {
  const preamble = platform === undefined ? '' : `uname() { [ "$1" = "-s" ] && echo ${platform} || command uname "$@"; };\n`;

  const ran = spawnSync('bash', ['-c', `${preamble}source "${through ?? `${here}/install.sh`}"\n${then}`], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', status: ran.status ?? -1 };
}
