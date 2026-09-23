// Prints the body of one CHANGELOG.md section: `node scripts/changelog-section.js 0.1.0`.
// The release workflow uses it for the GitHub release notes; release.js uses the exports.
import fs from 'node:fs';
import path from 'node:path';

export const changelogPath = path.join(import.meta.dirname, '..', 'CHANGELOG.md');
const heading = /^## \[?(Unreleased|\d+\.\d+\.\d+)\]?(?:\s|$)/;

// Splits the changelog into { preamble, sections: [{ name, heading, body }] }.
export function parseChangelog(text) {
  const lines = text.split('\n');
  const sections = [];
  let preamble = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(heading);
    if (match) {
      current = { name: match[1], heading: line, body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  return {
    preamble: preamble.join('\n'),
    sections: sections.map((s) => ({ ...s, body: s.body.join('\n').trim() })),
  };
}

// Body of the section for `name` ('Unreleased' or a version), without HTML comments; null if absent.
export function changelogSection(text, name) {
  const section = parseChangelog(text).sections.find((s) => s.name === name);
  if (!section) return null;
  return section.body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

if (process.argv[1] === import.meta.filename) {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/changelog-section.js <version|Unreleased>');
    process.exit(2);
  }
  const body = changelogSection(fs.readFileSync(changelogPath, 'utf8'), name.replace(/^v/, ''));
  if (body === null) {
    console.error(`CHANGELOG.md has no section "## ${name}"`);
    process.exit(1);
  }
  console.log(body);
}
