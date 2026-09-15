import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK, serve } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: which address a shop takes when nobody says, which is the shop's decision and not
// node's - node binds wherever it is told. Observed by binding because there is no other way to see
// a default: asserting that LOOPBACK is '127.0.0.1' would be asserting the constant against itself.
//
// An ephemeral port in this process, not a spawned one. What a spawned process is for is elsewhere.
describe('where a shop listens', () => {
  let where: DataLayout;
  let listening: Server[];

  const callers = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf('a-token') }] },
  ]);

  const serving = async (at?: string): Promise<AddressInfo> => {
    const server = await serve(new JobStore(where), 0, { callers: () => callers }, ...(at === undefined ? [] : [at]));
    listening.push(server);

    return server.address() as AddressInfo;
  };

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-serve-');
    listening = [];
  });

  afterEach(async () => {
    await Promise.all(listening.map((server) => new Promise<void>((closed) => server.close(() => closed()))));
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // AIDEV-NOTE: a token travels in the clear over http, so loopback is the default even though every
  // route is authenticated - and reaching past it is the operator's decision rather than something
  // they get by omission.
  it('is loopback when nobody said, which is the interface with no network on it', async () => {
    expect((await serving()).address).toBe('127.0.0.1');
    expect(LOOPBACK).toBe('127.0.0.1');
  });

  // `::1` rather than an address off this machine: it says the address is carried through to the
  // listener without opening a port to the network to prove it.
  it('is the address it was given, when one was', async () => {
    expect((await serving('::1')).address).toBe('::1');
  });

  it('takes a port of its own choosing when asked for none in particular', async () => {
    expect((await serving()).port).toBeGreaterThan(0);
  });
});
