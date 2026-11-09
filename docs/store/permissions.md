# Chrome Web Store permission explanations

These explanations match `manifest.json`. Each section can be copied into the corresponding
Privacy practices field in the Developer Dashboard.

## storage

Postcat stores the user's encrypted request collection and panel preferences in chrome.storage.local.
Saved requests contain the name, method, URL, headers and body. Postcat encrypts them with a key
derived from the user's passphrase and keeps the key in the unlocked panel. Preferences include
capture consent, appearance, tabs and layout. Filter text stays in memory. Storage stays in the
user's browser profile.

## declarativeNetRequestWithHostAccess

Replaying an edited request can require headers the Fetch API cannot set directly, including
Cookie, Origin, Referer and User-Agent. Postcat uses a temporary modifyHeaders session rule for
each replay. The rule is limited to requests initiated by this extension, with tabIds: [-1],
the extension ID as initiatorDomains, the exact target origin and the xmlhttprequest resource
type. Sends are serialized and the rule is removed in finally. It does not modify page traffic.

## Host permissions: `http://*/*` and `https://*/*`

Postcat is a general-purpose HTTP debugging client. The user chooses arbitrary HTTP or HTTPS
URLs to replay, including localhost, private development servers and APIs on different hosts.
HTTP and HTTPS host access lets the extension's service worker send those requests and read their
responses without the inspected page's CORS restrictions. A fixed domain list would prevent this
core function. Replays start with the user's Send action and follow redirects. Recording and log
import use the inspected tab's DevTools API after consent. HTML Preview can load resources referenced
by the response as disclosed in the privacy policy.

## Remote code

No remote executable code is used. All application JavaScript is included in the extension
package; there are no runtime libraries downloaded from a CDN and no remote script evaluation.
HTML responses are data, displayed as source by default. The optional HTML Preview is a fully
sandboxed iframe without allow-scripts or allow-same-origin. It can load referenced resources
such as images and stylesheets, but response scripts do not execute.
