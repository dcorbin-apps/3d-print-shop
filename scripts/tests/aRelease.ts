import { expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Jest's own answer for where the running test is, because `import.meta` is not on in this transform
// and a path from the working directory would depend on where somebody ran the suite from.
const releaseSh = (): string => path.resolve(path.dirname(expect.getState().testPath ?? ''), '..', 'release.sh');

export interface Answer {
  stdout: string;
  stderr: string;
  status: number;
}

export interface Asked {
  env?: Record<string, string>;
  /** Run after the script is sourced, by which point every function is defined and none has run. */
  then: string;
}

// AIDEV-NOTE: SOURCED, so no release happens - the guard at the foot of release.sh holds `main` back
// when `$0` is not the script. Every shadow below is a thing that reaches the outside world: `curl`,
// `npm`, `yarn`, `git` and `sleep`. What is measured is what the script decided from the answers it
// got, which is the half that can be wrong without anybody noticing until a release is under way.

// AIDEV-NOTE: BOUNDED, because both subjects are `while true` loops and their only way out is a
// deadline. `execFileSync` blocks the jest worker, which jest's own timeout cannot interrupt - so
// without this a release.sh that lost its deadline hangs the suite instead of failing it, and a
// suite that hangs teaches people to kill it rather than read it. Found by a mutation run that sat
// for two minutes. Ten seconds is forty times the slowest of these.
const LONGER_THAN_ANY_OF_THESE_SHOULD_TAKE = 10_000;

export function asked({ env, then }: Asked): Answer {
  try {
    const stdout = execFileSync('bash', ['-c', `source "${releaseSh()}"\n${then}`], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: LONGER_THAN_ANY_OF_THESE_SHOULD_TAKE,
      killSignal: 'SIGKILL',
    });

    return { stdout, stderr: '', status: 0 };
  } catch (thrown) {
    const failure = thrown as { stdout?: string; stderr?: string; status?: number };

    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', status: failure.status ?? -1 };
  }
}

export interface Run {
  id: number;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

/** One run of the publish workflow, as the API lists it. */
export function aRun(of: Partial<Run> = {}): Run {
  return {
    id: 7,
    head_branch: 'v1.2.0',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-01-01T00:00:00Z',
    html_url: 'https://github.com/owner/repo/actions/runs/7',
    ...of,
  };
}

/** An `apiGet` that answers with these runs, and a `repoSlug` that needs no remote to be there. */
export function anApiListing(runs: Run[]): string {
  return anApiAnswering(JSON.stringify({ workflow_runs: runs }));
}

/** An `apiGet` that answers with exactly this, which is how a body that is not JSON is handed over. */
export function anApiAnswering(body: string): string {
  return `repoSlug() { echo owner/repo; }\napiGet() { cat <<'BODY'\n${body}\nBODY\n}`;
}

/**
 * A `publishRunFor` that says each of these in turn and then repeats the last, so a poll that has to
 * go round before it gets an answer can be read without waiting on anything.
 */
export function aRunSaying(inTurn: string[]): string {
  const counting = path.join(mkdtempSync(path.join(tmpdir(), 'release-')), 'turn');
  writeFileSync(counting, '0');

  const answers = inTurn.map((said) => `'${said}'`).join(' ');

  return [
    'publishRunFor() {',
    `  local turn answers=(${answers}) last`,
    `  turn=$(cat ${counting}); echo $((turn + 1)) > ${counting}`,
    '  last=$(( ${#answers[@]} - 1 ))',
    '  if [ "$turn" -gt "$last" ]; then turn=$last; fi',
    '  printf \'%s\\n\' "${answers[$turn]}"',
    '}',
  ].join('\n');
}

/** A registry where each of these packages has these versions, and anything else has none. */
export function aRegistryWith(versions: Record<string, string[]>): string {
  const cases = Object.entries(versions)
    .map(([name, said]) => `    ${name}) printf '%s' '${JSON.stringify(said)}' ;;`)
    .join('\n');

  return ['npm() {', '  case "$2" in', cases, "    *) printf '%s' '[]' ;;", '  esac', '}'].join('\n');
}

/**
 * A `resolvesAt` where these packages are up already and every other one turns up the second time it
 * is looked for - so a wait that has to go round before it is done can be read without waiting on a
 * registry to catch up.
 */
export function alreadyUp(packages: string[]): string {
  const seen = mkdtempSync(path.join(tmpdir(), 'registry-'));

  return [
    'resolvesAt() {',
    `  case "$1" in ${packages.join('|')}) return 0 ;; esac`,
    '  local looked',
    `  looked=${seen}/$(printf '%s' "$1" | tr -c 'a-zA-Z0-9' '_')`,
    '  if [ -f "$looked" ]; then return 0; fi',
    '  touch "$looked"',
    '  return 1',
    '}',
  ].join('\n');
}

/** A workspace listing of these packages, in the line-per-package JSON `yarn` answers with. */
export function aWorkspaceOf(packages: string[]): string {
  const lines = packages.map((name) => `'{"name":"${name}"}'`).join(' ');

  return `yarn() { printf '%s\\n' ${lines}; }`;
}

/** Nothing waits, so a poll that would take minutes is read in milliseconds. */
export const noWaiting = 'sleep() { :; }';
