import { describe, it, expect } from '@jest/globals';

// AIDEV-NOTE: the two things this client is built on that are undici's rather than its own. What it
// DOES about each is tests/whatTheClientSends.test.ts, asked without a socket - a red line there
// says somebody broke the client, and a red line here says the world moved.
describe('what fetch does', () => {
  // The client turns this into a sentence naming the shop and saying how to start one. Without the
  // rejection there would be nothing to turn.
  it('rejects rather than answering when nothing is listening', async () => {
    await expect(fetch('http://127.0.0.1:1/jobs')).rejects.toThrow();
  });

  // AIDEV-NOTE: what lets a submission be built as a FormData and still arrive as a multipart body
  // the shop can parse - the boundary, and the parts in the order they were appended. The shop reads
  // the description before a byte of gcode, so that order is the contract rather than a convenience.
  it('serialises a form in the order its parts were appended, with a boundary of its own', async () => {
    const form = new FormData();
    form.append('job', JSON.stringify({ filaments: ['PLA'] }));
    form.append('gcode', new Blob(['G1 X0\n']), 'print.gcode');

    const sending = new Request('http://shop.local/jobs', { method: 'POST', body: form });
    const body = await sending.text();

    expect(sending.headers.get('content-type')).toContain('multipart/form-data; boundary=');
    expect(body.indexOf('name="job"')).toBeLessThan(body.indexOf('name="gcode"'));
    expect(body).toContain('G1 X0');
  });
});
