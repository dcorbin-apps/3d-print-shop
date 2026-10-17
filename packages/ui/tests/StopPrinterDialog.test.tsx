import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RegisteredPrinter } from '@3d-print-shop/client/browser';
import { StopPrinterDialog } from '../src/components/StopPrinterDialog';

// (UT)
describe('stopping a printer', () => {
  afterEach(cleanup);

  const mk4: RegisteredPrinter = { name: 'mk4', buildVolume: { x: 250, y: 210, z: 220 }, api: 'octoprint', address: 'http://mk4', loaded: [] };
  const stops = jest.fn<(name: string, reason: string) => Promise<void>>();
  const closes = jest.fn<() => void>();

  beforeEach(() => {
    stops.mockReset();
    stops.mockResolvedValue(undefined);
    closes.mockReset();
    render(<StopPrinterDialog printer={mk4} onStop={stops} onClose={closes} />);
  });

  const why = (said: string): void => {
    fireEvent.change(screen.getByLabelText('Why it is stopping'), { target: { value: said } });
  };
  const stopButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement;

  it('hands the shop the printer and why, and closes once it is taken', async () => {
    why('  clearing a jam ');

    fireEvent.click(stopButton());

    await waitFor(() => expect(closes).toHaveBeenCalled());
    expect(stops).toHaveBeenCalledWith('mk4', 'clearing a jam');
  });

  // The shop refuses a stop without a reason, so the page does not offer to send one.
  it('cannot be sent without a reason', () => {
    why('   ');

    expect(stopButton().disabled).toBe(true);
  });

  it('stays open with what the shop said when it will not', async () => {
    stops.mockRejectedValue(new Error('the shop has no printer named mk4'));
    why('clearing a jam');

    fireEvent.click(stopButton());

    await waitFor(() => expect(screen.getByText('the shop has no printer named mk4')).toBeDefined());
    expect(closes).not.toHaveBeenCalled();
  });

  it('closes, stopping nothing, when somebody gives up on it', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(closes).toHaveBeenCalled();
    expect(stops).not.toHaveBeenCalled();
  });
});
