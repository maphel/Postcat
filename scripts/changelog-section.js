// Prints the body of one CHANGELOG.md section: `node scripts/changelog-section.js 0.1.0`.
// The release workflow uses it for the GitHub release notes; release.js uses the exports.
// Exits 1 when the section is missing or empty, so the workflow never publishes empty notes.
import fs from 'node:fs';
import path from 'node:path';

export const changelogPath = path.join(import.meta.dirname, '..', 'CHANGELOG.md');
const heading = /^## \[?(Unreleased|\d+\.\d+\.\d+)\]?(?:\s|$)/;

// Splits the changelog into { preamble, sections: [{ name, heading, body }] }.
// Throws unless there is exactly one "## Unreleased" heading: the release script renames it and
// inserts a fresh one, so a missing or duplicated heading would corrupt the file.
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
  const unreleased = sections.filter((s) => s.name === 'Unreleased').length;
  if (unreleased !== 1) throw new Error(`CHANGELOG.md must have exactly one "## Unreleased" heading, found ${unreleased}`);
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
  const section = name.replace(/^v/, '');
  let body;
  try {
    body = changelogSection(fs.readFileSync(changelogPath, 'utf8'), section);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (body === null) {
    console.error(`CHANGELOG.md has no section "## ${section}"`);
    process.exit(1);
  }
  if (!body) {
    console.error(`CHANGELOG.md section "## ${section}" is empty (nothing to publish as release notes)`);
    process.exit(1);
  }
  console.log(body);
}
