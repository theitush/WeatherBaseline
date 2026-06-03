// Sync the curated cell index into the frontend's public/ dir so the build
// serves it at /cells.csv. data/cells.csv (repo root) is the tracked source of
// truth; public/cells.csv is a generated copy and is gitignored. Runs on
// `predev` and `prebuild` so the two can never drift.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../data/cells.csv');
const dest = resolve(here, '../public/cells.csv');

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`synced cells.csv → ${dest}`);
