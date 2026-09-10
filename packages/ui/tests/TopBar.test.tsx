import { describe, it, expect, afterEach } from '@jest/globals';
import { cleanup, render, screen } from '@testing-library/react';
import { TopBar } from '../src/components/TopBar';
import type { ShopSummary } from '../src/shopSummary';

describe('the banner and what it says the shop is doing', () => {
  afterEach(cleanup);

  const quiet: ShopSummary = { printers: 0, printing: 0, needingSomebody: 0, queued: 0, awaitingApproval: 0 };

  const said = (label: string): string | null => screen.getByText(label).parentElement?.querySelector('dd')?.textContent ?? null;

  it('names the shop', () => {
    render(<TopBar summary={quiet} />);

    expect(screen.getByRole('heading').textContent).toBe('3D Print Shop');
  });

  it('counts what there is', () => {
    render(<TopBar summary={{ printers: 2, printing: 1, needingSomebody: 1, queued: 7, awaitingApproval: 2 }} />);

    expect(said('printers')).toBe('2');
    expect(said('printing')).toBe('1');
    expect(said('needs somebody')).toBe('1');
    expect(said('queued')).toBe('7');
    expect(said('to judge')).toBe('2');
  });

  // One printer is a printer, and a banner that says "1 printers" is a banner nobody trusts.
  it('says printer rather than printers when there is one', () => {
    render(<TopBar summary={{ ...quiet, printers: 1 }} />);

    expect(screen.getByText('printer')).toBeDefined();
  });

  // AIDEV-NOTE: what the summary is FOR - the two numbers that mean somebody has to go and do
  // something are the two that are marked, and only while they are not zero.
  it.each<[keyof ShopSummary, string]>([
    ['needingSomebody', 'needs somebody'],
    ['awaitingApproval', 'to judge'],
  ])('marks %s as wanting a person when it is not zero', (field, label) => {
    render(<TopBar summary={{ ...quiet, [field]: 1 }} />);

    expect(screen.getByText(label).parentElement?.className).toBe('count urgent');
  });

  it('marks nothing in a shop where nothing needs doing', () => {
    render(<TopBar summary={quiet} />);

    expect(document.querySelectorAll('.urgent')).toHaveLength(0);
  });

  // The last good answer stays underneath, so a shop being restarted does not blank a wall display.
  it('says what went wrong asking, when something did', () => {
    render(<TopBar summary={quiet} trouble="the shop could not be reached" />);

    expect(screen.getByText('the shop could not be reached')).toBeDefined();
  });

  it('says nothing when nothing went wrong', () => {
    render(<TopBar summary={quiet} />);

    expect(document.querySelector('.trouble')).toBeNull();
  });
});
