# Postcat privacy policy

Last updated: 9 November 2026

Postcat is an API client inside Chrome DevTools for capturing, editing and replaying network
requests. This policy describes the extension, not the websites or API servers you inspect.

## Data Postcat accesses

Postcat asks before it starts recording or imports the DevTools log for the first time. The
prompt explains what the extension reads and how it is used. If you choose **Allow capture**,
Postcat remembers your choice in this browser profile and can start recording when you reopen
the panel. Use the recording button to pause live capture.

While recording or importing, Postcat reads network requests and responses for the inspected tab
through the DevTools API. This can include URLs, query parameters, methods, headers, request
and response bodies, status codes and timing information. Depending on the site, these may contain
personal information, cookies, authentication tokens or other confidential content. cURL commands
you paste may contain the same kinds of request data.

Postcat does not use the browser history API or inspect unrelated tabs. It does not access the
browser's cookie store. A captured request may nevertheless include a Cookie or Authorization
header supplied by DevTools.

## Local processing and storage

Captured requests and responses stay in memory while the panel is open. Saving a captured request
copies its name, method, URL, headers and body to your collection. The collection must be set up
or unlocked before you can save, create a new request, or paste a cURL command outside an input.
Pasting cURL into the URL field updates the selected request without changing whether it is captured
or saved. Edits to saved requests are saved automatically. Before closing DevTools, wait for the
saving indicator to clear or lock the collection and wait for it to finish. Response bodies stay
outside the collection.

Postcat encrypts the saved collection with AES-256-GCM before writing it to `chrome.storage.local`.
It derives the key from your passphrase using PBKDF2-SHA-256 with 600,000 iterations and a random
salt. Each write uses a new random IV. The encrypted data, salt and IV are stored locally. Postcat
does not store the passphrase or key. Saved requests are readable in the panel while unlocked.
Locking the collection drops the key from the panel, and you need the passphrase to unlock it
again. The passphrase cannot be recovered.

Collections from earlier versions may still be stored as plain text. When you set up a passphrase
for an existing collection, Postcat encrypts it and replaces the old value only after saving succeeds.
You can delete requests in the Saved tab. Uninstalling the extension removes its extension storage.

Postcat stores settings such as capture consent, appearance and layout separately in this browser
profile. Filter text stays in the open panel. Postcat ignores legacy stored filters and removes
them the next time settings are saved. Postcat does not sync the collection or settings to the cloud.

Copying a request or response places it on your clipboard. Saving a response as a file writes it
to the location managed by your browser. These copies remain under your control and are not
removed when you delete a request in Postcat.

## Network requests and third parties

Postcat has no developer-operated backend, analytics, telemetry, advertising or crash reporting.
The developer does not receive your captured traffic or saved collection through the extension,
and does not sell or use it for advertising.

Postcat's use of user data complies with the Chrome Web Store User Data Policy, including its
[Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Data is used only to provide the request debugging features described in this policy. It is not
sold or used for unrelated purposes, personalized advertising, or creditworthiness or lending decisions.

When you choose Send, Postcat sends the request from the extension's service worker to the HTTP
or HTTPS address in the editor. The server receives the request data you send and ordinary network
information such as your IP address. Redirects are followed. These servers process the request
under their own policies; review the URL, headers and body before sending.

Replays use `credentials: 'omit'`: the browser's cookie jar is not read or updated by a replay.
Cookies or authorization values explicitly present in the editor can still be transmitted as
part of your request. Temporary header-modification rules are scoped to requests from the
extension at the selected target origin and removed after the send.

HTML responses are shown as source by default. If you choose HTML Preview, the sandboxed frame
blocks scripts but may load images, stylesheets and other resources referenced by that HTML.
Chrome can contact hosts to load the resources referenced by the page while HTML Preview is active.
Relative resource URLs resolve against the response URL for a replay or the current request URL
for a recorded response. Hosts may receive network information and process it under their own
policies. Other response previews use the response data already held by Postcat.

## Permissions

- **HTTP and HTTPS host access (`http://*/*`, `https://*/*`):** allows you to replay requests to
  the hosts you choose, including local development servers, and read their responses. Postcat
  captures page traffic through the DevTools API for the inspected tab.
- **`declarativeNetRequestWithHostAccess`:** applies headers that the Fetch API cannot set
  directly, such as Cookie, Origin and User-Agent, during a replay. Rules are temporary and
  limited to requests initiated by the extension at the target origin.
- **`storage`:** saves the encrypted collection and panel preferences locally.

Postcat's executable JavaScript is bundled with the extension. It does not download or execute
remote application code. HTML Preview does not allow response scripts to execute.

## Contact and changes

For privacy questions, contact [marcel@christophel.io](mailto:marcel@christophel.io).
For confidential vulnerability reports, use
[GitHub private vulnerability reporting](https://github.com/maphel/Postcat/security/advisories/new).
Updates to this policy will be published in this file with a revised date.
