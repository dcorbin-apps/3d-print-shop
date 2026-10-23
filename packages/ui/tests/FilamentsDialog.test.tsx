import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FilamentsDialog } from '../src/components/FilamentsDialog';

describe('the filaments the shop knows', () => {
  const known = jest.fn<() => Promise<string[]>>();
  const forgets = jest.fn<(name: string) => Promise<void>>();
  const closes = jest.fn<() => void>();

  const listed = (): string[] => screen.queryAllByRole('listitem').map((item) => item.querySelector('span')?.textContent ?? '');

  beforeEach(() => {
    known.mockReset();
    known.mockResolvedValue(['PETG-Black', 'PLA-Red']);
    forgets.mockReset();
    forgets.mockResolvedValue(undefined);
    closes.mockReset();
  });

  afterEach(cleanup);

  const showing = (): void => {
    render(<FilamentsDialog known={known} onForget={forgets} onClose={closes} />);
  };

  it('lists every one the shop knows', async () => {
    showing();

    await waitFor(() => expect(listed()).toEqual(['PETG-Black', 'PLA-Red']));
  });

  it('says so when the shop knows none', async () => {
    known.mockResolvedValue([]);
    showing();

    await waitFor(() => expect(screen.getByText('The shop knows no filaments yet.')).toBeDefined());
  });

  it('asks the shop to forget the one removed, and lists what it knows after', async () => {
    showing();
    await waitFor(() => expect(listed()).toHaveLength(2));
    known.mockResolvedValue(['PETG-Black']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove PLA-Red' }));

    await waitFor(() => expect(listed()).toEqual(['PETG-Black']));
    expect(forgets).toHaveBeenCalledWith('PLA-Red');
  });

  // A second press would ask the shop to forget one it is already forgetting, and be told it has no such filament.
  it('offers no other removal while the shop is answering one', async () => {
    forgets.mockReturnValue(new Promise<void>(() => undefined));
    showing();
    await waitFor(() => expect(listed()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Remove PLA-Red' }));

    expect((screen.getByRole('button', { name: 'Remove PETG-Black' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says what the shop said when it will not', async () => {
    forgets.mockRejectedValue(new Error('PLA-Red is loaded on mk4'));
    showing();
    await waitFor(() => expect(listed()).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Remove PLA-Red' }));

    await waitFor(() => expect(screen.getByText('PLA-Red is loaded on mk4')).toBeDefined());
  });

  it('says why when the shop will not say what it knows', async () => {
    known.mockRejectedValue(new Error('GET /filaments/known is for an admin'));
    showing();

    await waitFor(() => expect(screen.getByText('GET /filaments/known is for an admin')).toBeDefined());
  });

  it.each([
    ['Close', (): boolean => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
    ['Escape', (): boolean => fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: 'Escape' })],
  ])('closes on %s', async (_how, closing) => {
    showing();
    await waitFor(() => expect(listed()).toHaveLength(2));

    closing();

    expect(closes).toHaveBeenCalled();
  });
});
