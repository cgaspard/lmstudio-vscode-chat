#!/usr/bin/env node
// Render releasenotes/<version>.yaml into Markdown for a GitHub Release body.
// Standalone — no deps — uses a minimal YAML parser that covers our schema.
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Usage: render-release-notes.js <version>');
  process.exit(2);
}

const file = path.join('releasenotes', `${version}.yaml`);
if (!fs.existsSync(file)) {
  console.error(`Missing release notes file: ${file}`);
  process.exit(2);
}

const data = parseYaml(fs.readFileSync(file, 'utf8'));

const out = [];
out.push(`# v${data.version}`);
out.push('');
if (data.date) out.push(`_Released ${data.date}_`);
out.push('');

if (Array.isArray(data.highlights) && data.highlights.length) {
  out.push('## Highlights');
  for (const h of data.highlights) out.push(`- ${h}`);
  out.push('');
}

const sections = [
  ['added', 'Added'],
  ['changed', 'Changed'],
  ['fixed', 'Fixed'],
  ['removed', 'Removed'],
];
for (const [key, label] of sections) {
  const items = data[key];
  if (Array.isArray(items) && items.length) {
    out.push(`## ${label}`);
    for (const i of items) out.push(`- ${i}`);
    out.push('');
  }
}

out.push('---');
out.push('Install the `.vsix` attached to this release via:');
out.push('');
out.push('```bash');
out.push(`code --install-extension lmstudio-code-${data.version}.vsix`);
out.push('```');

process.stdout.write(out.join('\n') + '\n');

// ---- Minimal YAML parser for our restricted schema ----
function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const result = {};
  let currentList = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/);
    if (listMatch && currentList) {
      currentList.push(unquote(listMatch[1]));
      continue;
    }
    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const [, key, rest] = kvMatch;
      if (rest === '' || rest === '|') {
        result[key] = [];
        currentList = result[key];
      } else if (rest === '[]') {
        result[key] = [];
        currentList = null;
      } else {
        result[key] = unquote(rest);
        currentList = null;
      }
    }
  }
  return result;
}

function unquote(s) {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
