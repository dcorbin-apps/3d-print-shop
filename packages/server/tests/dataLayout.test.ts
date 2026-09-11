import { describe, it, expect, afterEach } from '@jest/globals';
import { DATA_ROOT_ENV, defaultLayout, layoutUnder, systemLayout } from '../src/dataLayout';

// AIDEV-NOTE: the one place that knows a Linux from a Mac, and the reason the store knows neither.
// Every assertion here is about a PATH rather than a directory, so this says what the shop would do
// on a machine it is not running on - which is the only way to test the platform it is not.
describe('where a shop keeps each of the three things it has', () => {
  describe('on a system that was not told', () => {
    // The FHS, and a sysadmin finds each kind where that kind lives: work awaiting processing in
    // spool, state that outlives a restart in lib, a claim that must not in run.
    it('follows the filesystem standard on Linux', () => {
      expect(systemLayout('linux')).toEqual({
        jobs: '/var/spool/3d-print-shop/jobs',
        state: '/var/lib/3d-print-shop',
        run: '/var/run/3d-print-shop',
      });
    });

    // macOS has no /var/lib and no convention for splitting a daemon's files, so they live together
    // where a Mac puts a system daemon's things.
    it('keeps them together under Application Support on a Mac', () => {
      expect(systemLayout('darwin')).toEqual({
        jobs: '/Library/Application Support/3d-print-shop/jobs',
        state: '/Library/Application Support/3d-print-shop/state',
        run: '/var/run/3d-print-shop',
      });
    });

    // Both platforms have it, and it is the one directory that is meant to be emptied by a reboot.
    it('claims it under /var/run either way', () => {
      expect(systemLayout('linux').run).toBe(systemLayout('darwin').run);
    });

    it('keeps the three apart wherever it is', () => {
      for (const on of ['linux', 'darwin'] as const) {
        const where = systemLayout(on);

        expect(new Set([where.jobs, where.state, where.run]).size).toBe(3);
      }
    });
  });

  // What somebody who names a place is asking for: everything under it, and the three still apart.
  describe('under a directory somebody named', () => {
    it('puts all three inside it', () => {
      expect(layoutUnder('/somewhere')).toEqual({ jobs: '/somewhere/jobs', state: '/somewhere/state', run: '/somewhere/run' });
    });

    it('is what the environment asks for', () => {
      process.env[DATA_ROOT_ENV] = '/asked/for';

      expect(defaultLayout()).toEqual(layoutUnder('/asked/for'));
    });

    it('is not what an empty one asks for', () => {
      process.env[DATA_ROOT_ENV] = '  ';

      expect(defaultLayout()).toEqual(systemLayout());
    });
  });

  it("is this system's own when nobody said", () => {
    delete process.env[DATA_ROOT_ENV];

    expect(defaultLayout()).toEqual(systemLayout());
  });

  const wasSaid = process.env[DATA_ROOT_ENV];

  afterEach(() => {
    if (wasSaid === undefined) delete process.env[DATA_ROOT_ENV];
    else process.env[DATA_ROOT_ENV] = wasSaid;
  });
});
