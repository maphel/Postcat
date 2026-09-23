// Release in two steps, because `main` only takes pull requests (see CONTRIBUTING.md):
//
//   npm run release <x.y.z>   on a clean, up-to-date main: bumps package.json, package-lock.json
//                             and manifest.json, turns "## Unreleased" into "## <x.y.z> — <date>",
//                             commits "release: v<x.y.z>" on the branch release/v<x.y.z> and
//                             prints how to open the PR.
//   npm run release tag       on main right after that PR was squash-merged: creates the annotated
//                             tag v<x.y.z> for the version in package.json and prints the push
//                             command. Pushing the tag triggers .github/workflows/release.yml.
//
// The tag is created after the merge because squash-merging rewrites the commit; tagging the
// release branch would point at a commit that never lands on main. `tag` refuses unless HEAD is
// the squashed release commit itself ("release: v<x.y.z>" with an empty "## Unreleased"), so a
// tag never points at a later commit that would ship unreleased changes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { changelogPath, parseChangelog } from './changelog-section.js';

const root = path.join(import.meta.dirname, '..');
const unreleasedNote = '<!-- Entries go under ### Added / ### Changed / ### Fixed / ### Removed; add only the subsections you need. -->';
// SemVer core: three numbers, no leading zeros, no pre-release or build suffix.
const versionPattern = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){2}$/;

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

// Today's date in the local time zone, as YYYY-MM-DD (toISOString would use UTC).
function localDate() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
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

// CHANGELOG.md parsed once: { text, preamble, sections }. Fails unless there is exactly one
// "## Unreleased" heading.
function readChangelog() {
  const text = fs.readFileSync(changelogPath, 'utf8');
  try {
    return { text, ...parseChangelog(text) };
  } catch (error) {
    return fail(error.message);
  }
}

// Body of one section without HTML comments (the placeholder note counts as empty); null if absent.
function sectionBody(sections, name) {
  const section = sections.find((s) => s.name === name);
  if (!section) return null;
  return section.body.replace(/<!--[\s\S]*?-->/g, '').trim();
}

function prepare(version) {
  if (!versionPattern.test(version)) fail(`"${version}" is not a version of the form x.y.z (numbers without leading zeros)`);
  requireCleanMain();
  const current = currentVersion();
  if (compareVersions(version, current) <= 0) fail(`${version} is not greater than the current version ${current}`);
  if (git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`);
  const branch = `release/v${version}`;
  if (git('branch', '--list', branch)) fail(`branch ${branch} already exists`);

  const { preamble, sections } = readChangelog();
  const unreleased = sectionBody(sections, 'Unreleased');
  if (!unreleased) fail('"## Unreleased" in CHANGELOG.md is empty; nothing to release');

  // Everything from here on changes the repository; on failure, say how to get back to main.
  let branched = false;
  try {
    git('switch', '--quiet', '--create', branch);
    branched = true;

    // package.json + package-lock.json; no lifecycle scripts or git actions.
    run('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], { stdio: ['ignore', 'ignore', 'inherit'] });

    // manifest.json: JSON.stringify keeps the key order; 2 spaces and a trailing newline match the file.
    const manifest = readJson('manifest.json');
    manifest.version = version;
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const parts = [preamble.trimEnd(), `## Unreleased\n\n${unreleasedNote}`];
    for (const section of sections) {
      if (section.name === 'Unreleased') parts.push(`## ${version} — ${localDate()}\n\n${unreleased}`);
      else parts.push(`${section.heading}\n\n${section.body}`);
    }
    fs.writeFileSync(changelogPath, parts.join('\n\n') + '\n');

    git('add', 'package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md');
    git('commit', '--quiet', '-m', `release: v${version}`);
  } catch (error) {
    console.error(`release: preparing ${branch} failed: ${error.message}`);
    console.error('To get back to a clean main:');
    console.error('  git checkout -- .');
    if (branched) console.error(`  git switch main && git branch -D ${branch}`);
    process.exit(1);
  }

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

  // HEAD must be the squashed release commit itself, not something that landed after it.
  const subject = git('log', '-1', '--format=%s');
  if (!subject.startsWith(`release: ${name}`)) {
    fail(`HEAD is "${subject}", not the release commit "release: ${name}". Tag right after merging the release PR, before other PRs land; if main has moved on, prepare a new release instead (npm run release <x.y.z>)`);
  }
  const { sections } = readChangelog();
  const notes = sectionBody(sections, version);
  if (!notes) fail(`CHANGELOG.md has no "## ${version}" section; run "npm run release ${version}" and merge its PR first`);
  if (sectionBody(sections, 'Unreleased')) {
    fail(`"## Unreleased" in CHANGELOG.md already has entries, so main is past the release commit and the tag would ship unreleased changes. Tag right after merging the release PR, before other PRs land; otherwise prepare a new release (npm run release <x.y.z>)`);
  }

  git('tag', '--annotate', name, '--message', `Postcat ${version}`);
  console.log(`Created tag ${name} on ${git('rev-parse', '--short', 'HEAD')}. Next:`);
  console.log(`  git push origin ${name}`);
  console.log('The release workflow then runs the checks, packs the zip and publishes the GitHub release.');
}

const arg = process.argv[2];
if (!arg || process.argv.length > 3) usage();
else if (arg === 'tag') tag();
else prepare(arg);
