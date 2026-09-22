import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { aNodeSaying, aTreeWith, asked } from './anInstaller.js';
import type { Answer } from './anInstaller.js';

// AIDEV-NOTE: (UT) every one of these. The script is SOURCED rather than run, so what is measured is
// what it decided and not what it did - no root, no system user, nothing written outside a tmpdir.
// Bash is the language these decisions are written in, the same way node is for every other suite
// here; sourcing one is not launching a subject any more than importing a module is.
describe('what the installer decides before it does anything', () => {
  describe('where the code it is installing actually is', () => {
    // AIDEV-NOTE: the case that sent a global install into refusing itself. npm nests a global
    // install's dependencies under the package rather than hoisting them into the scope directory.
    it('finds a server npm nested under the package, which is what a global install leaves', () => {
      const tree = aTreeWith('nested');

      expect(asked(tree, { then: 'echo "$BUILT"' }).stdout.trim()).toBe(path.join(tree.here, 'node_modules/@3d-print-shop/server/dist/main.js'));
    });

    it('finds a server hoisted beside the package, which is what a local install leaves', () => {
      const tree = aTreeWith('hoisted');

      // Resolved, because the script keeps the `..` it built the path out of and `path.join` does not.
      expect(path.resolve(asked(tree, { then: 'echo "$BUILT"' }).stdout.trim())).toBe(path.resolve(tree.here, '../server/dist/main.js'));
    });

    // AIDEV-NOTE: the case that tells the two candidates apart, and the only one that can. Where the
    // server is nested ALONE, the fallback `packagedAt` ends on names the nested path too, so looking
    // there first and not looking at all are indistinguishable - a mutation run proved it by dropping
    // that candidate and staying green. With both present, only the order decides, and the nested one
    // has to win: it is what npm made for THIS package, where a hoisted one belongs to whoever is
    // above it.
    it('prefers the nested server to a hoisted one when both are there', () => {
      const tree = aTreeWith('both');

      expect(asked(tree, { then: 'echo "$BUILT"' }).stdout.trim()).toBe(path.join(tree.here, 'node_modules/@3d-print-shop/server/dist/main.js'));
    });

    it('resolves to a server that is really on the disk, and not merely to a plausible path', () => {
      expect(asked(aTreeWith('nested'), { then: 'test -f "$BUILT" && echo found' }).stdout.trim()).toBe('found');
      expect(asked(aTreeWith('hoisted'), { then: 'test -f "$BUILT" && echo found' }).stdout.trim()).toBe('found');
    });

    it('finds the page by the same two routes as the server', () => {
      expect(asked(aTreeWith('nested'), { then: 'echo "$BUILT_PAGE"' }).stdout.trim()).toMatch(/node_modules\/@3d-print-shop\/ui\/dist$/);
      expect(asked(aTreeWith('hoisted'), { then: 'echo "$BUILT_PAGE"' }).stdout.trim()).toMatch(/installer\/\.\.\/ui\/dist$/);
    });

    it('names the nested place when the server is in neither, because that is where npm would have put it', () => {
      const refused = asked(aTreeWith('neither'), { then: 'requireBuild' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('node_modules/@3d-print-shop/server/dist/main.js');
      expect(refused.stderr).toContain('is not installed beside this');
    });

    it('reads a checkout as a checkout, and points the service at the copy rather than at the build', () => {
      const tree = aTreeWith('checkout');
      const said = asked(tree, { then: 'echo "$MODE"; echo "$BUILT"; echo "$SERVER"' }).stdout.trim().split('\n');

      expect(said[0]).toBe('checkout');
      expect(said[1]).toBe(path.join(tree.root, 'packages/server/dist/main.js'));
      expect(said[2]).toBe('/usr/local/lib/3d-print-shop/packages/server/dist/main.js');
    });

    it('tells a checkout to build rather than to install a package, because that is the remedy it has', () => {
      const refused = asked(aTreeWith('neither'), { then: 'MODE=checkout; REPO=/somewhere; BUILT=/somewhere/nothing.js; requireBuild' });

      expect(refused.stderr).toContain("run 'yarn install && yarn build'");
    });
  });

  describe('the node floor it holds a machine to', () => {
    it('reads the floor out of the manifest in play rather than saying one of its own', () => {
      expect(asked(aTreeWith('nested', '>=24.16 <25'), { then: 'requiredNode' }).stdout.trim()).toBe('24.16');
      expect(asked(aTreeWith('nested', '>=22.3 <23'), { then: 'requiredNode' }).stdout.trim()).toBe('22.3');
    });

    // A floor that came back empty would let every node past, which is the guard silently not being one.
    it('refuses a manifest that declares no floor at all', () => {
      const refused = asked(aTreeWith('nested', ''), { then: 'requiredNode' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('does not say which node this runs on');
    });

    it('compares versions by number and not by text', () => {
      expect(asked(aTreeWith('nested'), { then: 'isAtLeast 24.9.0 24.16 && echo yes || echo no' }).stdout.trim()).toBe('no');
      expect(asked(aTreeWith('nested'), { then: 'isAtLeast 24.21.0 24.16 && echo yes || echo no' }).stdout.trim()).toBe('yes');
    });
  });

  describe('the node it will point the service at', () => {
    // AIDEV-NOTE: the three below are written as a CONTRAST rather than as three refusals, and the
    // reason is that `findNode` searches absolute paths - /opt/homebrew, /usr/local, /usr/bin - that
    // a test cannot empty without a container. Whether this machine has a node of its own therefore
    // decides whether the search refuses or merely moves on, so what is asserted is the part that is
    // true on any machine: the one it was handed is taken when it qualifies, and is NOT taken when
    // it does not. Remove either rule from the script and the pair disagrees.
    it('takes the one it was handed, over anything it would have searched for', () => {
      const tree = aTreeWith('nested');
      const node = aNodeSaying('24.21.0', path.join(tree.root, 'elsewhere/bin/node'));

      expect(asked(tree, { env: { PRINT_SHOP_NODE: node }, then: 'findNode 24.16' }).stdout.trim()).toBe(node);
    });

    // The node a developer has is exactly this one - a version manager installs per user, and the
    // service runs as somebody who cannot read there.
    it('will not take a node under a home directory, however new it is', () => {
      const tree = aTreeWith('nested');
      const home = path.join(tree.root, 'home');
      const node = aNodeSaying('24.21.0', path.join(home, '.nvm/bin/node'));

      const answer = asked(tree, { env: { HOME: home, PRINT_SHOP_NODE: node }, then: 'findNode 24.16' });

      expect(answer.stdout.trim()).not.toBe(node);
    });

    it('will not take one that is older than the floor', () => {
      const tree = aTreeWith('nested');
      const node = aNodeSaying('22.17.0', path.join(tree.root, 'elsewhere/bin/node'));

      expect(asked(tree, { env: { PRINT_SHOP_NODE: node }, then: 'findNode 24.16' }).stdout.trim()).not.toBe(node);
    });

    // A floor nothing can meet is how the refusal itself is reached on a machine that has a node.
    it('refuses when nothing qualifies, saying what it found and how to say otherwise', () => {
      const tree = aTreeWith('nested');
      const node = aNodeSaying('22.17.0', path.join(tree.root, 'elsewhere/bin/node'));

      const refused = asked(tree, { env: { PRINT_SHOP_NODE: node }, then: 'findNode 99.0' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('no node of 99.0 or newer');
      expect(refused.stderr).toContain('(v22.17.0)');
      expect(refused.stderr).toContain('PRINT_SHOP_NODE=/path/to/node');
    });
  });

  // AIDEV-NOTE: load-bearing and invisible - npm fails the WHOLE install on a non-zero postinstall,
  // so a person who has not used sudo has to be told what to type rather than shouted at.
  describe('what it does inside npm, where it may not fail', () => {
    it('exits nothing but zero when it was unpacked without root, and says what is left to type', () => {
      const answer = asked(aTreeWith('nested'), { then: 'main from-npm' });

      expect(answer.status).toBe(0);
      expect(answer.stdout).toContain('sudo 3d-print-shop-install');
    });

    it('does nothing at all from a checkout, where nobody asked for a daemon', () => {
      const answer = asked(aTreeWith('checkout'), { then: 'main from-npm; echo "said nothing"' });

      expect(answer.status).toBe(0);
      expect(answer.stdout.trim()).toBe('');
    });
  });

  // AIDEV-NOTE: `chown` and `chmod` are shadowed, because they need root and are not what is claimed
  // here - the claim is the TEXT, and what the supervisor is told to run is readable without owning
  // the file. The platform is forced by shadowing `uname`, so both halves are read from either
  // machine; CI runs Linux only, and the macOS half is the one with an open bug against it.
  describe('what it tells the supervisor to run', () => {
    const rendered = (platform: 'Darwin' | 'Linux', into: string, call: string): Answer =>
      asked(aTreeWith('nested'), {
        platform,
        then: `chown() { :; }; chmod() { :; }; ${into}; ${call} /usr/bin/node >/dev/null; cat "$${into.split('=')[0] ?? ''}"`,
      });

    it('names the node, the server and the page in the systemd unit', () => {
      const unit = rendered('Linux', 'UNIT=$(mktemp)', 'wroteUnit').stdout;

      expect(unit).toContain('ExecStart=/usr/bin/node ');
      expect(unit).toContain('/server/dist/main.js serve --page ');
      expect(unit).toContain('User=printshop');
      expect(unit).toContain('Restart=on-failure');
    });

    it('names the same three in the launchd plist', () => {
      const plist = rendered('Darwin', 'PLIST=$(mktemp)', 'wrotePlist').stdout;

      expect(plist).toContain('<string>/usr/bin/node</string>');
      expect(plist).toContain('<string>--page</string>');
      expect(plist).toContain('<key>UserName</key><string>_printshop</string>');
    });

    // The page is not optional: an install that served nobody anything once looked like a good one.
    it('always says which page to serve, on both', () => {
      expect(rendered('Linux', 'UNIT=$(mktemp)', 'wroteUnit').stdout).toContain('--page');
      expect(rendered('Darwin', 'PLIST=$(mktemp)', 'wrotePlist').stdout).toContain('--page');
    });
  });
});
