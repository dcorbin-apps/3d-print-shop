import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { createOctoPrintApp } from '../src/octoPrintServer';
import { PushSockets } from '../src/pushSockets';
import { SimulatedPrinter } from '../src/simulatedPrinter';
import type { CompleteJob, JobSubmittedHandler, SubmittedJob } from '../src/octoPrintServer';

// AIDEV-NOTE: the HTTP half driven without a port. An express app is a function of a request, so the
// real routes and the real multer run here; the request object is the only thing made up, and it is
// not what any of this claims. A multipart body is built by hand for the same reason - it is the
// INPUT, and what busboy and multer make of one is pinned in the server's assumption suite.
describe('the shape octo-sim answers over HTTP', () => {
  let printer: SimulatedPrinter;
  let pushes: PushSockets;
  let submitted: { job: SubmittedJob; complete: CompleteJob }[];
  let onJobSubmitted: JobSubmittedHandler;
  let api: ReturnType<typeof createOctoPrintApp>;

  interface Answer {
    status: number;
    body: unknown;
  }

  const BOUNDARY = 'aboundary';

  function uploadOf(filename: string, folder: string): Buffer {
    const part = (disposition: string, value: string): string =>
      `--${BOUNDARY}\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n${value}\r\n`;

    return Buffer.from(
      `${part(`name="file"; filename="${filename}"`, 'G1 X0 Y0\n')}${part('name="path"', folder)}${part('name="print"', 'true')}--${BOUNDARY}--\r\n`,
    );
  }

  function answered(method: string, url: string, payload?: Buffer, contentType?: string, headers: Record<string, string> = {}): Promise<Answer> {
    const request = new IncomingMessage(new Socket());
    request.method = method;
    request.url = url;
    request.headers = {
      host: 'octopi.local',
      ...(payload === undefined ? {} : { 'content-type': contentType ?? 'application/json', 'content-length': String(payload.length) }),
      ...headers,
    };
    if (payload !== undefined) request.push(payload);
    request.push(null);
    // AIDEV-NOTE: what node's own parser sets when a message has arrived whole. Without it multer
    // sees the stream end, finds the message incomplete, and answers "Request aborted" - so the flag
    // is not a convenience, it is the difference between a request and a truncated one.
    request.complete = true;

    const response = new ServerResponse(request);
    const wire = new PassThrough();
    const written: Buffer[] = [];
    wire.on('data', (chunk: Buffer) => written.push(chunk));
    response.assignSocket(wire as unknown as Socket);

    return new Promise((settled) => {
      response.on('finish', () => {
        const said = Buffer.concat(written).toString();
        const body = said.slice(said.indexOf('\r\n\r\n') + 4);
        settled({ status: response.statusCode, body: body === '' ? undefined : (JSON.parse(body) as unknown) });
      });
      api.app(request, response);
    });
  }

  const uploading = (filename = 'tray.gcode', folder = 'plates'): Promise<Answer> =>
    answered('POST', '/api/files/local', uploadOf(filename, folder), `multipart/form-data; boundary=${BOUNDARY}`, { 'x-api-key': 'a-key' });

  beforeEach(() => {
    let issued = 0;
    printer = new SimulatedPrinter(
      () => 1_700_000_000_000,
      () => `sess-${++issued}`,
    );
    pushes = new PushSockets(printer);
    submitted = [];
    onJobSubmitted = jest.fn<JobSubmittedHandler>((job, complete) => {
      submitted.push({ job, complete });
    });
    api = createOctoPrintApp(printer, pushes, onJobSubmitted);
  });

  describe('an upload', () => {
    // AIDEV-NOTE: the client reads this back to learn where the file actually went - a completion
    // event carries the path the machine FILED it under, and OctoPrint does not always file it where
    // it was asked to. A simulator answering a bare `done` leaves the client with nothing but its
    // own guess.
    it('is answered with the path it was filed under', async () => {
      expect(await uploading()).toEqual({
        status: 200,
        body: { done: true, files: { local: { name: 'tray.gcode', path: 'plates/tray.gcode', origin: 'local' } } },
      });
    });

    it('is handed to whoever is waiting for a job, with the gcode that came with it', async () => {
      await uploading();

      expect(submitted).toHaveLength(1);
      expect(submitted[0].job).toMatchObject({ remotePath: 'plates/tray.gcode', filename: 'tray.gcode' });
      expect(submitted[0].job.gcode.toString()).toBe('G1 X0 Y0\n');
    });

    it('is refused with nothing to print', async () => {
      const refused = await answered(
        'POST',
        '/api/files/local',
        Buffer.from(`--${BOUNDARY}--\r\n`),
        `multipart/form-data; boundary=${BOUNDARY}`,
      );

      expect(refused.status).toBe(400);
    });

    // AIDEV-NOTE: a real printer runs one job at a time. Nothing that drives this submits two at
    // once - a printer already holding a job takes no other - so no acceptance test springs this
    // trap, and a regression would let a future scheduling bug overlap jobs silently.
    it('is refused while one is still printing, saying which', async () => {
      expect((await uploading('first.gcode')).status).toBe(200);

      expect(await uploading('second.gcode')).toEqual({
        status: 409,
        body: { error: 'Printer is busy: plates/first.gcode is still printing' },
      });
    });

    it('is taken again once the first has finished', async () => {
      await uploading('first.gcode');
      submitted[0].complete('PrintDone');

      expect((await uploading('second.gcode')).status).toBe(200);
    });
  });

  it('answers a login with a session a push socket is then let in on', async () => {
    const { body } = await answered('POST', '/api/login', Buffer.from(JSON.stringify({ passive: true })));
    const { name, session } = body as { name: string; session: string };

    expect(printer.authenticates(JSON.stringify({ auth: `${name}:${session}` }))).toBe(true);
  });

  describe('asking after a file', () => {
    it('says there is none before anything was uploaded', async () => {
      expect((await answered('GET', '/api/files/local/plates/tray.gcode')).status).toBe(404);
    });

    it('answers with what the printer has of one', async () => {
      await uploading();

      expect(await answered('GET', '/api/files/local/plates/tray.gcode')).toEqual({
        status: 200,
        body: { name: 'tray.gcode', path: 'plates/tray.gcode', type: 'machinecode' },
      });
    });

    // A name that needed encoding on the way in is the file it names, not a different one.
    it('finds one whose name had to be escaped to ask for it', async () => {
      await uploading('a tray.gcode');

      expect((await answered('GET', '/api/files/local/plates/a%20tray.gcode')).status).toBe(200);
    });

    it('carries what the printer recorded of a print', async () => {
      await uploading();
      submitted[0].complete('PrintDone');

      const { body } = await answered('GET', '/api/files/local/plates/tray.gcode');

      expect(body).toMatchObject({ prints: { success: 1, failure: 0 } });
    });
  });

  // AIDEV-NOTE: the key is never CHECKED - this is a test double, not a security boundary - but a
  // client rebuilt with a corrected key is otherwise indistinguishable from one that kept the old.
  it('remembers every key a request presented, in the order they came', async () => {
    await uploading();
    await answered('GET', '/api/files/local/plates/tray.gcode', undefined, undefined, { 'x-api-key': 'a-corrected-key' });

    expect(api.keysPresented()).toEqual(['a-key', 'a-corrected-key']);
  });
});
