import { useCallback, useEffect, useState } from 'react';
import { HttpShop } from '@3d-print-shop/client/browser';
import type { Job, RegisteredPrinter } from '@3d-print-shop/client/browser';

/** How often the shop is asked again. It has no way to tell a browser that something changed. */
export const POLL_MS = 2000;

export interface ShopView {
  printers: RegisteredPrinter[];
  jobs: Job[];
  totalJobs: number;
  /** What went wrong asking, when something did. The last good answer is still shown beneath it. */
  trouble?: string;
  /** False only until the first answer arrives, so an empty shop is not shown as a loading one. */
  answered: boolean;
}

const NOTHING: ShopView = { printers: [], jobs: [], totalJobs: 0, answered: false };

// AIDEV-NOTE: polled, because the API has no way to push - every route is a question a client asks.
// A failed ask leaves the last good answer on the screen and says what went wrong beside it: a shop
// being restarted should not blank the wall display somebody is watching a print on.
export function useShop(token: string, url = ''): ShopView {
  const [view, setView] = useState<ShopView>(NOTHING);

  const ask = useCallback(async (): Promise<void> => {
    const shop = new HttpShop(url, token);

    try {
      const [printers, held] = await Promise.all([shop.printers(), shop.jobs()]);

      setView({ printers, jobs: held.accessibleJobs, totalJobs: held.totalJobs, answered: true });
    } catch (failure) {
      setView((last) => ({ ...last, trouble: (failure as Error).message, answered: true }));
    }
  }, [token, url]);

  useEffect(() => {
    let stopped = false;

    const askUnlessStopped = (): void => {
      if (!stopped) void ask();
    };

    askUnlessStopped();
    const asking = setInterval(askUnlessStopped, POLL_MS);

    return () => {
      stopped = true;
      clearInterval(asking);
    };
  }, [ask]);

  return view;
}
