import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Log } from './log.js';
import { png } from './png.js';
import { renderBeads } from './renderBeads.js';
import { Toolpath } from './Toolpath.js';

/** What a job looks like, as bytes a browser can show. */
export interface Picture {
  contentType: 'image/png' | 'image/jpeg';
  bytes: Buffer;
  /** Drawn by the shop from the moves, rather than embedded by whatever sliced the plate. */
  rendered: boolean;
}

/** Where a job's gcode is, and where a picture of it may be kept - the store, as far as a picture needs one. */
export interface PictureShelf {
  gcodeStream(id: number): Promise<Readable>;
  keptPicture(id: number, version: string): Promise<Buffer | undefined>;
  keepPicture(id: number, version: string, picture: Buffer): Promise<void>;
}

// AIDEV-NOTE: CHANGE THIS whenever what renderBeads draws changes. A kept render is found by this
// name, so a new one leaves every job drawn again once, and an unchanged one leaves every job
// showing the picture the old drawing made for it.
export const RENDER_VERSION = 'render-2.png';

// AIDEV-NOTE: only formats a browser shows. A slicer also embeds QOI, for the printer's own screen,
// and showing one would mean decoding it here - so a plate that carries only QOI is rendered
// instead. The magic bytes are checked because nothing else says the block is what its header claims.
const EMBEDDED: Record<string, { contentType: Picture['contentType']; magic: number[] }> = {
  '': { contentType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { contentType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
};

const THUMBNAIL_BEGIN = /^;\s*thumbnail(?:_(\w+))?\s+begin\s+(\d+)x(\d+)/;
const THUMBNAIL_END = /^;\s*thumbnail(?:_\w+)?\s+end/;

// AIDEV-NOTE: only a RENDER is kept. An embedded picture is read from the head of the file for
// almost nothing, and keeping it would be a copy of something already on disk.
/** A job's picture - kept from the last time it was rendered, or worked out now and kept if it was. */
export async function pictureOfJob(shelf: PictureShelf, id: number, log: Log): Promise<Picture> {
  const kept = await shelf.keptPicture(id, RENDER_VERSION);
  if (kept !== undefined) return { contentType: 'image/png', bytes: kept, rendered: true };

  const picture = await pictureOf(await shelf.gcodeStream(id));
  if (picture.rendered) {
    // Not keeping it costs a render next time and nothing else, so the picture is still answered.
    await shelf.keepPicture(id, RENDER_VERSION, picture.bytes).catch((failure: unknown) => {
      log.error('a rendered picture could not be kept, so it will be rendered again', { job: id, reason: String(failure) });
    });
  }

  return picture;
}

/**
 * The largest image the slicer embedded in the head of the file, or else a render of the plastic
 * its moves lay down. Reads no further than the head when the slicer left a picture.
 */
export async function pictureOf(gcode: Readable): Promise<Picture> {
  const head = new EmbeddedPictures();
  const toolpath = new Toolpath();
  let inHead = true;

  try {
    for await (const line of createInterface({ input: gcode, crlfDelay: Infinity })) {
      const command = line.split(';')[0]?.trim() ?? '';

      if (inHead && command === '') {
        head.read(line);
        continue;
      }

      if (inHead) {
        inHead = false;
        const embedded = head.largest();
        if (embedded !== undefined) return embedded;
      }

      toolpath.follow(command);
    }
  } finally {
    gcode.destroy();
  }

  return head.largest() ?? { contentType: 'image/png', bytes: png(renderBeads(toolpath.beads())), rendered: true };
}

class EmbeddedPictures {
  private reading?: { format: string; area: number; base64: string[] };
  private best?: { area: number; picture: Picture };

  read(line: string): void {
    const begun = THUMBNAIL_BEGIN.exec(line);
    if (begun !== null) {
      this.reading = { format: (begun[1] ?? '').toLowerCase(), area: Number(begun[2]) * Number(begun[3]), base64: [] };
      return;
    }

    if (this.reading === undefined) return;

    if (THUMBNAIL_END.test(line)) {
      this.finish(this.reading);
      this.reading = undefined;
      return;
    }

    this.reading.base64.push(line.replace(/^;\s*/, '').trim());
  }

  largest(): Picture | undefined {
    return this.best?.picture;
  }

  private finish({ format, area, base64 }: { format: string; area: number; base64: string[] }): void {
    const kind = EMBEDDED[format];
    if (kind === undefined || (this.best !== undefined && this.best.area >= area)) return;

    const bytes = Buffer.from(base64.join(''), 'base64');
    if (!kind.magic.every((byte, at) => bytes[at] === byte)) return;

    this.best = { area, picture: { contentType: kind.contentType, bytes, rendered: false } };
  }
}
