import { useCallback, useEffect, useMemo, useState } from 'react';
import { HttpShop, NotAuthenticated } from '@3d-print-shop/client/browser';
import type { Caller, Job, RegisteredPrinter } from '@3d-print-shop/client/browser';

/** How often the shop is asked again. It has no way to tell a browser that something changed. */
export const POLL_MS = 2000;

export interface ShopView {
  printers: RegisteredPrinter[];
  jobs: Job[];
  totalJobs: number;
  /** Who the shop takes this browser to be, which is what says whether to offer an admin's commands. */
  caller?: Caller;
  /** The shop does not know this browser: what there is to do about it is log in. */
  strangers: boolean;
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

const NOTHING: Answers = { printers: [], jobs: [], totalJobs: 0, answered: false, strangers: false };

// AIDEV-NOTE: polled, because the API has no way to push - every route is a question a client asks.
// A failed ask leaves the last good answer on the screen and says what went wrong beside it: a shop
// being restarted should not blank the wall display somebody is watching a print on.
export function useShop(url = ''): ShopView {
  const [view, setView] = useState<Answers>(NOTHING);

  // AIDEV-NOTE: no token. A browser is named by the session cookie the shop set when somebody logged
  // in, which this page never sees - so there is nothing here to hold, and nothing for a script that
  // got into the page to steal.
  const shop = useMemo(() => new HttpShop(url), [url]);

  // AIDEV-NOTE: who the caller is is asked EVERY time rather than once, because a role is not fixed
  // for the life of a page: the shop re-reads its callers on SIGHUP, so a token can be downgraded or
  // revoked under a browser that is still open. Asking once would leave an admin's buttons on a
  // screen whose token no longer earns them.
  const ask = useCallback(async (): Promise<void> => {
    try {
      const [caller, printers, held] = await Promise.all([shop.whoAmI(), shop.printers(), shop.jobs()]);

      setView({ caller, printers, jobs: held.accessibleJobs, totalJobs: held.totalJobs, answered: true, strangers: false });
    } catch (failure) {
      // AIDEV-NOTE: being a stranger is not trouble - it is the ordinary state of a browser nobody
      // has logged in on, and of one whose session has expired while it sat there. Both want a
      // login rather than an error, and what is on the screen is cleared because it is no longer
      // this caller's to see.
      if (failure instanceof NotAuthenticated) {
        setView({ ...NOTHING, answered: true, strangers: true });
        return;
      }

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
