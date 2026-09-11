import { useCallback, useEffect, useMemo, useState } from 'react';
import { HttpShop } from '@3d-print-shop/client/browser';
import type { Caller, Job, RegisteredPrinter } from '@3d-print-shop/client/browser';

/** How often the shop is asked again. It has no way to tell a browser that something changed. */
export const POLL_MS = 2000;

export interface ShopView {
  printers: RegisteredPrinter[];
  jobs: Job[];
  totalJobs: number;
  /** Who the shop takes this token to be, which is what says whether to offer an admin's commands. */
  caller?: Caller;
  /** The shop itself, for the things a person DOES here rather than watches. */
  shop: HttpShop;
  /** Ask now rather than at the next tick - what a change made from this page waits on. */
  askAgain: () => void;
  /** What went wrong asking, when something did. The last good answer is still shown beneath it. */
  trouble?: string;
  /** False only until the first answer arrives, so an empty shop is not shown as a loading one. */
  answered: boolean;
}

type Answers = Omit<ShopView, 'shop' | 'askAgain'>;

const NOTHING: Answers = { printers: [], jobs: [], totalJobs: 0, answered: false };

// AIDEV-NOTE: polled, because the API has no way to push - every route is a question a client asks.
// A failed ask leaves the last good answer on the screen and says what went wrong beside it: a shop
// being restarted should not blank the wall display somebody is watching a print on.
export function useShop(token: string, url = ''): ShopView {
  const [view, setView] = useState<Answers>(NOTHING);
  const shop = useMemo(() => new HttpShop(url, token), [token, url]);

  // AIDEV-NOTE: who the caller is is asked EVERY time rather than once, because a role is not fixed
  // for the life of a page: the shop re-reads its callers on SIGHUP, so a token can be downgraded or
  // revoked under a browser that is still open. Asking once would leave an admin's buttons on a
  // screen whose token no longer earns them.
  const ask = useCallback(async (): Promise<void> => {
    try {
      const [caller, printers, held] = await Promise.all([shop.whoAmI(), shop.printers(), shop.jobs()]);

      setView({ caller, printers, jobs: held.accessibleJobs, totalJobs: held.totalJobs, answered: true });
    } catch (failure) {
      setView((last) => ({ ...last, trouble: (failure as Error).message, answered: true }));
    }
  }, [shop]);

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

  return { ...view, shop, askAgain: () => void ask() };
}
