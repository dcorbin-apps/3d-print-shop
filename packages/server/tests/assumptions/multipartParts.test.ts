import { describe, it, expect } from '@jest/globals';
import busboy from 'busboy';
import { Readable } from 'node:stream';

// AIDEV-NOTE: what busboy does at the edges the shop's submission route leans on. There is no
// fileSize among `SUBMISSION_LIMITS` deliberately - the store caps the gcode at the byte it is
// already counting - so what is pinned here is the rest: the order parts arrive in, the flag that
// says a description was cut short, and that a part past a count is DISCARDED rather than raised.
//
// The route is built on all three. It reads the description before a byte of gcode so a hopeless job
// can be refused without being sent tens of megabytes; it answers 413 off `info.valueTruncated`; and
// it has no `filesLimit` listener at all, because a part beyond the count being dropped quietly is
// what it wants - raising there would answer 413 with the job it denies already in the data directory.
describe('what busboy makes of a submission', () => {
  const FIELD_SIZE = 32;
  const LIMITS = { files: 1, fields: 4, parts: 8, fieldSize: FIELD_SIZE, fieldNameSize: 100 };
  const BOUNDARY = 'aboundary';

  interface Part {
    name: string;
    value: string;
    filename?: string;
  }

  interface Seen {
    order: string[];
    fields: { name: string; value: string; truncated: boolean }[];
    files: { name: string; contents: string }[];
    limits: string[];
    errors: string[];
  }

  function bodyOf(parts: Part[]): Buffer {
    const written = parts.map(
      ({ name, value, filename }) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"` +
        `${filename === undefined ? '' : `; filename="${filename}"`}\r\n\r\n${value}\r\n`
    );

    return Buffer.from(`${written.join('')}--${BOUNDARY}--\r\n`);
  }

  // Built by hand rather than by FormData, because the ORDER of the parts and the exact length of a
  // value are the questions - and a helper that assembles them is a second opinion about both.
  function reading(parts: Part[]): Promise<Seen> {
    const seen: Seen = { order: [], fields: [], files: [], limits: [], errors: [] };
    const stream = busboy({ headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, limits: LIMITS });

    return new Promise((done) => {
      stream.on('field', (name, value, info) => {
        seen.order.push(`field:${name}`);
        seen.fields.push({ name, value, truncated: info.valueTruncated });
      });
      stream.on('file', (name, contents) => {
        seen.order.push(`file:${name}`);
        const got: Buffer[] = [];
        contents.on('data', (chunk: Buffer) => got.push(chunk));
        contents.on('end', () => seen.files.push({ name, contents: Buffer.concat(got).toString() }));
      });
      stream.on('filesLimit', () => seen.limits.push('files'));
      stream.on('fieldsLimit', () => seen.limits.push('fields'));
      stream.on('partsLimit', () => seen.limits.push('parts'));
      stream.on('error', (why: unknown) => seen.errors.push(String(why)));
      stream.on('close', () => done(seen));

      Readable.from([bodyOf(parts)]).pipe(stream);
    });
  }

  const description = (value = '{"filaments":["PLA"]}'): Part => ({ name: 'job', value });
  const gcode = (value = 'G1 X0\n', filename = 'print.gcode'): Part => ({ name: 'gcode', value, filename });

  describe('the order parts arrive in', () => {
    // The whole of the shop's contract that a description comes first: it is only true because busboy
    // announces parts in the order the body wrote them, at the moment each one starts.
    it('is the order the body wrote them', async () => {
      expect((await reading([description(), gcode()])).order).toEqual(['field:job', 'file:gcode']);
    });

    // And it does not helpfully sort fields ahead of files, which is what would make the route's
    // check of "has the description arrived yet" always pass and never mean anything.
    it('is not fields first when the body put the file first', async () => {
      expect((await reading([gcode(), description()])).order).toEqual(['file:gcode', 'field:job']);
    });
  });

  describe('a description at the size limit', () => {
    it('is whole and unflagged below it', async () => {
      const [field] = (await reading([description('x'.repeat(FIELD_SIZE - 1))])).fields;

      expect(field).toMatchObject({ value: 'x'.repeat(FIELD_SIZE - 1), truncated: false });
    });

    it('is cut and flagged above it', async () => {
      const [field] = (await reading([description('x'.repeat(FIELD_SIZE + 10))])).fields;

      expect(field).toMatchObject({ value: 'x'.repeat(FIELD_SIZE), truncated: true });
    });

    // AIDEV-NOTE: the edge, and it is off by one. Busboy flags a value as truncated on REACHING
    // fieldSize rather than passing it, so a description of exactly the limit arrives whole and is
    // reported cut - and the shop answers "the job part is longer than 1048576 bytes" about one that
    // is not longer. api.ts says this trait is "exactly that mistake waiting to happen" and avoids it
    // by having no fileSize; the same trait applies to fieldSize, which it does use. See PLAN.md.
    it('is whole and flagged anyway at exactly it', async () => {
      const [field] = (await reading([description('x'.repeat(FIELD_SIZE))])).fields;

      expect(field).toMatchObject({ value: 'x'.repeat(FIELD_SIZE), truncated: true });
    });
  });

  // AIDEV-NOTE: discarded, not raised, which is what the route is built on - it registers no listener
  // for any of these. A second gcode part is dropped and the submission stands on the first.
  describe('a part past a limit', () => {
    it('is dropped, and the ones within the limit still arrive', async () => {
      const seen = await reading([description(), gcode('G1 X0\n'), gcode('G2 X9\n', 'another.gcode')]);

      expect(seen.files).toEqual([{ name: 'gcode', contents: 'G1 X0\n' }]);
      expect(seen.limits).toEqual(['files']);
      expect(seen.errors).toEqual([]);
    });

    it('is dropped for a field too, and says which limit it was', async () => {
      const seen = await reading([1, 2, 3, 4, 5].map((n) => ({ name: `f${n}`, value: String(n) })));

      expect(seen.fields.map((field) => field.name)).toEqual(['f1', 'f2', 'f3', 'f4']);
      expect(seen.limits).toEqual(['fields']);
    });

    // The stream still ends normally, which is what lets the route decide on `close` whether it ever
    // got a gcode part rather than being left waiting on one.
    it('leaves the stream to end the way a whole one does', async () => {
      const seen = await reading([description(), gcode(), gcode('G2 X9\n', 'another.gcode')]);

      expect(seen.errors).toEqual([]);
    });
  });
});
