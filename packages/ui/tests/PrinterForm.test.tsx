import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';
import { PrinterForm } from '../src/components/PrinterForm';

// Adding goes through this same form and is covered from AddPrinterTile.test.tsx; this is only what
// is different about changing a printer the shop already has.
describe('changing a printer the shop already has', () => {
  afterEach(cleanup);

  const mk4: PrinterRecord = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://prusa.local' };
  const saves = jest.fn<(record: PrinterRecord, key: string | undefined) => Promise<void>>();
  const closes = jest.fn<() => void>();

  beforeEach(() => {
    saves.mockResolvedValue(undefined);
    render(<PrinterForm editing={mk4} submitLabel="Save" submittingLabel="Saving..." onSubmit={saves} onClose={closes} />);
  });

  const type = (label: string, said: string): void => {
    fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value: said } });
  };
  const valueOf = (label: string): string => (screen.getByLabelText(label, { exact: false }) as HTMLInputElement).value;
  const save = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  };

  it('starts from what the shop knows about it', () => {
    expect([valueOf('width'), valueOf('depth'), valueOf('height'), valueOf('address')]).toEqual(['250', '210', '220', 'http://prusa.local']);
  });

  // The name is what everything else about a printer is filed under; a different one is a different printer.
  it('shows its name without offering to change it', () => {
    expect(screen.getByText('mk4')).toBeDefined();
    expect(screen.queryByLabelText('name', { exact: false })).toBeNull();
  });

  it('never shows the key it has', () => {
    expect(valueOf('api key')).toBe('');
  });

  it('hands the shop the changed record under the same name, keeping the key when none is typed', async () => {
    type('address', ' http://prusa.home.example ');

    save();

    await waitFor(() => expect(saves).toHaveBeenCalledWith({ ...mk4, address: 'http://prusa.home.example' }, undefined));
  });

  it('hands the shop a new key when one is typed', async () => {
    type('api key', 'new-key');

    save();

    await waitFor(() => expect(saves).toHaveBeenCalledWith(mk4, 'new-key'));
  });

  it('closes once the shop has taken it', async () => {
    save();

    await waitFor(() => expect(closes).toHaveBeenCalled());
  });

  it('does not offer to save an address that is blank', () => {
    type('address', ' ');

    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
