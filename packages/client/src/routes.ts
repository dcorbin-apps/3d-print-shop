// AIDEV-NOTE: a protocol the shop did not design, kept under a name of its own so that nothing it
// answers can be mistaken for one of the shop's own routes.
/** Where the shop answers a protocol it borrowed, for callers that cannot speak its own. */
export const OCTOPRINT_PREFIX = '/octoprint';

// AIDEV-NOTE: the shop answers at the ROOT rather than under a prefix, so anything else serving a
// page beside it - a dev server, a proxy - has to know which paths are the shop's. That was a list
// kept by hand in vite.config.ts, and a route added to the contract without being added there was a
// browser getting index.html back and a page reporting "unexpected character at line 1 column 1",
// which says nothing about what is wrong. So the list lives here, beside the client that asks for
// them, and `everyPathHttpShopAsksFor` in the tests fails when one of them is missing.
//
// The borrowed prefix is in here for the same reason and not for the same audience: the list is
// about ROUTING - every path the shop answers - and one left out of it is one the page fallback
// would hand index.html to.
/** The first segment of every path this shop answers, for whoever has to route to it. */
export const SHOP_ROUTES = ['/jobs', '/printers', '/filaments', '/sessions', '/me', '/version', '/shutdown', OCTOPRINT_PREFIX] as const;

// AIDEV-NOTE: named rather than left to be noticed, because `covers every route the shop is known to
// answer` is otherwise right to fail on them: a route nothing in this contract asks for really is
// one somebody left behind, EXCEPT where it exists for a caller that does not use this contract.
/** The routes in SHOP_ROUTES that no client of this contract asks for, because they are not for one. */
export const BORROWED_ROUTES: readonly string[] = [OCTOPRINT_PREFIX];
