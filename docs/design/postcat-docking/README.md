# Postcat: compact, docking-aware UI mockups

Final design reference, 2026-09-23. These are the compact mockups with **direct Response Body / Headers tabs**, superseding the earlier spacious sidebar concepts.

## Open the prototypes

Download `postcat-mockups.zip`, extract it, and open either HTML file in Chromium:

- `postcat-docked.html`: 1024 × 320 reference canvas, bottom docking.
- `postcat-side-docked.html`: 380 × 480 reference canvas, side docking.

The HTML files are standalone preview wrappers, not extension code. They use sample requests and simulated replay. They do not send HTTP requests. Use the appearance selector to switch Light / Dark / System. Use Body / Headers in the response area; in the narrow layout, select Response first. Requests opens the narrow list, and choosing a row returns to details. The embedded design controls are optional host helpers and need not be available in an ordinary browser.

The editable fragments are in `source/`. The PNGs capture the current exported prototypes in both themes, including response headers and the narrow request list. Screenshots are at 2× pixel density; the logical canvas sizes are as above.

## Layout contract

Measure the actual available panel width, not the physical screen width or dock position. The reference breakpoints are starting values to validate in real DevTools:

| Available width | Layout |
| --- | --- |
| 850 px and wider | Request list (~214 px), request editor and response side by side. |
| 580–849 px | Request list (~205 px), single details area with Request / Response switches. |
| Below 580 px | List or details uses the full width. Requests opens the list; choosing a request returns to details. Request / Response switches share the detail space. |

The list has exactly two compact toolbar rows: collection/record/new, then filter/capture options. Requests are compact single-line rows. No separate brand header, permanent footer, or repeated help text consumes panel height. List/editor/response contents scroll independently, with their controls remaining reachable.

Body / Headers are direct response tabs in the existing response header. They must not move into the global More menu. Recorded / Sent is an independent response-source selector. Preserve Preview / Raw within the Body view without conflating it with source or Headers.

## Reference details and implementation boundaries

- System UI font; compact 11–12 px DevTools text; 26–31 px fine-pointer control/list rows. Keep the text readable rather than scaling the entire interface down.
- Restrained blue for selection/focus/Send; semantic request-method and status colors; neutral surfaces and subtle separators.
- Theme every surface, open dropdown, menu, field, selected, hover, focus and disabled state. Icons and labels align on one row and retain their meaning after saving or switching views.
- Theme tokens and dimensions are in the fragments. Do not import the prototype's host runtime, `window.openai`, Tweak, or third-party icon runtime into the extension.
- The fake Chromium Elements / Console / Network / Postcat tab strip is context only. Do not recreate it inside the actual extension panel. The screenshot canvas includes this strip; the production panel uses its actual host-provided dimensions.
- Fixed canvas sizes are for demonstrating constraints, not hardcoded production heights. The production layout fills the available panel.
- The prototype is not a complete feature implementation: menu contents, mock response values, in-memory saved state and capture-option feedback are illustrative. Retain existing Postcat behavior and data handling; omitted controls are not a request to remove their capabilities.
- The final issue contains acceptance criteria and the required regression checks. Do not treat a passing prototype check as validation of the extension implementation.

## Suggested validation sizes

1024 × 320, 1024 × 240, 850 × 300, 680 × 280, 580 × 240, 380 × 480, 320 × 260 CSS pixels. Check both themes, expanded dropdowns, long URLs/header values, empty states, and enough rows/content to scroll. Preserve selection, unsent edits, response/source and focus appropriately across layout changes.
