import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// AIDEV-NOTE: the tag says which version is being released and the manifests say which version will
// actually go to the registry. Nothing keeps the two in step, so a tag pushed without the bump
// publishes the version before it under the new tag's name - and npm will not let that be corrected,
// because a version number is spent the moment it is used. A minute here against a number that
// cannot be reused.
// AIDEV-NOTE: said TWICE when a runner is listening, and the second one is not decoration. GitHub
// builds the annotation on a failure screen from the runner's own `##[error]`, and a plain `run:`
// step contributes none - so everything below reaches the step log and the summary shows
// `Process completed with exit code 1` and nothing else. A workflow command is the only way a
// script puts its own words where somebody reads them first. Local output is unchanged.
const ANNOTATES = process.env.GITHUB_ACTIONS === 'true';

// Percent FIRST, or the escapes introduced by the two after it are escaped in turn.
const forAnAnnotation = (text) => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function refuse(title, lines, code) {
  for (const line of lines) console.error(line);
  if (ANNOTATES) console.log(`::error title=${title}::${forAnAnnotation(lines.join('\n'))}`);

  process.exit(code);
}

const tag = (process.argv[2] ?? '').replace(/^v/, '');
if (tag === '') {
  refuse('No tag to check against', ['which tag? - pass it, as in `node scripts/tag-matches-manifests.mjs v1.0.1`'], 2);
}

const listed = execFileSync('yarn', ['workspaces', 'list', '--no-private', '--json'], { encoding: 'utf-8' });
const packages = listed
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const wrong = packages
  .map(({ name, location }) => ({ name, version: JSON.parse(readFileSync(`${location}/package.json`, 'utf-8')).version }))
  .filter(({ version }) => version !== tag);

if (wrong.length > 0) {
  refuse(
    'The tag and the manifests disagree',
    [
      `the tag says ${tag}, and these do not:`,
      ...wrong.map(({ name, version }) => `  ${name} is ${version}`),
      '',
      'bump them, commit, and move the tag onto that commit.',
    ],
    1,
  );
}

console.log(`every package says ${tag}, which is what the tag says`);
