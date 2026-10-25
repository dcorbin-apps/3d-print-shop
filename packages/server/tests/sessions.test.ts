import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LONGEST_MS, SESSIONS_FILE, Sessions } from '../src/sessions';

describe('the sessions a browser is known by', () => {
  let state: string;
  let clock: number;
  let made: Sessions[];

  const at = (): number => clock;
  const kept = (): string => path.join(state, SESSIONS_FILE);

  // AIDEV-NOTE: every one of them, so that teardown can wait for the writes still in flight. A write
  // is deliberately not awaited by the code that starts it, and one landing while the directory is
  // being deleted is a test failing somewhere else entirely.
  const aSessions = (given: { now?: () => number; keptIn?: string } = { now: at }): Sessions => {
    const sessions = new Sessions(given);
    made.push(sessions);

    return sessions;
  };

  // Written without waiting - a login should not wait on a disk - so a test that looks at the file
  // asks the sessions when what they know has got there.
  const written = async (sessions: Sessions): Promise<unknown[]> => {
    await sessions.settled();

    return JSON.parse(await readFile(kept(), 'utf-8')) as unknown[];
  };

  beforeEach(async () => {
    state = await mkdtemp(path.join(tmpdir(), 'print-shop-sessions-'));
    clock = Date.parse('2026-09-11T09:00:00Z');
    made = [];
  });

  afterEach(async () => {
    await Promise.all(made.map((sessions) => sessions.settled()));
    await rm(state, { recursive: true, force: true });
  });

  describe('while the shop is running', () => {
    it('names the caller whose session it is', () => {
      const sessions = aSessions({ now: at });

      expect(sessions.whose(sessions.begin('dave'))).toBe('dave');
    });

    it('names nobody for something it never issued', () => {
      expect(aSessions({ now: at }).whose('made-up')).toBeUndefined();
    });

    // A new secret every time: a cookie taken from a machine somebody has since logged in on again
    // is not the cookie in use.
    it('is a different session every time somebody logs in', () => {
      const sessions = aSessions({ now: at });

      expect(sessions.begin('dave')).not.toBe(sessions.begin('dave'));
    });

    it('ends when somebody logs out', () => {
      const sessions = aSessions({ now: at });
      const secret = sessions.begin('dave');

      sessions.end(secret);

      expect(sessions.whose(secret)).toBeUndefined();
    });

    // AIDEV-NOTE: what a changed password means. Somebody either forgot theirs or believes somebody
    // else has it, and in both cases every browser already logged in as them should not be.
    it('ends every one a caller holds at once, and nobody else than them', () => {
      const sessions = aSessions({ now: at });
      const bench = sessions.begin('dave');
      const desk = sessions.begin('dave');
      const somebodyElse = sessions.begin('ada');

      sessions.endEveryOneOf('dave');

      expect(sessions.whose(bench)).toBeUndefined();
      expect(sessions.whose(desk)).toBeUndefined();
      expect(sessions.whose(somebodyElse)).toBe('ada');
    });

    // Somebody changing their own password at a screen has just proved who they are; being asked to
    // log in again for it would be the page punishing the safe thing.
    it('spares the one that asked, when it is asked to spare one', () => {
      const sessions = aSessions({ now: at });
      const here = sessions.begin('dave');
      const elsewhere = sessions.begin('dave');

      sessions.endEveryOneOf('dave', here);

      expect(sessions.whose(here)).toBe('dave');
      expect(sessions.whose(elsewhere)).toBeUndefined();
    });
  });

  // However much it is used: no amount of activity extends a session.
  describe('and how long one lasts', () => {
    it('lasts a year', () => {
      const sessions = aSessions({ now: at });
      const secret = sessions.begin('dave');

      clock += 364 * 24 * 60 * 60 * 1000;

      expect(sessions.whose(secret)).toBe('dave');
    });

    it('is not gone while it is younger than the longest a session lasts', () => {
      const sessions = aSessions({ now: at });
      const secret = sessions.begin('dave');

      clock += LONGEST_MS;

      expect(sessions.whose(secret)).toBe('dave');
    });

    it('is gone once it has been going long enough, however much it is used', () => {
      const sessions = aSessions({ now: at });
      const secret = sessions.begin('dave');

      for (let asked = 0; asked < 5; asked += 1) {
        clock += LONGEST_MS / 5;
        sessions.whose(secret);
      }
      clock += 1;

      expect(sessions.whose(secret)).toBeUndefined();
    });
  });

  // AIDEV-NOTE: the whole point of the file. A shop restarted by an update at 2am was a wall display
  // asking to be logged in to in the morning.
  describe('across a restart', () => {
    const restarted = async (): Promise<Sessions> => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      await sessions.pickUp();

      return sessions;
    };

    it('still names the caller whose session it is', async () => {
      const before = aSessions({ now: at, keptIn: kept() });
      const secret = before.begin('dave');
      await written(before);

      expect((await restarted()).whose(secret)).toBe('dave');
    });

    it('has nothing to pick up on a machine that has never had one', async () => {
      expect(await aSessions({ now: at, keptIn: kept() }).pickUp()).toBe(0);
    });

    it('does not bring back one that was logged out', async () => {
      const before = aSessions({ now: at, keptIn: kept() });
      const secret = before.begin('dave');
      before.end(secret);
      await written(before);

      expect((await restarted()).whose(secret)).toBeUndefined();
    });

    it('does not bring back one that had expired while it was down', async () => {
      const before = aSessions({ now: at, keptIn: kept() });
      const secret = before.begin('dave');
      await written(before);

      clock += LONGEST_MS + 1;
      const after = aSessions({ now: at, keptIn: kept() });

      expect(await after.pickUp()).toBe(0);
      expect(after.whose(secret)).toBeUndefined();
    });

    it('says how many it picked up', async () => {
      const before = aSessions({ now: at, keptIn: kept() });
      before.begin('dave');
      before.begin('ada');
      await written(before);

      expect(await aSessions({ now: at, keptIn: kept() }).pickUp()).toBe(2);
    });

    // AIDEV-NOTE: what makes the file safe to write at all. A stolen copy says who was logged in and
    // when - worth 0600 - but it cannot be turned back into a cookie somebody can present.
    it('writes down no session anybody could present', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      const secret = sessions.begin('dave');

      expect(JSON.stringify(await written(sessions))).not.toContain(secret);
    });

    it('writes it where only its owner can read it', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      sessions.begin('dave');
      await written(sessions);

      expect((await stat(kept())).mode & 0o077).toBe(0);
    });

    it('leaves nothing beside it', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      sessions.begin('dave');
      await written(sessions);

      expect(await readFile(`${kept()}.new`, 'utf-8').catch(() => 'gone')).toBe('gone');
    });

    // Everybody logging in again is the safe direction, but it is the CALLER's to choose: a shop
    // that swallowed this would log everybody out every morning with nobody knowing why.
    it.each([
      ['cannot make sense of', async (): Promise<void> => writeFile(kept(), '{ not json')],
      ['cannot read at all', async (): Promise<void> => void (await mkdir(kept()))],
    ])('refuses a file it %s rather than starting empty quietly', async (_what, spoil) => {
      await spoil();

      await expect(aSessions({ now: at, keptIn: kept() }).pickUp()).rejects.toThrow();
    });

    it('does not bring back the ones a changed password ended', async () => {
      const before = aSessions({ now: at, keptIn: kept() });
      const secret = before.begin('dave');
      before.endEveryOneOf('dave');
      await written(before);

      expect((await restarted()).whose(secret)).toBeUndefined();
    });

    // Nothing sweeps on a timer, so a login is when the dead ones go - otherwise a machine nobody
    // has logged out of in a year keeps a year of them, in memory and in the file.
    it('writes down none of the expired ones once somebody logs in', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      sessions.begin('dave');

      clock += LONGEST_MS + 1;
      sessions.begin('ada');

      expect(await written(sessions)).toEqual([expect.objectContaining({ caller: 'ada' })]);
    });

    it('writes down that one it was asked about had expired', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      const secret = sessions.begin('dave');
      await written(sessions);

      clock += LONGEST_MS + 1;
      sessions.whose(secret);

      expect(await written(sessions)).toEqual([]);
    });

    // AIDEV-NOTE: what beside-and-rename gives that writing over the file does not - the file is
    // REPLACED, so anybody already reading it goes on reading a whole one. A new inode is the only
    // way to see that from here; the alternative is crashing the process part way through a write.
    it('replaces the file rather than writing over the one somebody may be reading', async () => {
      const sessions = aSessions({ now: at, keptIn: kept() });
      sessions.begin('dave');
      await written(sessions);
      const first = (await stat(kept())).ino;

      sessions.begin('ada');
      await written(sessions);

      expect((await stat(kept())).ino).not.toBe(first);
    });

    it('keeps nothing anywhere when it was given nowhere to keep it', async () => {
      const sessions = aSessions({ now: at });
      sessions.begin('dave');

      await expect(readFile(kept(), 'utf-8')).rejects.toThrow();
    });
  });
});
