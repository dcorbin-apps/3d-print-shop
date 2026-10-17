import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PrinterRecord, RegisteredPrinter } from '@3d-print-shop/client/browser';
import { EditPrinterDialog } from '../src/components/EditPrinterDialog';

// (UT) only what the dialog adds to the form it holds - the form itself is PrinterForm's suite.
describe('taking a printer out of the shop', () => {
  afterEach(cleanup);

  const mk4: RegisteredPrinter = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4', loaded: [] };
  const saves = jest.fn<(record: PrinterRecord, key: string | undefined) => Promise<void>>();
  const removes = jest.fn<(name: string) => Promise<void>>();
  const closes = jest.fn<() => void>();
  const confirm = jest.fn<(question: string) => boolean>();

  beforeEach(() => {
    removes.mockReset();
    removes.mockResolvedValue(undefined);
    closes.mockReset();
    confirm.mockReset();
    confirm.mockReturnValue(true);
  });

  const editing = (printer: RegisteredPrinter = mk4): void => {
    render(<EditPrinterDialog printer={printer} onSave={saves} onRemove={removes} onClose={closes} confirm={confirm} />);
  };
  const removeButton = (): HTMLButtonElement | null => screen.queryByRole('button', { name: 'Remove mk4' });

  it('asks first, naming the printer, then has the shop take it out and closes', async () => {
    editing();

    fireEvent.click(removeButton() as HTMLButtonElement);

    await waitFor(() => expect(closes).toHaveBeenCalled());
    expect(confirm.mock.calls[0]?.[0]).toContain('mk4');
    expect(removes).toHaveBeenCalledWith('mk4');
  });

  it('asks the shop for nothing when somebody changes their mind at the question', () => {
    confirm.mockReturnValue(false);
    editing();

    fireEvent.click(removeButton() as HTMLButtonElement);

    expect(removes).not.toHaveBeenCalled();
  });

  // The shop refuses to take out a machine with a job on it.
  it('cannot be pressed while the printer is holding a job', () => {
    editing({ ...mk4, holding: { job: 7, phase: 'awaiting-approval' } });

    expect(removeButton()?.disabled).toBe(true);
  });

  it('stays open with what the shop said when it will not', async () => {
    removes.mockRejectedValue(new Error('mk4 is holding job 7'));
    editing();

    fireEvent.click(removeButton() as HTMLButtonElement);

    await waitFor(() => expect(screen.getByText('mk4 is holding job 7')).toBeDefined());
    expect(closes).not.toHaveBeenCalled();
  });

  it('is not offered where there is nobody to take it', () => {
    render(<EditPrinterDialog printer={mk4} onSave={saves} onClose={closes} confirm={confirm} />);

    expect(removeButton()).toBeNull();
  });
});
