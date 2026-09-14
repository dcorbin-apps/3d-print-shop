import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// AIDEV-NOTE: the tag says which version is being released and the manifests say which version will
// actually go to the registry. Nothing keeps the two in step, so a tag pushed without the bump
// publishes the version before it under the new tag's name - and npm will not let that be corrected,
// because a version number is spent the moment it is used. A minute here against a number that
// cannot be reused.
const tag = (process.argv[2] ?? '').replace(/^v/, '');
if (tag === '') {
  console.error('which tag? - pass it, as in `node scripts/tag-matches-manifests.mjs v1.0.1`');
  process.exit(2);
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
  console.error(`the tag says ${tag}, and these do not:`);
  for (const { name, version } of wrong) console.error(`  ${name} is ${version}`);
  console.error('\nbump them, commit, and move the tag onto that commit.');
  process.exit(1);
}

console.log(`every package says ${tag}, which is what the tag says`);
