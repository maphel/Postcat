# Contributing

Thanks for taking a look. Postcat is small on purpose; changes that keep it small are the easiest
to land. This file is the single source of truth for how changes flow into a release, for humans
and agents alike. `AGENTS.md` maps the code and lists the rules that keep the replay path safe.

## Setup

```bash
git clone https://github.com/maphel/Postcat.git
cd Postcat
npm install
npx playwright install chromium   # for the browser suites
npm run check                     # lint, unit, e2e, real DevTools
```

Load the repository folder as an unpacked extension (`chrome://extensions` → Developer mode →
Load unpacked) to try changes in a real browser. Reload the extension after edits, then close
and reopen DevTools.

## Branching

`main` is always releasable and protected: changes land only through pull requests, the CI
`check` workflow must pass, and PRs are squash-merged (the PR title becomes the commit summary,
so it follows the commit convention below). Branch from `main` as `<type>/<topic>`, e.g.
`fix/curl-quoted-body` or `docs/shortcut-table`, with one of the types `feat`, `fix`, `docs`,
`test`, `chore`, `refactor`. Open an issue first for anything beyond a bug fix or a docs change,
so we can agree on the scope.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope)?: summary`, same
types as the branches. The summary is imperative and short; the body explains why, not what.

```
fix(curl): keep single quotes inside --data bodies

Shell-quoted JSON lost its inner quotes on import, which produced invalid bodies.
```

## Definition of done for a PR

- Bugs: a regression test first (it fails), then the fix (it passes). `test/regressions.test.js`
  pins fixed bugs.
- Features: a test on the right level. Unit tests for `src/lib`, `test/e2e.js` for panel
  behaviour, `test/real-devtools.js` for anything that depends on `chrome.devtools`.
- `npm run check` is green locally; CI runs the same command.
- Docs follow the change: `README.md` for user-visible behaviour, `AGENTS.md` for structural
  changes (new files, module graph, rules).
- A line under `## Unreleased` in `CHANGELOG.md` for anything a user would notice (Added /
  Changed / Fixed / Removed). Refactors, tests and docs-only changes need none.
- No self-merge: every PR gets a review from someone or something other than its author before
  it is merged.

The pull request template repeats this list as a checklist.

## Versioning

SemVer, currently in the 0.x phase: a **minor** version for new user-visible features, a
**patch** version for fixes and docs-only releases. 1.0 comes when the saved-collection storage
format (`chrome.storage.local`, see `src/panel/storage.js`) is declared stable. `manifest.json`,
`package.json` and `package-lock.json` always carry the same version; `scripts/pack.js` refuses
to build otherwise.

## Releasing

**When.** Whenever `## Unreleased` has user-visible entries and CI on `main` is green. There is
no fixed cadence, but a reported bug should not sit fixed-but-unreleased for long.

**What.** The GitHub release for tag `v<version>` with `postcat-<version>.zip`, built from
`manifest.json`, `src/` and `icons/` only (`npm run pack`), and the matching `CHANGELOG.md`
section as release notes.

**How.** Two steps, because `main` takes pull requests only:

1. On a clean, up-to-date `main`: `npm run release <version>`. The script validates the version
   (greater than the current one) and that `## Unreleased` is not empty, bumps
   `package.json`, `package-lock.json` and `manifest.json`, renames `## Unreleased` to
   `## <version> — <date>` and inserts a fresh `## Unreleased` above it, commits
   `release: v<version>` on the branch `release/v<version>` and prints the commands to push it
   and open the PR. Before opening the PR, load the unpacked extension and replay one GET and
   one POST on a real site (`AGENTS.md` § Verification). The release PR is reviewed and
   squash-merged like any other.
2. On `main` after the merge (`git switch main && git pull`): `npm run release tag` creates the
   annotated tag `v<version>` for the version now in `package.json` and prints
   `git push origin v<version>`. Pushing the tag starts `.github/workflows/release.yml`, which
   checks that the tag matches the version, runs lint, unit and e2e tests, packs the zip and
   publishes the GitHub release with the changelog section (`npm run changelog:section
   <version>`) as notes.

Cutting a release is a maintainer decision; see `AGENTS.md` § Workflow for what agents must
ask about first.

## Reporting bugs

Use the bug report template. The browser name and version, what you did, what you expected
and what happened instead are what make a report actionable. Never include cookies, tokens or
other secrets from your requests.
