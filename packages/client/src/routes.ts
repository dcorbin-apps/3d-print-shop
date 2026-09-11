// AIDEV-NOTE: the shop answers at the ROOT rather than under a prefix, so anything else serving a
// page beside it - a dev server, a proxy - has to know which paths are the shop's. That was a list
// kept by hand in vite.config.ts, and a route added to the contract without being added there was a
// browser getting index.html back and a page reporting "unexpected character at line 1 column 1",
// which says nothing about what is wrong. So the list lives here, beside the client that asks for
// them, and `everyPathHttpShopAsksFor` in the tests fails when one of them is missing.
/** The first segment of every path this shop answers, for whoever has to route to it. */
export const SHOP_ROUTES = ['/jobs', '/printers', '/filaments', '/sessions', '/me', '/shutdown'] as const;
