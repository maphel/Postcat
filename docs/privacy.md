# Postcat privacy policy

Last updated: 4 November 2026

Postcat is an API client inside Chrome DevTools for capturing, editing and replaying network
requests. This policy describes the extension, not the websites or API servers you inspect.

## Data Postcat accesses

While DevTools is open and recording is enabled, Postcat reads network requests and responses
for the inspected tab through the DevTools API. This can include URLs, query parameters, methods,
headers, request bodies, response bodies, status codes and timing information. Depending on the
site, those fields may contain personal information, cookies, authentication tokens or other
confidential content. Imported DevTools logs and cURL commands are processed in the same way.

Postcat does not use the browser history API or inspect unrelated tabs. It does not access the
browser's cookie store. A captured request may nevertheless include a Cookie or Authorization
header supplied by DevTools.

## Local processing and storage

Captured requests and responses are held in memory while the panel is open. They are not
automatically written to the saved collection. New requests and imported cURL commands are
created in the saved collection. If you save a captured request, its name, method, URL,
headers and body are stored in `chrome.storage.local`, alongside panel settings such as appearance,
filter text and layout. Response bodies are not persisted in the saved collection.

This storage is local to your browser profile; Postcat does not use `chrome.storage.sync` or
provide cloud synchronization. Saved requests are stored as plain text, including any credentials
in their URLs, headers or bodies. Remove information you do not need before saving or sharing a
request. Saved requests remain until you delete them or remove the extension. You can delete
requests in the Saved tab. Uninstalling the extension removes its extension storage.

Copying a request or response places it on your clipboard. Saving a response as a file writes it
to the location managed by your browser. These copies remain under your control and are not
removed when you delete a request in Postcat.

## Network requests and third parties

Postcat has no developer-operated backend, analytics, telemetry, advertising or crash reporting.
The developer does not receive your captured traffic or saved collection through the extension,
and does not sell or use it for advertising.

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
Those resource requests can contact the original server or other hosts named in the response,
which may receive network information and process it under their own policies. Other response
previews use the response data already held by Postcat.

## Permissions

- **Access to all sites (`<all_urls>`):** allows you to replay requests to the HTTP or HTTPS
  hosts you choose, including local development servers, and read their responses. It is not
  used to monitor unrelated tabs.
- **`declarativeNetRequestWithHostAccess`:** applies headers that the Fetch API cannot set
  directly, such as Cookie, Origin and User-Agent, during a replay. Rules are temporary and
  limited to requests initiated by the extension at the target origin.
- **`storage`:** saves your collection and panel preferences locally.

Postcat's executable JavaScript is bundled with the extension. It does not download or execute
remote application code. HTML Preview does not allow response scripts to execute.

## Contact and changes

For privacy questions, contact [marcel@christophel.io](mailto:marcel@christophel.io).
For confidential vulnerability reports, use
[GitHub private vulnerability reporting](https://github.com/maphel/Postcat/security/advisories/new).
Updates to this policy will be published in this file with a revised date.
