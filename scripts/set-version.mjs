import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// AIDEV-NOTE: every manifest at once, because a release where four packages agree and one does not
// is the thing `tag-matches-manifests.mjs` refuses - and a person editing five files by hand is how
// that happens. The root is bumped too although it is `private: true` and nothing publishes it: it
// is the version somebody reads when they ask what this repository is, and a root that says 1.0.0
// while the packages say 1.2.0 is a second answer to that question.
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (version === '') {
  console.error('which version? - pass it, as in `node scripts/set-version.mjs 1.1.0`');
  process.exit(2);
}

const listed = execFileSync('yarn', ['workspaces', 'list', '--json'], { encoding: 'utf-8' });
const locations = listed
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line).location);

// AIDEV-NOTE: parsed and re-stringified at two spaces, which is what prettier writes here - so
// `yarn format` passes on what this leaves behind rather than on a second pass somebody has to
// remember. Key order survives a round trip, so `version` stays where a reader expects it.
for (const location of locations) {
  const manifest = `${location}/package.json`;
  const said = JSON.parse(readFileSync(manifest, 'utf-8'));

  if (said.version === version) {
    console.log(`${said.name} already says ${version}`);
    continue;
  }

  console.log(`${said.name} ${said.version} -> ${version}`);
  said.version = version;
  writeFileSync(manifest, `${JSON.stringify(said, null, 2)}\n`);
}
