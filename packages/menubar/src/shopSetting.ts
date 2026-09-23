import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Settings {
  shopUrl: string;
}

export class NotAShopUrl extends Error {}

/** The shop's origin: the page is served at its root, so a path someone pastes along with it is dropped. */
export function shopUrlFrom(typed: string): string {
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    throw new NotAShopUrl(`"${typed}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotAShopUrl(`a shop is reached over http or https, not ${url.protocol}`);
  }
  return url.origin;
}

// AIDEV-NOTE: an unreadable or mangled settings file counts as nothing saved rather than failing - the
// icon then asks for a shop, and an icon that will not start cannot be told one.
export function readShopUrl(file: string): string | undefined {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
    return typeof settings.shopUrl === 'string' ? shopUrlFrom(settings.shopUrl) : undefined;
  } catch {
    return undefined;
  }
}

export function saveShopUrl(file: string, typed: string): string {
  const shopUrl = shopUrlFrom(typed);
  const settings: Settings = { shopUrl };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return shopUrl;
}
