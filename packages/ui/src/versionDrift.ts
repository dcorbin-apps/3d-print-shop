// AIDEV-NOTE: the page and the shop are two packages, installed side by side, and nothing stops one
// being updated without the other - so the page says so rather than half-working against an API it
// was not built for. Two causes look the same from here: a browser still holding a page from before
// the shop was upgraded, which a reload fixes, and a page package that was never upgraded at all,
// which only installing both again fixes. Reload is said first because it is the one that costs
// nothing. Nothing is said when either version is unknown: a shop that does not report one is older
// than this check, and a warning that cannot say what differs is one nobody can act on.
/** What to tell a person when this page and the shop serving it came from different releases. */
export function drifted(page: string | undefined, shop: string | undefined): string | undefined {
  if (page === undefined || shop === undefined || page === shop) return undefined;

  return `This page is ${page} and the shop is ${shop}. Reload the page - and if this is still here, the two were installed from different releases and need installing again together.`;
}
