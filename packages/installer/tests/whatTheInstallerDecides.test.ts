import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { aNodeSaying, aTreeWith, anEmptyEtc, anEtcWithCallers, asked } from './anInstaller.js';
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

    // AIDEV-NOTE: this package is never npm's ROOT package, and npm hides a dependency's postinstall
    // output while handing it a pipe for stdin. So the terminal is taken before a word is said -
    // otherwise the install says nothing anybody can read and asks nothing anybody can answer, which
    // is exactly how a shop that stopped short of its first admin looked like a shop that installed
    // and simply did not run.
    it('takes the controlling terminal before it says anything, because npm is holding the pen', () => {
      const answer = asked(aTreeWith('nested'), { then: 'tookTheTerminal() { echo TOOK; }; main from-npm' });

      expect(answer.stdout).toContain('TOOK');
      expect(answer.stdout.indexOf('TOOK')).toBeLessThan(answer.stdout.indexOf('3d-print-shop is unpacked'));
    });

    // npm fails the whole install on a non-zero postinstall, so no terminal is a thing to carry on past.
    it('carries on where there is no terminal to take, rather than failing the install over it', () => {
      const answer = asked(aTreeWith('nested'), { then: 'tookTheTerminal() { return 1; }; main from-npm' });

      expect(answer.status).toBe(0);
      expect(answer.stdout).toContain('sudo 3d-print-shop-install');
    });

    // AIDEV-NOTE: the terminal is LOOKED FOR before it is taken, and this is what needs that. Taking
    // one that is not there works out the same way - the redirect fails and nothing is taken - but it
    // fails loudly, and the log it complains into is the npm install of somebody who did nothing
    // wrong. Asked for rather than attempted, so a machine with no terminal installs in silence.
    it('reports no terminal when there is no controlling one to open, and says nothing about it', () => {
      const answer = asked(aTreeWith('nested'), { then: 'tookTheTerminal && echo took || echo none' });

      expect(answer.stdout.trim()).toBe('none');
      expect(answer.stderr).toBe('');
    });
  });

  // AIDEV-NOTE: (UT) a shop with no callers refuses to start, so the installer either makes one or
  // stops - and which it does turns on whether there is anybody at a terminal to ask. `sudo` is
  // shadowed rather than allowed to run: the claim is which command it decided on and who it decided
  // to run it as, and reading that does not need a system user or a password typed into anything.
  describe('the first admin, without which it will not start', () => {
    const noticingSudo = 'sudo() { echo "sudo $*"; }';
    const aTerminal = 'atATerminal() { true; }';
    const noTerminal = 'atATerminal() { false; }';

    // What npm's postinstall hands it, and the reason the prompt is behind a gate at all.
    it('finds no terminal when stdin is not one', () => {
      expect(asked(aTreeWith('nested'), { then: 'atATerminal && echo terminal || echo none' }).stdout.trim()).toBe('none');
    });

    it('asks nobody anything when the shop has callers already, and goes straight on to starting it', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, {
        then: `ETC=${anEtcWithCallers(tree)}; ${aTerminal}; ${noticingSudo}; gotItsFirstAdmin /usr/bin/node && echo start`,
      });

      expect(answer.stdout.trim()).toBe('start');
    });

    it('makes one as the user the service runs as, because the credentials directory is theirs', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, {
        platform: 'Linux',
        env: { SUDO_USER: 'dcorbin' },
        then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${noticingSudo}; gotItsFirstAdmin /usr/bin/node && echo start`,
      });

      expect(answer.stdout).toContain('sudo -u printshop /usr/bin/node ');
      expect(answer.stdout).toContain('/server/dist/main.js init dcorbin');
      expect(answer.stdout).toContain('start');
    });

    it('calls them whoever ran the sudo, and admin where nobody did', () => {
      const tree = aTreeWith('nested');
      const made = (who: string): string =>
        asked(tree, { env: { SUDO_USER: who }, then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${noticingSudo}; madeTheFirstAdmin /usr/bin/node` })
          .stdout;

      expect(made('dcorbin')).toContain('init dcorbin');
      expect(made('')).toContain('init admin');
    });

    // The machine that calls this shop need not be the machine it was installed on, so the token is
    // placed by hand - and the moment it is on the screen is the only moment it can be read.
    it('says where the token goes once it has shown it, and never writes it anywhere itself', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, { then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${noticingSudo}; madeTheFirstAdmin /usr/bin/node` });

      expect(answer.stdout).toContain('~/.config/3d-print-shop/token');
      expect(answer.stdout).toContain('That token is the only copy');
    });

    // AIDEV-NOTE: npm owns stdin, so a prompt there waits for an answer nobody can give - inside an
    // install whose output nobody is watching. Stopping with the two commands is the whole reason.
    it('stops and says what is left to type when there is nobody to ask', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, { then: `ETC=${anEmptyEtc(tree)}; ${noTerminal}; gotItsFirstAdmin /usr/bin/node || echo stopped` });

      expect(answer.stdout).toContain('Installed, and not started');
      expect(answer.stdout).toContain('init <your-name>');
      expect(answer.stdout).toContain('stopped');
    });

    it('stops rather than starting a shop whose admin was not made after all', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, {
        then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; sudo() { return 1; }; gotItsFirstAdmin /usr/bin/node || echo stopped`,
      });

      expect(answer.stdout).toContain('Installed, and not started');
      expect(answer.stdout).toContain('stopped');
      expect(answer.stdout).not.toContain('That token is the only copy');
    });

    // AIDEV-NOTE: `install` is not reachable by sourcing on its own - every step of it wants root or
    // writes outside a tmpdir - so the steps are shadowed and what is left is the only thing these
    // two are about: whether it goes on to start a service. Nothing else guarded that wiring; a
    // mutation that dropped the refusal entirely stayed green until these were written.
    const withoutTheStepsThatWantRoot = [
      'requireRoot() { :; }',
      'requireBuild() { :; }',
      'requirePage() { :; }',
      'requiredNode() { echo 24.16; }',
      'findNode() { echo /usr/bin/node; }',
      'madeServiceUserOnLinux() { :; }',
      'madeDirectory() { :; }',
      'stopIt() { :; }',
      'wroteUnit() { :; }',
      'startIt() { echo STARTED; }',
    ].join('; ');

    it('starts the service once the shop has somebody it may answer', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, { platform: 'Linux', then: `ETC=${anEtcWithCallers(tree)}; ${withoutTheStepsThatWantRoot}; install` });

      expect(answer.stdout).toContain('STARTED');
      expect(answer.stdout).toContain('Installed and running');
    });

    it('starts nothing at all where it stopped short of an admin, rather than leaving one restarting for ever', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, { platform: 'Linux', then: `ETC=${anEmptyEtc(tree)}; ${withoutTheStepsThatWantRoot}; ${noTerminal}; install` });

      expect(answer.stdout).toContain('Installed, and not started');
      expect(answer.stdout).not.toContain('STARTED');
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
