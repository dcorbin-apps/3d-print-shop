import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { LOOPBACK, serve } from '../src/api';
import type { StartListening } from '../src/api';
import { Callers } from '../src/credentials';
import { JobStore } from '../src/JobStore';
import { digestOf } from '../src/secrets';
import { aDataDirectory, parentOf } from './aDataDirectory';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: (UT) which address a shop takes when nobody says, which is the shop's decision and not
// node's - node binds wherever it is told. So what is asked here is what the shop ASKED FOR, and no
// socket is opened to find out: these used to bind three ephemeral ports to read back an answer the
// shop had already decided before the kernel was involved.
//
// What node does with a port of 0 is not the shop's decision at all and is pinned in
// tests/assumptions/whatListeningGives.test.ts, where the things this repository did not write live.
describe('where a shop listens', () => {
  let where: DataLayout;
  let asked: { port: number; address: string }[];

  const callers = new Callers([
    { caller: { id: 'dave', name: 'dave', role: 'admin' }, credentials: [{ kind: 'token', hash: digestOf('a-token') }] },
  ]);

  // Enough of a server for `serve` to hand back and hang an error listener on. Nothing binds.
  const noSocket: StartListening = (_api: Express, port: number, address: string, ready: () => void): Server => {
    asked.push({ port, address });
    setImmediate(ready);

    return { on: () => undefined } as unknown as Server;
  };

  // AIDEV-NOTE: `at` is handed over even when it is undefined, which is what makes the DEFAULT the
  // thing under test - an omitted argument and an explicit `undefined` both take a default parameter,
  // and only one of them leaves room for the listener in the position after it.
  const serving = async (at?: string): Promise<void> => {
    await serve(new JobStore(where), 7373, { callers: () => callers }, at, noSocket);
  };

  beforeEach(async () => {
    where = await aDataDirectory('print-shop-serve-');
    asked = [];
  });

  afterEach(async () => {
    await rm(parentOf(where), { recursive: true, force: true });
  });

  // AIDEV-NOTE: a token travels in the clear over http, so loopback is the default even though every
  // route is authenticated - and reaching past it is the operator's decision rather than something
  // they get by omission. Said as the literal rather than against LOOPBACK, which would be the
  // constant asserted against itself.
  it('is loopback when nobody said, which is the interface with no network on it', async () => {
    await serving();

    expect(asked[0]?.address).toBe('127.0.0.1');
    expect(LOOPBACK).toBe('127.0.0.1');
  });

  it('is the address it was given, when one was', async () => {
    await serving('0.0.0.0');

    expect(asked[0]?.address).toBe('0.0.0.0');
  });

  it('is the port it was given, which the shop has no opinion about', async () => {
    await serving();

    expect(asked[0]?.port).toBe(7373);
  });
});
