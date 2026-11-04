// Release guards run only in disposable local repositories, never against this checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changelogSection, parseChangelog } from '../scripts/changelog-section.js';

const root = path.join(import.meta.dirname, '..');
const releasedNotes = '### Fixed\n\n- Example fix.';
const changelog = (notes = '<!-- Placeholder -->') => `# Changelog\n\n## Unreleased\n\n${notes}\n\n## 0.2.0 — 2026-01-01\n\n${releasedNotes}\n`;

function releaseFixture(subject = 'release: v0.2.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postcat-release-test-'));
  const repo = path.join(dir, 'repo');
  const remote = path.join(dir, 'origin.git');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  for (const name of ['release.js', 'changelog-section.js']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(repo, 'scripts', name));
  }
  const pkg = { name: 'postcat-release-fixture', private: true, type: 'module', version: '0.2.0' };
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true,
    packages: { '': { name: pkg.name, version: pkg.version } },
  }));
  fs.writeFileSync(path.join(repo, 'manifest.json'), JSON.stringify({ version: '0.2.0' }));
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), changelog());
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Postcat Test');
    git('config', 'user.email', 'postcat-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', '.');
    git('commit', '--quiet', '-m', subject);
    git('init', '--quiet', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', '--quiet', '--set-upstream', 'origin', 'main');
    return {
      git,
      write: (file, text) => fs.writeFileSync(path.join(repo, file), text),
      read: (file) => fs.readFileSync(path.join(repo, file), 'utf8'),
      commit: (subject = 'release: v0.2.0') => {
        git('add', '.');
        git('commit', '--quiet', '-m', subject);
        git('push', '--quiet', 'origin', 'main');
      },
      run: (...args) => spawnSync(process.execPath, ['scripts/release.js', ...args], { cwd: repo, encoding: 'utf8' }),
      notes: (...args) => spawnSync(process.execPath, ['scripts/changelog-section.js', ...args], { cwd: repo, encoding: 'utf8' }),
      tags: () => git('tag', '--list'),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

test('release tag requires the exact release title, allowing a GitHub squash PR suffix', async (t) => {
  for (const [subject, accepted] of [
    ['release: v0.2.01', false],
    ['release: v0.2.0-unrelated', false],
    ['release: v0.2.0 arbitrary', false],
    ['release: v0.2.0', true],
    ['release: v0.2.0 (#27)', true],
  ]) {
    await t.test(subject, () => {
      const fixture = releaseFixture(subject);
      try {
        const result = fixture.run('tag');
        assert.equal(result.status, accepted ? 0 : 1, result.stderr || result.stdout);
        assert.equal(fixture.tags(), accepted ? 'v0.2.0' : '');
        if (!accepted) assert.match(result.stderr, /not the release commit/);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('release prepare validates CLI arguments and refuses invalid or non-increasing versions', () => {
  const fixture = releaseFixture();
  try {
    for (const args of [[], ['0.2.1', 'extra']]) assert.equal(fixture.run(...args).status, 2);
    for (const version of ['bad', '0.2', '01.2.3', '0.2.1-beta']) {
      const result = fixture.run(version);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not a version/);
    }
    for (const version of ['0.2.0', '0.1.9']) {
      const result = fixture.run(version);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not greater/);
    }
    assert.equal(fixture.git('branch', '--show-current'), 'main');
    assert.equal(fixture.tags(), '');
  } finally {
    fixture.cleanup();
  }
});

test('release prepare requires clean synchronized main and matching manifest version', async (t) => {
  for (const [name, alter, message] of [
    ['dirty tree', (f) => f.write('untracked.txt', 'draft'), /not clean/],
    ['wrong branch', (f) => f.git('switch', '--quiet', '-c', 'test-branch'), /switch to main first/],
    ['unsynchronized main', (f) => f.git('commit', '--quiet', '--allow-empty', '-m', 'test: local commit'), /not up to date/],
    ['mismatched manifest', (f) => { f.write('manifest.json', '{"version":"0.1.0"}'); f.commit(); }, /manifest.json is 0.1.0/],
  ]) {
    await t.test(name, () => {
      const fixture = releaseFixture();
      try {
        alter(fixture);
        const result = fixture.run('0.2.1');
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.equal(fixture.tags(), '');
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('release prepare refuses malformed or empty Unreleased sections', async (t) => {
  for (const [name, content, message] of [
    ['missing', '# Changelog\n\n## 0.2.0\n\nNotes', /exactly one.*found 0/],
    ['duplicate', changelog() + '\n## Unreleased\n\nMore notes', /exactly one.*found 2/],
    ['empty', changelog(), /empty; nothing to release/],
  ]) {
    await t.test(name, () => {
      const fixture = releaseFixture();
      try {
        fixture.write('CHANGELOG.md', content);
        if (name !== 'empty') fixture.commit();
        const result = fixture.run('0.2.1');
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.equal(fixture.git('branch', '--show-current'), 'main');
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('release prepare updates version files and preserves prior changelog notes', () => {
  const fixture = releaseFixture();
  try {
    const notes = '### Fixed\n\n- New regression fix.';
    fixture.write('CHANGELOG.md', changelog(notes));
    fixture.commit();
    const result = fixture.run('0.2.1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.git('branch', '--show-current'), 'release/v0.2.1');
    assert.equal(fixture.git('log', '-1', '--format=%s'), 'release: v0.2.1');
    assert.equal(fixture.git('status', '--porcelain'), '');
    for (const file of ['package.json', 'package-lock.json', 'manifest.json']) assert.equal(JSON.parse(fixture.read(file)).version, '0.2.1', file);
    assert.equal(JSON.parse(fixture.read('package-lock.json')).packages[''].version, '0.2.1');
    const text = fixture.read('CHANGELOG.md');
    assert.equal(changelogSection(text, 'Unreleased'), '');
    assert.equal(changelogSection(text, '0.2.1'), notes);
    assert.equal(changelogSection(text, '0.2.0'), releasedNotes);
    assert.match(text, /## 0\.2\.1 — \d{4}-\d{2}-\d{2}/);
    assert.equal(fixture.tags(), '');
  } finally {
    fixture.cleanup();
  }
});

test('release tag refuses existing tags and incomplete release notes', async (t) => {
  for (const [name, alter, message] of [
    ['local tag', (f) => f.git('tag', 'v0.2.0'), /already exists locally/],
    ['remote tag', (f) => {
      f.git('switch', '--quiet', '--orphan', 'remote-tag');
      f.git('commit', '--quiet', '--allow-empty', '-m', 'test: unrelated remote tag');
      f.git('tag', 'v0.2.0');
      f.git('push', '--quiet', 'origin', 'v0.2.0');
      f.git('switch', '--quiet', 'main');
      f.git('tag', '--delete', 'v0.2.0');
    }, /already exists on origin/],
    ['missing release notes', (f) => { f.write('CHANGELOG.md', '# Changelog\n\n## Unreleased\n'); f.commit(); }, /no.*0.2.0.*section/],
    ['nonempty Unreleased', (f) => { f.write('CHANGELOG.md', changelog('### Fixed\n\n- Unreleased change.')); f.commit(); }, /already has entries/],
  ]) {
    await t.test(name, () => {
      const fixture = releaseFixture();
      try {
        alter(fixture);
        const before = fixture.tags();
        const result = fixture.run('tag');
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.equal(fixture.tags(), before);
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test('changelog parsing and CLI extract notes and reject missing or empty sections', () => {
  const source = '# Changes\n\n## [Unreleased]\n\n<!-- note -->\n\n## [0.2.0] — date\n\n### Fixed\n\n- Kept.\n<!-- hidden -->\n';
  const parsed = parseChangelog(source);
  assert.equal(parsed.preamble, '# Changes\n');
  assert.deepEqual(parsed.sections.map((s) => s.name), ['Unreleased', '0.2.0']);
  assert.equal(changelogSection(source, 'Unreleased'), '');
  assert.equal(changelogSection(source, '0.2.0'), '### Fixed\n\n- Kept.');
  assert.equal(changelogSection(source, '9.9.9'), null);
  assert.throws(() => parseChangelog('# Changes'), /found 0/);
  assert.throws(() => parseChangelog('## Unreleased\n## Unreleased'), /found 2/);
  const fixture = releaseFixture();
  try {
    assert.equal(fixture.notes().status, 2);
    assert.equal(fixture.notes('9.9.9').status, 1);
    assert.match(fixture.notes('9.9.9').stderr, /has no section/);
    assert.equal(fixture.notes('Unreleased').status, 1);
    assert.match(fixture.notes('Unreleased').stderr, /is empty/);
    const notes = fixture.notes('v0.2.0');
    assert.equal(notes.status, 0, notes.stderr);
    assert.equal(notes.stdout.trim(), releasedNotes);
    fixture.write('CHANGELOG.md', '# Changes');
    assert.equal(fixture.notes('0.2.0').status, 1);
    assert.match(fixture.notes('0.2.0').stderr, /exactly one/);
  } finally {
    fixture.cleanup();
  }
});
