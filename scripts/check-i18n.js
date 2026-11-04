/* Fails when the Kinyarwanda and English halves of a dictionary drift apart:
   I18N (labels) and EC (error sentences) in public/assets/auth.js, the dropdown library's own
   I18N in public/assets/divisions.js, the interview's I18N in public/assets/interview.js, and the
   booking page's I18N plus its error map T. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/* Walk an object body one line at a time, skipping over string literals so a
   colon inside a sentence never reads as a key. I18N keys are quoted and dotted,
   EC keys are bare identifiers, and both dictionaries pack several entries per line. */
function entriesInLine(line) {
  const found = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < line.length && line[j] !== quote) { if (line[j] === '\\') j += 1; j += 1; }
      const after = line.slice(j + 1).match(/^\s*:/);
      if (after) {
        found.push({ key: line.slice(i + 1, j).replace(/\\(.)/g, '$1'), rest: line.slice(j + 1 + after[0].length) });
      }
      i = j < line.length ? j + 1 : line.length;
      continue;
    }
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line.slice(i));
    if (bare && /(^|[{[,])\s*$/.test(line.slice(0, i))) {
      found.push({ key: bare[1], rest: line.slice(i + bare[0].length) });
      i += bare[0].length;
      continue;
    }
    i += 1;
  }
  return found;
}

function walk(lines, dictionaryNames) {
  const heads = new RegExp(`^\\s*var (${dictionaryNames.join('|')}) = \\{$`);
  const blocks = {};
  const spans = {};
  let current = null;
  let lang = null;
  let depth = 0;
  let blockStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const head = heads.exec(line);
    if (head) {
      current = head[1];
      blocks[current] = { rw: [], en: [] };
      blockStart = i + 1;
      lang = null;
      depth = 1;
      continue;
    }
    if (!current) continue;
    const open = (line.match(/\{/g) || []).length;
    const close = (line.match(/\}/g) || []).length;
    const langStart = /^\s+(rw|en): \{$/.exec(line);
    if (langStart && depth === 1) {
      lang = langStart[1];
      depth += open - close;
      continue;
    }
    if (depth === 2 && lang) {
      for (const entry of entriesInLine(line)) {
        blocks[current][lang].push({ key: entry.key, rest: entry.rest, line: i + 1 });
      }
    }
    depth += open - close;
    if (depth <= 0) {
      spans[current] = [blockStart, i + 1];
      current = null;
      lang = null;
    }
  }
  return { blocks, spans };
}

const SOURCES = [
  { file: 'public/assets/auth.js', dictionaries: ['I18N', 'EC'] },
  { file: 'public/assets/divisions.js', dictionaries: ['I18N'] },
  { file: 'public/assets/interview.js', dictionaries: ['I18N'] },
  { file: 'public/index.html', dictionaries: ['I18N', 'T'] },
];

const problems = [];
const setOf = (list) => new Set(list.map((entry) => entry.key));
const definedLines = new Map();
const namespaces = new Set();
const collected = {};

