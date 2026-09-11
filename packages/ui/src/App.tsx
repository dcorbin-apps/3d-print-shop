import { useEffect, useState } from 'react';
import type { PrinterRecord } from '@3d-print-shop/client/browser';
import { AskForToken } from './components/AskForToken.js';
import { JobsByFilament } from './components/JobsByFilament.js';
import { PrinterGallery, stillHere } from './components/PrinterGallery.js';
import { TopBar } from './components/TopBar.js';
import { summarise } from './shopSummary.js';
import { useShop } from './useShop.js';

export const TOKEN_KEY = 'print-shop-token';
export const SELECTED_KEY = 'print-shop-selected-printer';

function remembered(key: string): string | undefined {
  return window.localStorage.getItem(key) ?? undefined;
}

export function App(): React.JSX.Element {
  const [token, setToken] = useState(() => remembered(TOKEN_KEY));

  if (token === undefined) {
    return (
      <AskForToken
        onGiven={(given) => {
          window.localStorage.setItem(TOKEN_KEY, given);
          setToken(given);
        }}
      />
    );
  }

  return <Shop token={token} />;
}

// Apart from App so that the hooks below are not written after a conditional return, and so that
// arriving with a token and typing one in reach exactly the same component.
function Shop({ token }: { token: string }): React.JSX.Element {
  const { printers, jobs, totalJobs, caller, shop, askAgain, trouble, answered } = useShop(token);
  const [chosen, setChosen] = useState(() => remembered(SELECTED_KEY));

  // AIDEV-NOTE: asked for again rather than added to what is on the screen - the shop is the one
  // that knows what a printer looks like once it has one, and a page that drew its own version of
  // the answer would be showing something the shop never said.
  // One call: the shop takes a machine and the key it is reached by together, so a printer cannot
  // land here without one and leave somebody to work out which half happened.
  const addPrinter = async (record: PrinterRecord, key: string): Promise<void> => {
    await shop.addPrinter(record, key);
    askAgain();
  };

  const selected = stillHere(printers, chosen);

  // AIDEV-NOTE: written when it SETTLES rather than when it is clicked, so that a printer removed
  // while nobody was looking - which falls back to the first - is what comes back on a reload. The
  // guard is what keeps this from writing on every poll.
  useEffect(() => {
    if (selected !== undefined && selected !== chosen) {
      window.localStorage.setItem(SELECTED_KEY, selected);
      setChosen(selected);
    }
  }, [selected, chosen]);

  return (
    <div className="shop">
      <TopBar summary={summarise(printers, jobs)} trouble={trouble} />
      <PrinterGallery
        printers={printers}
        selected={selected}
        onSelect={setChosen}
        onAdd={caller?.role === 'admin' ? addPrinter : undefined}
      />
      <JobsByFilament jobs={jobs} totalJobs={totalJobs} selected={printers.find((printer) => printer.name === selected)} />

      {!answered && <p className="asking">asking the shop...</p>}
    </div>
  );
}
