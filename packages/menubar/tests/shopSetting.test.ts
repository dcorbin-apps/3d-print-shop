import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotAShopUrl, readShopUrl, saveShopUrl, shopUrlFrom } from '../src/shopSetting.js';

describe('shopUrlFrom', () => {
  it('keeps only the origin of what was typed', () => {
    expect(shopUrlFrom('  https://printer.local:8443/jobs?x=1 ')).toBe('https://printer.local:8443');
  });

  it('refuses something that is not a URL', () => {
    expect(() => shopUrlFrom('printer.local')).toThrow(NotAShopUrl);
  });

  it('refuses a URL that is not http or https', () => {
    expect(() => shopUrlFrom('file:///tmp/index.html')).toThrow(NotAShopUrl);
  });
});

describe('the saved shop', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'menubar-'));
    file = join(directory, 'nested', 'settings.json');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('is nothing when nothing has been saved', () => {
    expect(readShopUrl(file)).toBeUndefined();
  });

  it('is what was saved, as its origin', () => {
    expect(saveShopUrl(file, 'http://shop.example:9000/')).toBe('http://shop.example:9000');
    expect(readShopUrl(file)).toBe('http://shop.example:9000');
  });

  it('is not saved when it is not a shop URL', () => {
    expect(() => saveShopUrl(file, 'nonsense')).toThrow(NotAShopUrl);
    expect(readShopUrl(file)).toBeUndefined();
  });

  it('is nothing when the file names no shop', () => {
    saveShopUrl(file, 'http://shop.example');
    writeFileSync(file, '{ "shopUrl": 7373 }');
    expect(readShopUrl(file)).toBeUndefined();
  });

  it('is nothing when the file is mangled', () => {
    saveShopUrl(file, 'http://shop.example');
    writeFileSync(file, '{ not json');
    expect(readShopUrl(file)).toBeUndefined();
  });
});
