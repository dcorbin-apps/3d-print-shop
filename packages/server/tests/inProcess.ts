import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { Express } from 'express';

// AIDEV-NOTE: an express app is a function of a request, so the real router, the real middleware and
// the real mount order all answer here with no listener. The request object is the only thing made
// up, and it is not what any of these tests claim - what express derives from a raw request LINE is
// pinned in tests/assumptions/theRequestLine.test.ts, which is the one thing this cannot say.
//
// A test that reads a status code off a socket has told you a broad path broke. This tells you the
// same thing in a millisecond, and what it costs is only the part that was never the point.

/** What came back: the status, the headers, and the body already read. */
export interface Answer {
  status: number;
  body: unknown;
  text: string;
  header(name: string): string | undefined;
  /** The cookie a Set-Cookie set, without its attributes - what a browser would send back. */
  cookie(): string;
  /** Whether the shop read the whole request, which is what lets the message complete. */
  wasDrained(): boolean;
  /** How much of the body the shop actually asked for. */
  handedOver(): number;
}

export interface Asking {
  token?: string;
  /** A JSON body. Sent as one, with the content type that says so. */
  json?: unknown;
  /** A body already built - a multipart submission, or something deliberately malformed. */
  body?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
  /** The address the request arrived FROM - what a socket calls its remote address. None unless said. */
  from?: string;
}

/** The host `drive` says a request arrived at, and the origin a page this shop served would name. */
export const HOST = 'shop.local';
export const HERE = `http://${HOST}`;

export function drive(api: Express) {
  return function asked(method: string, url: string, asking: Asking = {}): Promise<Answer> {
    const payload = asking.json === undefined ? asking.body : Buffer.from(JSON.stringify(asking.json));
    const contentType = asking.contentType ?? (asking.json === undefined ? undefined : 'application/json');

    const socket = new Socket();
    if (asking.from !== undefined) Object.defineProperty(socket, 'remoteAddress', { value: asking.from });

    const request = new IncomingMessage(socket);
    request.method = method;
    request.url = url;
    request.headers = {
      host: HOST,
      ...(asking.token === undefined ? {} : { authorization: `Bearer ${asking.token}` }),
      ...(payload === undefined ? {} : { 'content-length': String(payload.length) }),
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
      ...asking.headers,
    };
    // AIDEV-NOTE: handed over only when it is ASKED for, which is what a socket does. Pushing the
    // whole body at once builds a request with no flow control, and a reader that stops reading then
    // looks exactly like one that read everything - which is how a missing drain went invisible here
    // while a real socket caught it. See "is drained even when it is refused" in jobRoutes.
    let handedOver = 0;
    request._read = function (): void {
      if (payload === undefined || handedOver >= payload.length) {
        this.push(null);
        return;
      }

      const next = payload.subarray(handedOver, handedOver + HANDED_OVER_AT_A_TIME);
      handedOver += next.length;
      this.push(next);
    };
    // AIDEV-NOTE: what node's own parser sets when a message has arrived whole. Without it multer and
    // busboy see the stream end, find the message incomplete, and answer "Request aborted" - so this
    // is not a convenience, it is the difference between a request and a truncated one.
    request.complete = true;

    const response = new ServerResponse(request);
    const wire = new PassThrough();
    const written: Buffer[] = [];
    wire.on('data', (chunk: Buffer) => written.push(chunk));
    response.assignSocket(wire as unknown as Socket);

    return new Promise<Answer>((settled) => {
      response.on('finish', () => {
        const said = Buffer.concat(written).toString();
        const text = said.slice(said.indexOf('\r\n\r\n') + 4);
        const setCookie = response.getHeader('set-cookie');

        settled({
          status: response.statusCode,
          text,
          body: parsed(text),
          wasDrained: () => request.readableEnded,
          handedOver: () => handedOver,
          header: (name) => {
            const value = response.getHeader(name);
            return value === undefined ? undefined : String(value);
          },
          cookie: () => String(Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')).split(';')[0],
        });
      });

      api(request, response);
    });
  };
}

function parsed(text: string): unknown {
  if (text === '') return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A multipart body, built by hand because the ORDER of the parts is part of what is being asked. */
export function multipart(parts: { name: string; value: string | Buffer; filename?: string }[], boundary = 'aboundary'): Buffer {
  const written = parts.map(({ name, value, filename }) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n\r\n`,
      ),
      Buffer.isBuffer(value) ? value : Buffer.from(value),
      Buffer.from('\r\n'),
    ]),
  );

  return Buffer.concat([...written, Buffer.from(`--${boundary}--\r\n`)]);
}

export const MULTIPART = 'multipart/form-data; boundary=aboundary';

/** As much as a request hands over before it is asked again - node's own default for a socket. */
const HANDED_OVER_AT_A_TIME = 16 * 1024;

// AIDEV-NOTE: a `fetch` that reaches an express app instead of a socket, so a client and the shop it
// talks to can meet in one process. Undici serialises the request for real - a multipart body gets
// its boundary from the same code that would write it to a wire - and express routes and answers it
// for real. What is skipped is the wire itself, and what node's parser makes of one is pinned in
// tests/assumptions/theRequestLine.test.ts.
//
// The response carries express's own status and headers rather than invented ones, because a client
// reads them: 201 against 200 is the whole difference between adding a printer and changing one.
export function throughTheApp(api: Express): typeof fetch {
  return (async (asked: string | URL | Request, sent?: RequestInit): Promise<Response> => {
    const sending = new Request(asked as string, sent);
    const payload = Buffer.from(await sending.arrayBuffer());

    const request = new IncomingMessage(new Socket());
    request.method = sending.method;
    const where = new URL(sending.url);
    request.url = `${where.pathname}${where.search}`;
    request.headers = Object.fromEntries([...sending.headers.entries()]);
    if (payload.length > 0) request.headers['content-length'] = String(payload.length);

    let handedOver = 0;
    request._read = function (): void {
      if (handedOver >= payload.length) {
        this.push(null);
        return;
      }

      const next = payload.subarray(handedOver, handedOver + HANDED_OVER_AT_A_TIME);
      handedOver += next.length;
      this.push(next);
    };

    const response = new ServerResponse(request);
    const wire = new PassThrough();
    const written: Buffer[] = [];
    wire.on('data', (chunk: Buffer) => written.push(chunk));
    response.assignSocket(wire as unknown as Socket);

    return new Promise<Response>((answered) => {
      response.on('finish', () => {
        const said = Buffer.concat(written).toString();
        const body = said.slice(said.indexOf('\r\n\r\n') + 4);
        // 204 and 304 may carry no body at all, and undici refuses to build one that does.
        const carries = response.statusCode !== 204 && response.statusCode !== 304 && body !== '';

        answered(
          new Response(carries ? body : null, {
            status: response.statusCode,
            headers: Object.entries(response.getHeaders()).flatMap(([name, value]) =>
              value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : String(value)] as [string, string]],
            ),
          }),
        );
      });

      api(request, response);
    });
  }) as typeof fetch;
}
