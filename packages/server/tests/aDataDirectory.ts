import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { layoutUnder } from '../src/dataLayout';
import type { DataLayout } from '../src/dataLayout';

// AIDEV-NOTE: the three directories an installer would have made, under one temporary parent. Every
// suite here wants the same thing and the store deliberately will not make them itself - a shop that
// created the place it keeps work would create it wherever it was mispointed, which is work put
// somewhere nobody is looking.
/** A data directory as an installed machine would have one, somewhere temporary. */
export async function aDataDirectory(called = 'print-shop-'): Promise<DataLayout> {
  const where = layoutUnder(await mkdtemp(path.join(tmpdir(), called)));

  await mkdir(where.jobs, { recursive: true, mode: 0o700 });
  await mkdir(where.state, { recursive: true, mode: 0o700 });

  return where;
}

/** The parent the three are under, for a test that has to remove it or look inside it. */
export function parentOf(where: DataLayout): string {
  return path.dirname(where.jobs);
}
