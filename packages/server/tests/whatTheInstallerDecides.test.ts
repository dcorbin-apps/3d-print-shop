import { describe, it, expect } from '@jest/globals';
import * as path from 'node:path';
import { aLinkTo, aNodeSaying, aTreeWith, anEmptyEtc, anEtcWithCallers, asked } from './anInstaller.js';
import type { Answer } from './anInstaller.js';

// AIDEV-NOTE: (UT) every one of these. The script is SOURCED rather than run, so what is measured is
// what it decided and not what it did - no root, no system user, nothing written outside a tmpdir.
// Bash is the language these decisions are written in, the same way node is for every other suite
// here; sourcing one is not launching a subject any more than importing a module is.
describe('what the installer decides before it does anything', () => {
  // AIDEV-NOTE: `install` is not reachable by sourcing on its own - every step of it wants root or
  // writes outside a tmpdir - so those steps are shadowed, and what is left is the wiring between
  // them: whether it goes on to start a service, and what it hands the service to run with. Nothing
  // else guarded that wiring; a mutation that dropped the refusal to start stayed green until the
  // first of these were written. `wroteUnit` says what it was given rather than writing a file.
  const withoutTheStepsThatWantRoot = [
    'requireRoot() { :; }',
    'requireBuild() { :; }',
    'requirePage() { :; }',
    'requiredNode() { echo 24.16; }',
    'findNode() { echo /usr/bin/node; }',
    'madeServiceUserOnLinux() { :; }',
    'madeDirectory() { :; }',
    'stopIt() { :; }',
    'wroteUnit() { echo "WROTE listen=[$LISTEN]"; }',
    'startIt() { echo STARTED; }',
  ].join('; ');

  describe('where the code it is installing actually is', () => {
    // AIDEV-NOTE: install.sh ships INSIDE the server package now, so the server is not hunted for at
    // all - `$HERE` is the package and its dist is the only build that can be the right one. This
    // replaced a search of two candidate paths, which existed only because the script used to live
    // in a package of its own beside the one it was installing.
    it('runs the build it ships inside, rather than looking for one beside it', () => {
      const tree = aTreeWith('nested');
      const said = asked(tree, { then: 'echo "$BUILT"; echo "$SERVER"' }).stdout.trim().split('\n');

      expect(said[0]).toBe(path.join(tree.here, 'dist/main.js'));
      expect(said[1]).toBe(said[0]);
    });

    // AIDEV-NOTE: the way anybody actually runs it. npm installs the bin as a relative SYMLINK, and
    // the script used to take the link's directory for its own - /usr/bin, read as a checkout rooted
    // at /, which refused the first install ever typed by name. Every test before this sourced the
    // file directly, so none of them could see it.
    it('finds itself through the link npm puts on PATH, rather than where the link sits', () => {
      const tree = aTreeWith('hoisted');
      const said = asked(tree, { through: aLinkTo(tree), then: 'echo "$MODE"; echo "$BUILT"' })
        .stdout.trim()
        .split('\n');

      expect(said[0]).toBe('package');
      expect(said[1]).toBe(path.join(tree.here, 'dist/main.js'));
    });

    it('follows a link to a link all the way to the script', () => {
      const tree = aTreeWith('hoisted');
      const twice = aLinkTo(tree, 'local/bin', aLinkTo(tree));

      expect(asked(tree, { through: twice, then: 'echo "$HERE"' }).stdout.trim()).toBe(tree.here);
    });

    it('resolves to a build that is really on the disk, and not merely to a plausible path', () => {
      expect(asked(aTreeWith('nested'), { then: 'test -f "$BUILT" && echo found' }).stdout.trim()).toBe('found');
    });

    it('tells a package with no build to install itself again, which is the remedy it has', () => {
      const refused = asked(aTreeWith('nested', { withoutTheBuild: true }), { then: 'requireBuild' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('installed without its build');
      expect(refused.stderr).toContain('sudo npm i -g @3d-print-shop/server@1.2.3');
    });

    // AIDEV-NOTE: npm nests a global install's dependencies under the installed package rather than
    // hoisting them into the scope directory, so the page is at `server/node_modules/@3d-print-shop/ui`
    // and not at `server/../ui`. A local install hoists and gives the second shape. Both are real.
    it('finds a page npm nested under the server, which is what a global install leaves', () => {
      const tree = aTreeWith('nested');

      expect(asked(tree, { then: 'echo "$BUILT_PAGE"' }).stdout.trim()).toBe(path.join(tree.here, 'node_modules/@3d-print-shop/ui/dist'));
    });

    it('finds a page hoisted beside the server, which is what a local install leaves', () => {
      const tree = aTreeWith('hoisted');

      // Resolved, because the script keeps the `..` it built the path out of and `path.join` does not.
      expect(path.resolve(asked(tree, { then: 'echo "$BUILT_PAGE"' }).stdout.trim())).toBe(path.resolve(tree.here, '../ui/dist'));
    });

    // AIDEV-NOTE: the case that tells the two candidates apart, and the only one that can. Where the
    // page is nested ALONE, the fallback `packagedAt` ends on names the nested path too, so looking
    // there first and not looking at all are indistinguishable - a mutation run proved it by dropping
    // that candidate and staying green. With both present, only the order decides, and the nested one
    // has to win: it is what npm made for THIS package, where a hoisted one belongs to whoever is
    // above it.
    it('prefers the nested page to a hoisted one when both are there', () => {
      const tree = aTreeWith('both');

      expect(asked(tree, { then: 'echo "$BUILT_PAGE"' }).stdout.trim()).toBe(path.join(tree.here, 'node_modules/@3d-print-shop/ui/dist'));
    });

    // AIDEV-NOTE: the server does not depend on the page - the page is a client of the shop - so a
    // missing one is installed beside it BY NAME, and at the server's own version, since a page from
    // another release is one that will complain about the shop it finds itself served by.
    it('names the page package to install beside it, at its own version, when there is no page', () => {
      const refused = asked(aTreeWith('neither'), { then: 'requirePage' });

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('node_modules/@3d-print-shop/ui/dist');
      expect(refused.stderr).toContain('sudo npm i -g @3d-print-shop/ui@1.2.3');
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
      expect(asked(aTreeWith('nested', { engines: '>=24.16 <25' }), { then: 'requiredNode' }).stdout.trim()).toBe('24.16');
      expect(asked(aTreeWith('nested', { engines: '>=22.3 <23' }), { then: 'requiredNode' }).stdout.trim()).toBe('22.3');
    });

    // AIDEV-NOTE: the SHIPPED manifests, not a fixture's. Every fixture writes its own engines, so the
    // server's package.json having none at all was invisible until the first install read it on a
    // Pi. A package install reads the server's and a checkout install reads the root's, and a machine
    // should be held to the same node whichever way it was set up.
    it('holds a package install to the same floor as a checkout, from the manifests that actually ship', () => {
      const shipped = (relative: string): string => path.resolve(path.dirname(expect.getState().testPath ?? ''), relative);
      const floorIn = (manifest: string): string => asked(aTreeWith('nested'), { then: `MANIFEST="${manifest}"; requiredNode` }).stdout.trim();

      expect(floorIn(shipped('../package.json'))).toMatch(/^\d+\.\d+/);
      expect(floorIn(shipped('../package.json'))).toBe(floorIn(shipped('../../../package.json')));
    });

    // A floor that came back empty would let every node past, which is the guard silently not being one.
    it('refuses a manifest that declares no floor at all', () => {
      const refused = asked(aTreeWith('nested', { engines: '' }), { then: 'requiredNode' });

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
  // AIDEV-NOTE: there was a `from-npm` word here once, which a postinstall hook called. It is gone
  // along with the hook: npm holds stdin and swallows stdout of a dependency's postinstall, so an
  // install that stopped short to ask something looked like an install that did nothing. Setting a
  // machine up is a command somebody types now. See PLAN.md, Installation.
  describe('what it refuses to be', () => {
    it('is a command somebody types, and not a hook something else runs', () => {
      const answer = asked(aTreeWith('nested'), { then: 'main from-npm' });

      expect(answer.status).not.toBe(0);
      expect(answer.stderr).toContain('install|update|uninstall');
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

    // AIDEV-NOTE: a key reaches the shop with its printer, from the page, and the running shop writes
    // the file. Telling somebody finishing an install to write it by hand was left over from before
    // the API took keys, and contradicted the file having one writer.
    it('does not send anybody to write a printer key by hand to finish installing', () => {
      const tree = aTreeWith('nested');

      expect(asked(tree, { then: `ETC=${anEmptyEtc(tree)}; ${noTerminal}; gotItsFirstAdmin /usr/bin/node` }).stdout).not.toContain(
        'printer-keys',
      );
    });

    // `init` counted in a file, because each call to the shadow is a subshell's and a variable would not
    // survive it. Refuses this many times, then takes what it is given.
    const refusing = (times: number): string =>
      `COUNT=$(mktemp); echo 0 > "$COUNT"; sudo() { local n; n=$(cat "$COUNT"); echo $((n + 1)) > "$COUNT"; echo "sudo $*"; [ "$n" -ge ${times} ]; }`;

    // AIDEV-NOTE: what `init` refuses is what was TYPED - two passwords that differ, or one too short -
    // and it has said which, one line up. Giving up printed a page of manual steps that buried that
    // line, which is what the first real install on a Pi ran into.
    it('asks again when what was typed is refused, and starts once it is taken', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, {
        then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${refusing(1)}; gotItsFirstAdmin /usr/bin/node && echo start`,
      });

      expect(answer.stdout).toContain('the reason is just above. Once more:');
      expect(answer.stdout.match(/ init /g)).toHaveLength(2);
      expect(answer.stdout).toContain('start');
    });

    // Bounded, because ctrl-C at init's prompt is a refusal too, and somebody who meant to stop should
    // not be asked for ever.
    it('stops asking after three, and starts nothing', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, {
        then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${refusing(99)}; gotItsFirstAdmin /usr/bin/node || echo stopped`,
      });

      expect(answer.stdout.match(/ init /g)).toHaveLength(3);
      expect(answer.stdout).toContain('stopped');
      expect(answer.stdout).not.toContain('That token is the only copy');
    });

    // The rest is already in place, so what is left is to be asked again - not to be handed the
    // commands for doing by hand what running this again would do.
    it('says to run it again when it gives up, rather than setting out the steps to do by hand', () => {
      const tree = aTreeWith('nested');
      const answer = asked(tree, { then: `ETC=${anEmptyEtc(tree)}; ${aTerminal}; ${refusing(99)}; gotItsFirstAdmin /usr/bin/node` });

      expect(answer.stdout).toContain('No admin was made, so the shop was not started');
      expect(answer.stdout).toContain('sudo 3d-print-shop-install install');
      expect(answer.stdout).not.toContain('Installed, and not started');
    });

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
  // AIDEV-NOTE: loopback is the shop's default because a password or a token sent to it travels in
  // the clear, and a Pi in a workshop is reached from other machines. So the address is the
  // operator's to say, it is said where the consequence is, and it survives a re-install that does
  // not say it again - re-running this is meant to be safe, and quietly closing a shop the workshop
  // reaches is not.
  describe('where it answers', () => {
    const readingArguments = (line: string): { said: string; status: number; stderr: string } => {
      const answer = asked(aTreeWith('nested'), { then: `readArguments ${line}; echo "$COMMAND [$LISTEN]"` });

      return { said: answer.stdout.trim(), status: answer.status, stderr: answer.stderr };
    };

    it('takes an address with or without naming the command, and in either spelling', () => {
      expect(readingArguments('--listen 0.0.0.0').said).toBe('install [0.0.0.0]');
      expect(readingArguments('install --listen=10.0.0.5').said).toBe('install [10.0.0.5]');
    });

    it('says nothing of an address when none was given', () => {
      expect(readingArguments('update').said).toBe('update []');
    });

    it('refuses --listen with no address after it', () => {
      const refused = readingArguments('--listen');

      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('--listen needs an address');
    });

    const written = (platform: 'Darwin' | 'Linux', listen: string): string => {
      const file = platform === 'Linux' ? 'UNIT' : 'PLIST';
      const write = platform === 'Linux' ? 'wroteUnit' : 'wrotePlist';

      return asked(aTreeWith('nested'), {
        platform,
        then: `chown() { :; }; chmod() { :; }; LISTEN=${listen}; ${file}=$(mktemp); ${write} /usr/bin/node >/dev/null; cat "$${file}"`,
      }).stdout;
    };

    it('hands the address to the service it writes, on both platforms', () => {
      expect(written('Linux', '0.0.0.0')).toContain('serve --page ');
      expect(written('Linux', '0.0.0.0')).toMatch(/ --listen 0\.0\.0\.0\n/);
      expect(written('Darwin', '0.0.0.0')).toContain('<string>--listen</string>\n    <string>0.0.0.0</string>');
    });

    it('hands the service no address at all when none was said, leaving the shop on its own default', () => {
      expect(written('Linux', "''")).not.toContain('--listen');
      expect(written('Darwin', "''")).not.toContain('--listen');
    });

    // Read back out of what was WRITTEN, so the two halves are held to the same shape.
    it('reads back the address a service it wrote was given, on both platforms', () => {
      const readBack = (platform: 'Darwin' | 'Linux', listen: string): string => {
        const file = platform === 'Linux' ? 'UNIT' : 'PLIST';
        const write = platform === 'Linux' ? 'wroteUnit' : 'wrotePlist';

        return asked(aTreeWith('nested'), {
          platform,
          then: `chown() { :; }; chmod() { :; }; LISTEN=${listen}; ${file}=$(mktemp); ${write} /usr/bin/node >/dev/null; LISTEN=''; listenedOnBefore`,
        }).stdout.trim();
      };

      expect(readBack('Linux', '0.0.0.0')).toBe('0.0.0.0');
      expect(readBack('Darwin', '10.0.0.5')).toBe('10.0.0.5');
      expect(readBack('Linux', "''")).toBe('');
    });

    const installing = (then: string): string =>
      asked(aTreeWith('nested'), { platform: 'Linux', then: `${withoutTheStepsThatWantRoot}; ${then}; install` }).stdout;

    it('keeps the address the installed service already has, when this install does not say one', () => {
      const said = installing(
        `ETC=$(mktemp -d); touch "$ETC/callers.json"; UNIT=$(mktemp); echo 'ExecStart=/n /s serve --page /p --listen 0.0.0.0' > "$UNIT"`,
      );

      expect(said).toContain('WROTE listen=[0.0.0.0]');
      expect(said).toContain('keeping --listen 0.0.0.0');
    });

    it('takes the address it was given over the one already there', () => {
      const said = installing(
        `ETC=$(mktemp -d); touch "$ETC/callers.json"; UNIT=$(mktemp); echo 'ExecStart=/n /s serve --listen 0.0.0.0' > "$UNIT"; LISTEN=127.0.0.1`,
      );

      expect(said).toContain('WROTE listen=[127.0.0.1]');
      expect(said).not.toContain('keeping');
    });

    it('says where it answers once it is running, and what being on the network costs', () => {
      const where = (listen: string): string => asked(aTreeWith('nested'), { then: `LISTEN=${listen}; whereItAnswers` }).stdout;

      expect(where("''")).toContain('http://localhost:7373 - loopback');
      expect(where('10.0.0.5')).toContain('http://10.0.0.5:7373 - on the network, over plain HTTP');
      expect(where('0.0.0.0')).toContain('can be read by anybody on that network');
      expect(where('0.0.0.0')).not.toContain('http://0.0.0.0');
    });
  });

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

    // AIDEV-NOTE: the shop claims /var/run/3d-print-shop at every start, AS the service user, and /run
    // belongs to root - so without systemd making it, the service cannot come up at all.
    it('has systemd make the runtime directory the service claims, since it cannot make one under /run', () => {
      const unit = rendered('Linux', 'UNIT=$(mktemp)', 'wroteUnit').stdout;

      expect(unit).toContain('RuntimeDirectory=3d-print-shop\n');
      expect(unit).toContain('RuntimeDirectoryMode=0700');
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
