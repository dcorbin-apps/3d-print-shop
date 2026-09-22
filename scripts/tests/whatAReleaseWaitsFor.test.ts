import { describe, it, expect } from '@jest/globals';
import { aRegistryWith, aRun, aRunSaying, aWorkspaceOf, alreadyUp, anApiAnswering, anApiListing, asked, noWaiting } from './aRelease.js';

// AIDEV-NOTE: (UT) every one of these. release.sh is SOURCED rather than run, so nothing is bumped,
// committed, tagged or pushed - what is measured is what it decided from the answers curl, npm and
// yarn gave it. That half is the half nobody can try out: the only other way to reach it is to cut a
// release, and a release cannot be undone.
describe('what a release waits for, once the tag is up', () => {
  describe('the repository it asks about', () => {
    // Written down once, in the remote. A second copy is a second thing to be wrong on a fork.
    it('reads the slug out of the remote, in each of the three shapes a remote comes in', () => {
      const from = (url: string): string => asked({ then: `git() { echo ${url}; }; repoSlug` }).stdout.trim();

      expect(from('git@github.com:owner/repo.git')).toBe('owner/repo');
      expect(from('https://github.com/owner/repo.git')).toBe('owner/repo');
      expect(from('ssh://git@github.com/owner/repo')).toBe('owner/repo');
    });
  });

  describe('how it reaches the API', () => {
    const noticingCurl = 'curl() { echo "$@"; }';

    it('presents a token when there is one, because the anonymous budget is shared with the machine', () => {
      const answer = asked({ env: { GITHUB_TOKEN: 'a-token' }, then: `${noticingCurl}; apiGet https://api.github.com/x` });

      expect(answer.stdout).toContain('Authorization: Bearer a-token');
    });

    it('asks anonymously when there is none, rather than refusing to wait at all', () => {
      const answer = asked({ env: { GITHUB_TOKEN: '' }, then: `${noticingCurl}; apiGet https://api.github.com/x` });

      expect(answer.stdout).not.toContain('Authorization');
      expect(answer.stdout).toContain('https://api.github.com/x');
    });
  });

  describe('which run of the publish workflow it is watching', () => {
    it('takes the run for this tag, and not one of another release going up beside it', () => {
      const listing = anApiListing([aRun({ id: 1, head_branch: 'v1.1.9' }), aRun({ id: 2, head_branch: 'v1.2.0' })]);

      expect(asked({ then: `${listing}\npublishRunFor v1.2.0` }).stdout.trim()).toMatch(/^2 completed success /);
    });

    // A tag can be pushed twice after a run is deleted or re-run, and the one that matters is the last.
    it('takes the newest when a tag has been run more than once', () => {
      const listing = anApiListing([
        aRun({ id: 1, created_at: '2026-01-01T00:00:00Z' }),
        aRun({ id: 2, created_at: '2026-01-01T09:00:00Z' }),
        aRun({ id: 3, created_at: '2026-01-01T03:00:00Z' }),
      ]);

      expect(asked({ then: `${listing}\npublishRunFor v1.2.0` }).stdout.trim()).toMatch(/^2 /);
    });

    // Absent is a state to wait through: a pushed tag takes a moment to become a run.
    it('says nothing at all when no run is listed for the tag yet', () => {
      const listing = anApiListing([aRun({ head_branch: 'v9.9.9' })]);

      expect(asked({ then: `${listing}\npublishRunFor v1.2.0; echo done` }).stdout.trim()).toBe('done');
    });

    // AIDEV-NOTE: rate limits, a proxy and an outage all answer with something that is not JSON, and
    // this runs after the tag is pushed - so a body it cannot read is one more turn of the poll and
    // never the thing that ends a release halfway through.
    it('says nothing rather than dying when what came back is not JSON at all', () => {
      const answer = asked({ then: `${anApiAnswering('<html>rate limited</html>')}\npublishRunFor v1.2.0; echo survived` });

      expect(answer.status).toBe(0);
      expect(answer.stdout.trim()).toBe('survived');
    });

    it('says a dash for a run that has not concluded, so the four fields are always four', () => {
      const listing = anApiListing([aRun({ id: 4, status: 'in_progress', conclusion: null })]);

      expect(asked({ then: `${listing}\npublishRunFor v1.2.0` }).stdout.trim()).toMatch(/^4 in_progress - https:/);
    });
  });

  describe('following the publish run', () => {
    it('ends happily on a run that succeeded, naming the run it read', () => {
      const answer = asked({ then: `${aRunSaying(['7 completed success https://runs/7'])}\nfollowThePublish v1.2.0 && echo ok` });

      expect(answer.stdout).toContain('the publish run succeeded  (https://runs/7)');
      expect(answer.stdout).toContain('ok');
    });

    // AIDEV-NOTE: the important one. publish.sh sends packages one at a time, so a run that died may
    // have got some of them up - which decides whether the version can be tried again or is spent for
    // good. Being told the comfortable answer here costs a version number.
    it('refuses on a run that failed, and says the version may already be spent rather than that it is not', () => {
      const answer = asked({ then: `${aRunSaying(['7 completed failure https://runs/7'])}\nfollowThePublish v1.2.0 || echo refused` });

      expect(answer.stdout).toContain('THE PUBLISH RUN failure  (https://runs/7)');
      expect(answer.stdout).toContain('Some packages may already be up');
      expect(answer.stdout).toContain('npm view <package> versions');
      expect(answer.stdout).toContain('refused');
    });

    it('waits through a run that is not there yet and one still going, rather than reading either as an answer', () => {
      const turns = aRunSaying(['', '7 in_progress - https://runs/7', '7 completed success https://runs/7']);
      const answer = asked({ then: `${turns}\n${noWaiting}\nfollowThePublish v1.2.0 && echo ok` });

      expect(answer.stdout).toContain('run 7 is in_progress');
      expect(answer.stdout).toContain('the publish run succeeded');
      expect(answer.stdout).toContain('ok');
    });

    it('gives up on a deadline instead of waiting for ever, and says where to look', () => {
      const turns = aRunSaying(['7 in_progress - https://runs/7']);
      const answer = asked({ then: `${turns}\n${noWaiting}\nPUBLISH_DEADLINE=-1\nfollowThePublish v1.2.0 || echo gave-up` });

      expect(answer.stdout).toContain('gave up after -1s');
      expect(answer.stdout).toContain('https://runs/7');
      expect(answer.stdout).toContain('gave-up');
    });
  });

  describe('what counts as having reached npm', () => {
    // AIDEV-NOTE: the PACKUMENT and not the version endpoint. The two disagree for a while after a
    // publish, and the one worth waiting on is the one an install resolves from.
    const resolving = (has: string[], version: string): string =>
      asked({ then: `${aRegistryWith({ '@x/a': has })}\nresolvesAt @x/a ${version} && echo yes || echo no` }).stdout.trim();

    it('reads the version list, and is not fooled by a neighbouring version being there', () => {
      expect(resolving(['1.1.0', '1.2.0'], '1.2.0')).toBe('yes');
      expect(resolving(['1.1.0', '1.2.0'], '1.3.0')).toBe('no');
    });

    // AIDEV-NOTE: the version is looked for WITH its quotes, and this is the case that needs them.
    // A release that follows its own release candidate finds `1.2.0-rc.1` in the list, which holds
    // `1.2.0` as a prefix - so an unquoted match would call the wait over before 1.2.0 was up at all.
    it('does not read a release candidate of a version as the version', () => {
      expect(resolving(['1.2.0-rc.1'], '1.2.0')).toBe('no');
      expect(resolving(['1.2.0-rc.1', '1.2.0'], '1.2.0')).toBe('yes');
    });
  });

  describe('waiting for the registry', () => {
    const shop = `${aWorkspaceOf(['@x/a', '@x/b'])}\n${noWaiting}`;

    it('ends once every package resolves, which is what makes an install work', () => {
      const registry = aRegistryWith({ '@x/a': ['1.2.0'], '@x/b': ['1.2.0'] });
      const answer = asked({ then: `${shop}\n${registry}\nwaitForTheRegistry 1.2.0 && echo ok` });

      expect(answer.stdout).toContain('every package resolves at 1.2.0');
      expect(answer.stdout).toContain('ok');
    });

    it('names the ones that have not arrived yet, and goes round until they have', () => {
      const answer = asked({ then: `${shop}\n${alreadyUp(['@x/a'])}\nwaitForTheRegistry 1.2.0 && echo ok` });

      expect(answer.stdout).toContain('still waiting on: @x/b');
      expect(answer.stdout).not.toContain('@x/a');
      expect(answer.stdout).toContain('every package resolves at 1.2.0');
      expect(answer.stdout).toContain('ok');
    });

    // AIDEV-NOTE: the publish has already succeeded by the time this runs, so the deadline here is
    // the registry being slow and NOT a release to do again - said plainly, because doing it again
    // burns a version number that cannot come back.
    it('gives up saying the release is made and the registry is merely behind', () => {
      const registry = aRegistryWith({ '@x/a': ['1.2.0'] });
      const answer = asked({ then: `${shop}\n${registry}\nREGISTRY_DEADLINE=-1\nwaitForTheRegistry 1.2.0 || echo gave-up` });

      expect(answer.stdout).toContain('gave up after -1s. Still not resolving: @x/b');
      expect(answer.stdout).toContain('rather than a release to redo');
      expect(answer.stdout).toContain('gave-up');
    });
  });
});
