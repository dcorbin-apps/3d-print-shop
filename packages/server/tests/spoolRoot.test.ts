import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { SPOOL_ROOT_ENV, defaultSpoolRoot } from '../src/spoolRoot';

describe('defaultSpoolRoot', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[SPOOL_ROOT_ENV];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // AIDEV-NOTE: /var/spool on macOS as well as Linux - macOS is BSD-derived and has it, with the
  // same occupants (cups, postfix, mqueue, uucp). One path, no platform branch. And not a per-user
  // directory: a service's work does not belong in the home of whoever happened to submit a job.
  it('keeps its work where a system keeps outstanding work', () => {
    expect(defaultSpoolRoot()).toBe('/var/spool/3d-print-shop');
  });

  // For installs that do not want root - Homebrew keeps service state under its own prefix.
  it.each([
    ['/opt/homebrew/var/3d-print-shop'],
    ['/tmp/a-shop-for-testing'],
  ])('takes %s from the environment instead', (override) => {
    process.env[SPOOL_ROOT_ENV] = override;

    expect(defaultSpoolRoot()).toBe(override);
  });
});
