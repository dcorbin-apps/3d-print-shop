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
}

export interface Asking {
  token?: string;
  /** A JSON body. Sent as one, with the content type that says so. */
  json?: unknown;
  /** A body already built - a multipart submission, or something deliberately malformed. */
  body?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

export function drive(api: Express) {
  return function asked(method: string, url: string, asking: Asking = {}): Promise<Answer> {
    const payload = asking.json === undefined ? asking.body : Buffer.from(JSON.stringify(asking.json));
    const contentType = asking.contentType ?? (asking.json === undefined ? undefined : 'application/json');

    const request = new IncomingMessage(new Socket());
    request.method = method;
    request.url = url;
    request.headers = {
      host: 'shop.local',
      ...(asking.token === undefined ? {} : { authorization: `Bearer ${asking.token}` }),
      ...(payload === undefined ? {} : { 'content-length': String(payload.length) }),
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
      ...asking.headers,
    };
    if (payload !== undefined) request.push(payload);
    request.push(null);
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
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename === undefined ? '' : `; filename="${filename}"`}\r\n\r\n`),
      Buffer.isBuffer(value) ? value : Buffer.from(value),
      Buffer.from('\r\n'),
    ])
  );

  return Buffer.concat([...written, Buffer.from(`--${boundary}--\r\n`)]);
}

export const MULTIPART = 'multipart/form-data; boundary=aboundary';
