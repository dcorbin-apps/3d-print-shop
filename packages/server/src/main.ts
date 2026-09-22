#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from './cli.js';

// AIDEV-NOTE: read HERE, at the entry point, because this is the one module that only ever runs from
// an installed package - dist/main.js beside the package.json npm or the installer put there. A test
// that imports cli.ts from source has no installed package to ask, and is handed a version instead.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

process.exitCode = await run(process.argv, undefined, { version });