for (const source of SOURCES) {
  const { blocks, spans } = walk(read(source.file).split('\n'), source.dictionaries);
  for (const name of source.dictionaries) {
    const block = blocks[name];
    const label = `${source.file} ${name}`;
    if (!block) {
      problems.push(`${name}: dictionary block not found in ${source.file}`);
      continue;
    }
    collected[label] = block;
    const seen = new Map();
    for (const [langName, list] of Object.entries(block)) {
      for (const entry of list) {
        if (!/^(['"[{])/.test(entry.rest.trim())) {
          problems.push(`${label}.${langName}: ${entry.key} has no plain string value (line ${entry.line})`);
        }
      }
    }
    for (const entry of block.rw) {
      if (seen.has(entry.key)) problems.push(`${label}.rw: duplicate key ${entry.key} (lines ${seen.get(entry.key)} and ${entry.line})`);
      seen.set(entry.key, entry.line);
      namespaces.add(entry.key.split('.')[0]);
    }
    for (const entry of block.en) namespaces.add(entry.key.split('.')[0]);
    const rwSet = setOf(block.rw);
    const enSet = setOf(block.en);
    for (const key of rwSet) if (!enSet.has(key)) problems.push(`${label}: missing in en: ${key}`);
    for (const key of enSet) if (!rwSet.has(key)) problems.push(`${label}: missing in rw: ${key}`);
    console.log(`check-i18n: ${source.file.replace('public/assets/', '')} ${name} rw ${block.rw.length} keys, en ${block.en.length} keys`);

    /* The dictionary lines define labels, they do not use them. Left in the scan they would make
       every key look referenced, so the definition blocks are cut out of the source first. */
    const lines = definedLines.get(source.file) || new Set();
    if (spans[name]) for (let n = spans[name][0]; n <= spans[name][1]; n += 1) lines.add(n);
    definedLines.set(source.file, lines);
  }
}

/* Phase 2: every label a page asks for must exist in BOTH languages of the file that owns it.
   Controllers reference keys with t('ns.key'); pages reference them with data-i18n attributes;
   the label maps (PAY_STATUS and friends) hold bare quoted keys, so any quoted dotted token whose
   first segment is a dictionary namespace is checked. */
const refs = new Map();
const noteRef = (key, where) => {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*$/.test(key)) return;
  if (!namespaces.has(key.split('.')[0])) return;
  if (!refs.has(key)) refs.set(key, []);
  refs.get(key).push(where);
};

const codeOf = (rel) => {
  const source = read(rel);
  const cut = definedLines.get(rel);
  if (!cut) return source;
  return source.split('\n').filter((_line, index) => !cut.has(index + 1)).join('\n');
};

for (const js of ['auth', 'divisions', 'interview', 'rider', 'passenger', 'admin']) {
  const source = codeOf(`public/assets/${js}.js`);
  for (const match of source.matchAll(/t\(\s*'([a-zA-Z0-9_.]+)'/g)) noteRef(match[1], `${js}.js`);
  for (const match of source.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*)'/g)) noteRef(match[1], `${js}.js`);
}
for (const page of ['login', 'signup', 'rider', 'passenger', 'admin']) {
  const source = read(`public/${page}.html`);
  for (const match of source.matchAll(/data-i18n(?:-ph|-title|-tip)?="([^"]+)"/g)) {
    for (const key of match[1].split(/\s+/)) noteRef(key, `${page}.html`);
  }
}

/* The booking page owns its dictionary and asks for labels with double-quoted t("ns.key"). */
const booking = codeOf('public/index.html');
for (const match of booking.matchAll(/"([a-z][a-z0-9_]*\.[a-z][a-zA-Z0-9_.]*)"/g)) noteRef(match[1], 'index.html');
for (const match of booking.matchAll(/data-i18n(?:-ph|-title|-tip)?="([^"]+)"/g)) {
  for (const key of match[1].split(/\s+/)) noteRef(key, 'index.html');
}

const known = new Set();
const enKnown = new Set();
for (const block of Object.values(collected)) {
  for (const entry of block.rw) known.add(entry.key);
  for (const entry of block.en) enKnown.add(entry.key);
}

for (const [key, where] of [...refs.entries()].sort()) {
  if (!known.has(key)) problems.push(`unknown label key '${key}' used by ${where.join(', ')}`);
  else if (!enKnown.has(key)) problems.push(`'${key}' has no English half (used by ${where.join(', ')})`);
}
console.log(`check-i18n: ${refs.size} label keys referenced by the shared pages`);

/* Dead copy is not a bug, but it drifts: a key nobody asks for is a key nobody translates. */
const unusedKeyList = [...known].filter((key) => key.includes('.') && !refs.has(key));
if (unusedKeyList.length) {
  console.log(`check-i18n: ${unusedKeyList.length} label keys defined but not referenced: ${unusedKeyList.sort().join(', ')}`);
}

if (problems.length) {
  for (const problem of problems) console.error(`  x ${problem}`);
  process.exit(1);
}
console.log('check-i18n: dictionaries match');
