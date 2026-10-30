#!/usr/bin/env node
// Seed the traveler allowlist in D1 from a local, gitignored file.
//
//   npm run seed                 # reads ./allowlist.txt, writes to the live (remote) DB
//   npm run seed -- --local      # writes to the local dev DB used by `npm run dev`
//   npm run seed -- --file other.txt
//   npm run seed -- --prune      # also REMOVE people not in the file (deletes their data)
//
// File format: one person per line. Blank lines and anything after # are ignored.
//   Jane Smith          -> first "Jane", last "Smith" (split at the first space)
//   Mary Ann, Van Buren -> use a comma when either name has spaces

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DB_NAME = 'travel-time-db';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const local = args.includes('--local');
const prune = args.includes('--prune');
const fileIdx = args.indexOf('--file');
const file = path.resolve(root, fileIdx >= 0 ? args[fileIdx + 1] : 'allowlist.txt');

// Must match normalizeName() in src/api.js.
function normalizeName(s) {
  return String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function tidy(s) {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ');
}

function sqlString(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

let text;
try {
  text = readFileSync(file, 'utf8');
} catch {
  console.error(`Could not read ${file}\nCreate it with one "First Last" per line (it is gitignored).`);
  process.exit(1);
}

const people = new Map();
text.split(/\r?\n/).forEach((raw, i) => {
  const line = raw.replace(/#.*$/, '').trim();
  if (!line) return;
  let first, last;
  if (line.includes(',')) {
    [first, last] = line.split(',', 2).map(tidy);
  } else {
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (m) [first, last] = [tidy(m[1]), tidy(m[2])];
  }
  if (!first || !last) {
    console.error(`Line ${i + 1}: needs a first and last name: "${line}"`);
    process.exit(1);
  }
  if (first.length > 60 || last.length > 60) {
    console.error(`Line ${i + 1}: names must be 60 characters or fewer.`);
    process.exit(1);
  }
  people.set(`${normalizeName(first)}|${normalizeName(last)}`, { first, last });
});

if (!people.size) {
  console.error(`No names found in ${file}.`);
  process.exit(1);
}

const stmts = [];
for (const { first, last } of people.values()) {
  const f = normalizeName(first);
  const l = normalizeName(last);
  stmts.push(
    `INSERT INTO travelers (first_norm, last_norm, first_display, last_display) VALUES ` +
      `(${sqlString(f)}, ${sqlString(l)}, ${sqlString(first)}, ${sqlString(last)}) ` +
      `ON CONFLICT(first_norm, last_norm) DO UPDATE SET first_display = excluded.first_display, last_display = excluded.last_display;`
  );
}
if (prune) {
  const keep = [...people.keys()].map((k) => sqlString(k)).join(', ');
  stmts.push(`DELETE FROM travelers WHERE first_norm || '|' || last_norm NOT IN (${keep});`);
}

// Written next to this script (gitignored) and removed afterwards.
const sqlFile = path.join(root, 'scripts', `.seed-${process.pid}.sql`);
writeFileSync(sqlFile, stmts.join('\n') + '\n');

console.log(`Seeding ${people.size} name(s) into ${DB_NAME} (${local ? 'local' : 'remote'})${prune ? ', pruning others' : ''}...`);
const result = spawnSync(
  'npx',
  ['wrangler', 'd1', 'execute', DB_NAME, local ? '--local' : '--remote', '--file', sqlFile, '--yes'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
);
unlinkSync(sqlFile);

if (result.status !== 0) {
  console.error('\nSeeding failed. If wrangler says you are not logged in, run: npx wrangler login');
  process.exit(result.status ?? 1);
}
console.log('Done.');
