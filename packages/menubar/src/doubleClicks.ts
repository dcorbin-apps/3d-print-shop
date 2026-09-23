/**
 * Calls `onDoubleClick` when two clicks land within `withinMs` of each other. A third click starts a
 * new pair rather than completing another, so a triple-click opens the window once.
 */
export function doubleClicks(withinMs: number, onDoubleClick: () => void): (clickedAt: number) => void {
  let pending: number | undefined;
  return (clickedAt) => {
    if (pending !== undefined && clickedAt - pending <= withinMs) {
      pending = undefined;
      onDoubleClick();
    } else {
      pending = clickedAt;
    }
  };
}
