// Release in two steps, because `main` only takes pull requests (see CONTRIBUTING.md):
//
//   npm run release <x.y.z>   on a clean, up-to-date main: bumps package.json, package-lock.json
//                             and manifest.json, turns "## Unreleased" into "## <x.y.z> — <date>",
//                             commits "release: v<x.y.z>" on the branch release/v<x.y.z> and
//                             prints how to open the PR.
//   npm run release tag       on main after that PR was squash-merged: creates the annotated tag
//                             v<x.y.z> for the version in package.json and prints the push command.
//                             Pushing the tag triggers .github/workflows/release.yml.
//
// The tag is created after the merge because squash-merging rewrites the commit; tagging the
// release branch would point at a commit that never lands on main.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { changelogPath, changelogSection, parseChangelog } from './changelog-section.js';

const root = path.join(import.meta.dirname, '..');
const unreleasedNote = '<!-- Entries go under ### Added / ### Changed / ### Fixed / ### Removed; add only the subsections you need. -->';

function usage() {
  console.error('Usage: npm run release <x.y.z>   prepare the release branch');
  console.error('       npm run release tag       tag main after the release PR was merged');
  process.exit(2);
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return (execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim();
}

function git(...args) {
  return run('git', args);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Refuses unless we are on main, the tree is clean and HEAD equals origin/main.
function requireCleanMain() {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('switch to main first');
  if (git('status', '--porcelain')) fail('the working tree is not clean');
  git('fetch', '--quiet', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not up to date with origin/main (git pull, or push your commits)');
}

function currentVersion() {
  const pkg = readJson('package.json');
  const manifest = readJson('manifest.json');
  if (pkg.version !== manifest.version) fail(`package.json is ${pkg.version} but manifest.json is ${manifest.version}`);
  return pkg.version;
}

function prepare(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`"${version}" is not a version of the form x.y.z`);
  requireCleanMain();
  const current = currentVersion();
  if (compareVersions(version, current) <= 0) fail(`${version} is not greater than the current version ${current}`);
  if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`);
  const branch = `release/v${version}`;
  if (git('branch', '--list', branch)) fail(`branch ${branch} already exists`);

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const unreleased = changelogSection(changelog, 'Unreleased');
  if (unreleased === null) fail('CHANGELOG.md has no "## Unreleased" section');
  if (!unreleased) fail('"## Unreleased" in CHANGELOG.md is empty; nothing to release');

  git('switch', '--quiet', '--create', branch);

  // package.json + package-lock.json; no lifecycle scripts or git actions.
  run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: ['ignore', 'ignore', 'inherit'] });

  // manifest.json: JSON.stringify keeps the key order; 2 spaces and a trailing newline match the file.
  const manifest = readJson('manifest.json');
  manifest.version = version;
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const date = new Date().toISOString().slice(0, 10);
  const { preamble, sections } = parseChangelog(changelog);
  const parts = [preamble.trimEnd(), `## Unreleased\n\n${unreleasedNote}`];
  for (const section of sections) {
    if (section.name === 'Unreleased') parts.push(`## ${version} — ${date}\n\n${unreleased}`);
    else parts.push(`${section.heading}\n\n${section.body}`);
  }
  fs.writeFileSync(changelogPath, parts.join('\n\n') + '\n');

  git('add', 'package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md');
  git('commit', '--quiet', '-m', `release: v${version}`);

  console.log(`Prepared ${branch} (${current} -> ${version}). Next:`);
  console.log(`  git push -u origin ${branch}`);
  console.log(`  gh pr create --title "release: v${version}" --body "Release ${version}; see CHANGELOG.md."`);
  console.log('After the PR is squash-merged:');
  console.log('  git switch main && git pull');
  console.log('  npm run release tag');
}

function tag() {
  requireCleanMain();
  const version = currentVersion();
  const name = `v${version}`;
  if (git('tag', '--list', name)) fail(`tag ${name} already exists locally`);
  if (git('ls-remote', '--tags', 'origin', name)) fail(`tag ${name} already exists on origin`);
  const notes = changelogSection(fs.readFileSync(changelogPath, 'utf8'), version);
  if (!notes) fail(`CHANGELOG.md has no "## ${version}" section; run "npm run release ${version}" and merge its PR first`);
  git('tag', '--annotate', name, '--message', `Postcat ${version}`);
  console.log(`Created tag ${name} on ${git('rev-parse', '--short', 'HEAD')}. Next:`);
  console.log(`  git push origin ${name}`);
  console.log('The release workflow then runs the checks, packs the zip and publishes the GitHub release.');
}

const arg = process.argv[2];
if (!arg || process.argv.length > 3) usage();
else if (arg === 'tag') tag();
else prepare(arg);
