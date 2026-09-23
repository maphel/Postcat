# Contributing

Thanks for taking a look. Postcat is small on purpose; changes that keep it small are the easiest to land.

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

## Making changes

- Read `AGENTS.md` first: it maps the code and lists the rules that keep the replay path safe.
- Keep `src/lib` free of DOM and `chrome` APIs so it stays unit-testable.
- Add a test with every fix: unit tests for `src/lib`, `test/e2e.js` for panel behaviour,
  `test/real-devtools.js` for anything that depends on how DevTools actually behaves.
- `npm run check` must pass; CI runs the same command.
- Commit messages: a short imperative summary line, optionally a body explaining why.

## Pull requests

Open an issue first for anything beyond a bug fix, so we can agree on the scope. In the PR,
say what changed and how you verified it. Small, focused PRs are reviewed faster.

## Reporting bugs

Use the bug report template. The browser name and version, what you did, what you expected
and what happened instead are what make a report actionable. Never include cookies, tokens or
other secrets from your requests.
