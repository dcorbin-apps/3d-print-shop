import { describe, it, expect, afterEach } from '@jest/globals';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LOOPBACK } from '../../src/api';

// AIDEV-NOTE: (assumption test) what NODE and the kernel do when a server is told to listen, which is
// not the shop's to prove and is the only reason any test here opens a port. The shop's own decision
// - which address it asks for when nobody names one - is asked without a socket in tests/serve.test.ts.
//
// It is here rather than there because none of it can change by somebody editing this repository: a
// red one says node or the kernel moved, which is exactly what this suite is for.
describe('what listening actually gives back', () => {
  const listening: Server[] = [];

  afterEach(async () => {
    await Promise.all(listening.map((server) => new Promise<void>((closed) => server.close(() => closed()))));
    listening.length = 0;
  });

  const bound = (port: number, address: string): Promise<AddressInfo> =>
    new Promise((ready) => {
      const server = createServer();
      listening.push(server);
      server.listen(port, address, () => ready(server.address() as AddressInfo));
    });

  // The shop asks for port 0 so that a machine can run one without an operator choosing a number.
  it('chooses a port of its own when asked for none in particular', async () => {
    expect((await bound(0, LOOPBACK)).port).toBeGreaterThan(0);
  });

  it('binds the address it was told to, and says so', async () => {
    expect((await bound(0, LOOPBACK)).address).toBe('127.0.0.1');
  });
});
