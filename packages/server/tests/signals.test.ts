import { describe, it, expect, afterEach, beforeEach, jest } from '@jest/globals';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { answerSignals, rereadEverything } from '../src/signals';
import { CALLERS_FILE, PRINTER_KEYS_FILE, callersIn, printerKeysIn } from '../src/credentials';
import { Sessions } from '../src/sessions';
import { silent, toStdout } from '../src/log';
import { digestOf, hashPassword } from '../src/secrets';
import type { Answers, Signalled } from '../src/signals';
import type { Log } from '../src/log';

// AIDEV-NOTE: what happens WHEN a signal arrives, asked without spawning anything. That one really
// arrives, and that a process with no SIGHUP handler is ended by node, is theRunningShop's - and it
// is all that is left there of this.
describe('the signals a running shop answers', () => {
  const registered: { signal: string; handler: () => void }[] = [];
  const on: Signalled = { on: (signal, handler) => registered.push({ signal, handler }) };

  const answers = (): Answers => ({ stop: jest.fn<() => void>(), reread: jest.fn<() => void>() });

  beforeEach(() => {
    registered.length = 0;
  });

  // What a supervised service is stopped with. `launchd` and `systemd` both send it, and one that
  // ignored them would be killed with prints still being watched.
  it.each([['SIGTERM'], ['SIGINT']])('stops the shop on %s', (signal) => {
    const answered = answers();

    answerSignals(on, answered);
    registered.find((each) => each.signal === signal)?.handler();

    expect(answered.stop).toHaveBeenCalledTimes(1);
    expect(answered.reread).not.toHaveBeenCalled();
  });

  // AIDEV-NOTE: node ENDS a process that has no handler for SIGHUP, so a shop under a terminal that
  // closed used to die where it now re-reads. Registering one at all is half of what this is for.
  it('re-reads what it was given on SIGHUP, rather than stopping', () => {
    const answered = answers();

    answerSignals(on, answered);
    registered.find((each) => each.signal === 'SIGHUP')?.handler();

    expect(answered.reread).toHaveBeenCalledTimes(1);
    expect(answered.stop).not.toHaveBeenCalled();
  });

  it('answers all three, and nothing else', () => {
    answerSignals(on, answers());

    expect(registered.map((each) => each.signal)).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP']);
  });
});

// AIDEV-NOTE: over a real credentials directory, because what this does IS read two files - the same
// reason callerAdmin's tests are written that way. `rereadCallers` and `rereadPrinterKeys` each keep
// what the shop had when what they are told to read is unusable; what is asked here is what the shop
// holds AFTERWARDS, and who gets logged out on the way.
describe('re-reading everything the shop was given', () => {
  let etc: string;
  let sessions: Sessions;

  const PASSWORD = 'a password of some length';
  const ANOTHER = 'a different password entirely';

  // AIDEV-NOTE: ada's hash is written once and reused byte for byte, because `whosePasswordChanged`
  // compares what is STORED and scrypt is salted - re-hashing the same password makes a different
  // hash and would read as a change. That is not a quirk of the test: `setPassword` rewrites the one
  // caller's entry and leaves everybody else's exactly as it found them, which is what makes the
  // comparison mean what it says.
  let adasHash: string;

  const callerFile = async (dave: string): Promise<void> => {
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([
        { id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'password', hash: await hashPassword(dave) }] },
        { id: 'ada', name: 'ada', role: 'user', credentials: [{ kind: 'password', hash: adasHash }] },
      ]),
      { mode: 0o600 },
    );
  };

  const keysFile = async (keys: Record<string, string>): Promise<void> => {
    await writeFile(path.join(etc, PRINTER_KEYS_FILE), JSON.stringify(keys), { mode: 0o600 });
  };

  const held = async (): Promise<{ callers: Awaited<ReturnType<typeof callersIn>>; printerKeys: ReadonlyMap<string, string> }> => ({
    callers: await callersIn(etc),
    printerKeys: await printerKeysIn(etc),
  });

  beforeEach(async () => {
    etc = await mkdtemp(path.join(tmpdir(), 'print-shop-signals-'));
    await chmod(etc, 0o700);
    adasHash = await hashPassword(PASSWORD);
    await callerFile(PASSWORD);
    await keysFile({ mk4: 'a-key' });
    sessions = new Sessions();
  }, 30_000);

  it('holds the callers the file now names', async () => {
    const before = await held();
    await writeFile(
      path.join(etc, CALLERS_FILE),
      JSON.stringify([{ id: 'dave', name: 'dave', role: 'admin', credentials: [{ kind: 'token', hash: digestOf('a-token') }] }]),
      { mode: 0o600 },
    );

    const after = await rereadEverything(etc, before, sessions, silent);

    expect(after.callers.size).toBe(1);
    expect(after.callers.presenting('a-token')?.name).toBe('dave');
  }, 30_000);

  it('holds the printer keys the file has since been corrected to', async () => {
    const before = await held();
    await keysFile({ mk4: 'a-corrected-key' });

    expect((await rereadEverything(etc, before, sessions, silent)).printerKeys.get('mk4')).toBe('a-corrected-key');
  }, 30_000);

  // Each file independently: a callers file somebody has just broken is no reason to leave a
  // corrected key unread.
  it('reads the keys even when the callers file has been broken', async () => {
    const before = await held();
    await writeFile(path.join(etc, CALLERS_FILE), 'not json at all', { mode: 0o600 });
    await keysFile({ mk4: 'a-corrected-key' });

    const after = await rereadEverything(etc, before, sessions, silent);

    expect(after.callers.size).toBe(before.callers.size);
    expect(after.printerKeys.get('mk4')).toBe('a-corrected-key');
  }, 30_000);

  it('keeps the callers it had when the file it is told to read is unusable', async () => {
    const before = await held();
    await writeFile(path.join(etc, CALLERS_FILE), 'not json at all', { mode: 0o600 });

    expect((await rereadEverything(etc, before, sessions, silent)).callers.size).toBe(2);
  }, 30_000);

  // AIDEV-NOTE: the other half of what a new password is for. `caller password` says every browser
  // logged in as them is logged out once the shop has re-read this - without this a stolen password
  // went on working in whatever browser already had a session, which is the one place it was
  // certain to be.
  describe('when a password has changed', () => {
    it('logs out every browser that caller was logged in on', async () => {
      const before = await held();
      const secret = sessions.begin('dave');
      await callerFile(ANOTHER);

      await rereadEverything(etc, before, sessions, silent);

      expect(sessions.whose(secret)).toBeUndefined();
    }, 30_000);

    it('leaves everybody else logged in', async () => {
      const before = await held();
      const adas = sessions.begin('ada');
      await callerFile(ANOTHER);

      await rereadEverything(etc, before, sessions, silent);

      expect(sessions.whose(adas)).toBe('ada');
    }, 30_000);

    it('says so, because a person logged out without asking deserves a reason in the log', async () => {
      const lines: string[] = [];
      const log: Log = toStdout(
        () => new Date(),
        (line) => lines.push(line),
      );
      const before = await held();
      sessions.begin('dave');
      await callerFile(ANOTHER);

      await rereadEverything(etc, before, sessions, log);

      expect(lines.join('\n')).toContain('a changed password logged out every browser it was logged in on');
    }, 30_000);

    it('logs nobody out when the file says what it said before', async () => {
      const before = await held();
      const secret = sessions.begin('dave');

      await rereadEverything(etc, before, sessions, silent);

      expect(sessions.whose(secret)).toBe('dave');
    }, 30_000);
  });

  afterEach(async () => {
    await rm(etc, { recursive: true, force: true });
  });
});
