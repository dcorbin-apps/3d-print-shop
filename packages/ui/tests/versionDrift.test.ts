import { describe, it, expect } from '@jest/globals';
import { drifted } from '../src/versionDrift';

// AIDEV-NOTE: (UT) the page and the shop are installed as two packages and can come from different
// releases. What is decided here is only whether that is worth a word, and what the word is.
describe('whether this page and its shop came from different releases', () => {
  it('says nothing when they are the same', () => {
    expect(drifted('1.2.3', '1.2.3')).toBeUndefined();
  });

  it('names both when they differ, whichever of them is behind', () => {
    expect(drifted('1.2.3', '1.3.0')).toContain('This page is 1.2.3 and the shop is 1.3.0');
    expect(drifted('1.3.0', '1.2.3')).toContain('This page is 1.3.0 and the shop is 1.2.3');
  });

  // A reload costs nothing and is the whole fix for a browser that kept a page across an upgrade.
  it('says to reload before it says to install anything', () => {
    const said = drifted('1.2.3', '1.3.0') ?? '';

    expect(said.indexOf('Reload')).toBeGreaterThan(-1);
    expect(said.indexOf('Reload')).toBeLessThan(said.indexOf('installing again'));
  });

  // A shop from before the check, or a page nobody stamped: a warning that cannot say what differs
  // is one nobody can act on.
  it('says nothing when either side does not know which release it is', () => {
    expect(drifted('1.2.3', undefined)).toBeUndefined();
    expect(drifted(undefined, '1.2.3')).toBeUndefined();
  });
});
