import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TOKEN_ENV, defaultToken, defaultTokenFile } from '../src/token';
import { DEFAULT_SHOP_URL, SHOP_URL_ENV, defaultShopUrl } from '../src/shopUrl';

// AIDEV-NOTE: a caller's own token is ONE string belonging to whoever is calling rather than to the
// machine, and the caller is often not on the same machine at all. The environment suits a program;
// the file suits a person's shell, where an environment variable would have to be set by something.
describe('the token a client presents', () => {
  let config: string;
  const was = { token: process.env[TOKEN_ENV], xdg: process.env.XDG_CONFIG_HOME };

  const written = async (held: string): Promise<void> => {
    const into = path.join(config, '3d-print-shop');
    await writeFile(path.join(into, 'token'), held, { mode: 0o600 });
  };

  beforeEach(async () => {
    config = await mkdtemp(path.join(tmpdir(), 'print-shop-config-'));
    await rm(path.join(config, '3d-print-shop'), { recursive: true, force: true });
    process.env.XDG_CONFIG_HOME = config;
    delete process.env[TOKEN_ENV];
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(config, '3d-print-shop'), { recursive: true });
  });

  afterEach(async () => {
    if (was.token === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = was.token;
    if (was.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = was.xdg;
    await rm(config, { recursive: true, force: true });
  });

  describe('where it looks', () => {
    it('is under the config directory somebody named', () => {
      expect(defaultTokenFile()).toBe(path.join(config, '3d-print-shop', 'token'));
    });

    it('is under a home directory when nobody named one', () => {
      delete process.env.XDG_CONFIG_HOME;

      expect(defaultTokenFile()).toMatch(/\.config[/\\]3d-print-shop[/\\]token$/);
    });
  });

  describe('what it finds', () => {
    it('is what the environment says, before anything on disk', async () => {
      await written('the one in the file');
      process.env[TOKEN_ENV] = 'the one in the environment';

      expect(defaultToken()).toBe('the one in the environment');
    });

    it('is what the file holds when the environment says nothing', async () => {
      await written('the one in the file');

      expect(defaultToken()).toBe('the one in the file');
    });

    // A token copied out of a terminal picks up a newline, and one padded with whitespace is not a
    // token the shop would recognise.
    it('is the token without whatever whitespace came with it', async () => {
      await written('  a token\n');

      expect(defaultToken()).toBe('a token');
    });

    it('is the environment without its whitespace either', () => {
      process.env[TOKEN_ENV] = '  a token\n';

      expect(defaultToken()).toBe('a token');
    });

    // Nothing to present, which every shop refuses - it is not a mode, it is the 401 a caller gets
    // for not having been set up yet.
    it('is nothing when there is no file and nothing in the environment', () => {
      expect(defaultToken()).toBeUndefined();
    });

    it('is nothing when the file holds only whitespace', async () => {
      await written('   \n');

      expect(defaultToken()).toBeUndefined();
    });

    it('falls through to the file when the environment holds only whitespace', async () => {
      await written('the one in the file');
      process.env[TOKEN_ENV] = '   ';

      expect(defaultToken()).toBe('the one in the file');
    });
  });
});

describe('where a client looks for the shop', () => {
  const was = process.env[SHOP_URL_ENV];

  afterEach(() => {
    if (was === undefined) delete process.env[SHOP_URL_ENV];
    else process.env[SHOP_URL_ENV] = was;
  });

  // The shop on this machine, which is the overwhelmingly likely one.
  it('is this machine when nobody says otherwise', () => {
    delete process.env[SHOP_URL_ENV];

    expect(defaultShopUrl()).toBe(DEFAULT_SHOP_URL);
  });

  it('is on the port the contract names, so a shop and its clients cannot differ', () => {
    expect(DEFAULT_SHOP_URL).toBe('http://localhost:7373');
  });

  it('is wherever the environment says', () => {
    process.env[SHOP_URL_ENV] = 'http://shop.workshop.local:7373';

    expect(defaultShopUrl()).toBe('http://shop.workshop.local:7373');
  });
});
