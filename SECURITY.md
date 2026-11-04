# Security

## What Postcat does with your data

- Postcat has no backend and no telemetry. Captured traffic is processed locally, and saved
  requests and settings stay in your browser. Replays contact the servers you choose (including
  redirects); HTML Preview can load resources referenced by the response. The
  [privacy policy](docs/privacy.md) describes these data flows.
- Replays run in the extension's service worker with `<all_urls>` host permission and
  `credentials: 'omit'`. Your browser's cookie jar is never read or written; cookies are only
  sent if they are in the request's headers.
- Saved requests are kept in `chrome.storage.local` in plain text, including any `Cookie` or
  `Authorization` headers they contain. Remove what you do not need before saving, especially
  on shared machines.
- Response previews render remote content: HTML in a fully sandboxed `srcdoc` iframe (no scripts,
  opaque origin), media through `<img>`, `<video>`, `<audio>` and Chrome's PDF viewer, everything
  else as text or hex. The panel never uses `innerHTML`.
- When you switch an HTML response to
  Preview, the sandboxed frame gets a `<base href>` pointing at the response URL, so the page's
  images and stylesheets are loaded from the original server (scripts stay blocked).

## Reporting a vulnerability

Please report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/maphel/Postcat/security/advisories/new)
rather than a public issue. Include the steps to reproduce and the affected version. You will get
a response within a week.
