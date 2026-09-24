# Postcat: the Saved area — origin groups, names and variables

Design reference for issues #12 and #11, 2026-09-23. These mockups extend the compact, docking-aware
UI of `docs/design/postcat-docking/` (#7) with the Saved area: automatic origin groups, inline
names for groups and requests, and per-group variable sets. They are mockups, not production code.

## Open the prototypes

Download `postcat-saved-mockups.zip`, extract it, and open either HTML file in Chromium:

- `postcat-saved-wide.html`: 1024 × 320 reference canvas, bottom docking (214 px sidebar + detail).
- `postcat-saved-side.html`: 380 × 480 reference canvas, side docking (list or detail, full width).

Both files are standalone and dependency-free. The bar above the canvas is a frame, not part of the
design: it holds the **Screen** selector (one entry per screen of the design review's handoff list)
and the **Light / Dark / System** appearance switch. Inside the canvas everything is clickable with
simulated behaviour: rows select, the chevron collapses a group, a group header opens the group
detail, a set tab activates the set, the eye masks or reveals a value, the `+` adds a set,
"Duplicate set" copies the active one, right-click opens the row menu, double-click or F2 renames
(Enter commits, Esc reverts), Send simulates a send. No HTTP request is made; nothing is stored;
no host runtime, `window.openai`, Tweak or icon library is used, and there is no fake DevTools tab
strip. A URL query selects a state directly, e.g. `postcat-saved-side.html?scene=group&appearance=dark`.

The PNGs are 2× exports of the canvas (logical sizes as above):

| File | Screen (handoff list) |
| --- | --- |
| `wide-light-list.png` | 1 · Saved list at 214 px, three groups: renamed + set chip (Shop API), plain origin with chip (api.github.com), no variables (localhost:8767); Headers tab with literal placeholders and the status line |
| `side-light-list.png` | 1 · the same list at 320 px full width |
| `wide-dark-group.png`, `side-dark-group.png` | 2 · group detail: set tabs (selected = active), kv table with a masked secret and eye toggle, "Duplicate set" |
| `wide-light-group-empty.png` | 3 · group without variables: "Add baseUrl = <origin>" starter |
| `wide-light-variables.png`, `side-light-variables.png` | 4 · request with the Variables tab: resolved rows, an unresolved row, set select, status line "3 variables · 1 unresolved: {{token}}" |
| `wide-dark-rename.png`, `wide-dark-rename-request.png` | 5 · inline rename in progress: group row, request row |
| `wide-light-context-menu.png` | 6 · row context menu: Rename, Duplicate, Copy as cURL, Delete |
| `wide-light-save-toast.png` | 7 · toast after saving into a new origin: "Saved to localhost:3000 · Rename" (the group was created automatically) |
| `side-dark-send-unresolved.png` | 8 · send with an unresolved variable: status line before, toast after, Response 401 in the switcher |
| `side-light-empty.png` | 9 · Saved list empty |

Screen 10 of the handoff (content-width Recorded/Sent select, "Preview ✓ / Raw" menu items) is
already implemented on `feat/compact-docking-layout`; the response header here reuses it unchanged.

## Group mechanics (maintainer decision, fixed)

- Groups are created automatically per **origin** (`scheme://host[:port]`), which stays the key.
  The label shows the host, plus the port only when it is non-default: `localhost:3000`,
  `shop.example.com`. Saving a request from an origin without a group creates the group; there is
  no manual "new group", no moving requests between groups, no folders.
- A group can carry a **display name**. Renaming changes only the label; its requests stay in it,
  and the origin remains visible as the subtitle in the list row, in the group detail heading and
  in the row tooltip.
- The inspected page's origin is pinned on top and expanded; the other groups follow
  alphabetically by label, collapsed by default (#11). Expanded state is remembered.
- The row's tooltip carries the origin, the request count and "inspected page" where it applies.

## Layout contract

**The list navigates and labels; the detail edits.** A group header is a third selectable thing
next to captured and saved requests, with its own detail in the main area.

### Saved list (214 px sidebar, 320 px full width)

| Row | Grid | Height | Columns |
| --- | --- | --- | --- |
| Group header | `40px minmax(0,1fr) auto` | 28 px (31 px narrow) | chevron in the method column · name + count · active-set chip in the status column |
| Renamed group header | same | 32 px (36 px narrow) | second line: origin host at 10 px, muted, ellipsized |
| Request in a group | same, indented 8 px | 28 px (31 px narrow) | method · ● + name or path · status (`—` when never sent) |

- The **chip** (mono 10 px, 1 px border, ≤ 64 px, ellipsized) shows the active set only when the
  group has two or more sets; a single set has nothing to switch and gets no chip.
- The chevron toggles the group; clicking anywhere else on the header selects it and opens the
  group detail. Keyboard: ↑/↓ across visible rows, Left/Right collapse/expand, Enter opens, F2 renames.
- Long names, paths and hosts ellipsize; the status column never shrinks.
- Nothing else is added to the list: no per-row buttons, no help rows.

### Group detail

Replaces the editor in the main area (wide) or the detail screen (narrow).

| Row | Height | Content |
| --- | --- | --- |
| Heading (wide only) | 39 px, the URL bar's slot | name or host at 12 px/500 · `origin · N requests` muted |
| Context row (narrow only) | 32 px | ‹ Requests N · name + host subtitle · + New |
| Set tabs | 30 px pane-head | one underline tab per set (**the selected tab is the active set**), `+` adds an empty set, the tab's one action "Duplicate set" in the ctx slot |
| Variables | 26 px kv rows | `8px minmax(80px,34%) 1fr 24px 22px`: name · value · mask toggle · remove; the trailing blank row (placeholders Name / Value) adds a variable, like the params/headers tables |

- The heading is not a field: rename via F2, double-click or the row menu, like everywhere else.
- Sets are renamed the same way (F2 / double-click on the tab / right-click → Rename). The set
  tab's context menu: Rename, Duplicate set, Delete set.
- Masking: the eye toggles a per-variable `secret` flag. Masked values render as dots (a password
  input while editing); revealing is the same toggle. The tooltip says "masked in the UI only,
  stored as plain text". No lock icons, no "encrypted" wording anywhere.
- Empty group (no sets): the empty state with `Add baseUrl = <origin>` (creates the first set,
  named `default`, with that one variable) and "Add variable" (creates the empty first set and
  focuses the blank row). Plain-text storage is stated once, here.

### Request detail (saved requests only)

- **Variables** is a fourth, always-present tab after Params / Headers / Body. Suffix `· <set>`
  when the group has sets; a warn-coloured ● when a placeholder is unresolved. At 320 px the four
  tabs plus the ctx icon fit in 30 px (≈ 300 px); the ctx label folds to its icon below a 340 px
  pane (`.ctx.group-link`), the others below 270 px as today.
- Tab content, top to bottom: the **Set** row (28 px: label, quiet mono select of the group's
  sets, `N values in set` on the right; changing it changes the group's active set), then a
  read-only kv list of every placeholder used by the request in order of appearance with its
  resolved value (secrets as dots), unresolved ones in `--err`. The tab's ctx action opens the
  group ("Open <group>"; icon + group name, ellipsized at 110 px).
- The **status line** (`#bodyStatus`'s slot) reads `N variables · M unresolved: {{a}}, {{b}}` in
  warn colour under every tab whenever something is unresolved; under the Variables tab it
  otherwise reads `N variables · all resolved from <set>`; under Body it keeps "✓ Valid JSON".
- Placeholders stay literal in the URL field, tables and body. Tooltips carry the resolved form:
  the URL field ("Sends to https://…"), each table value, and Send ("Send to … · {{token}} is
  unresolved and goes out as literal text").
- Send never blocks. After a send with unresolved placeholders the toast reads
  `Sent with 1 unresolved: {{token}} · 401` with the action **Variables** (opens the tab). In the
  narrow layout the toast sits above the status line (`bottom: 32px`), so the warning stays visible.
- The narrow context row shows the name or path with the filled bookmark ("Saved to <group>").

### Rename, menus, toasts

- One gesture set everywhere (requests, groups, sets): F2, double-click, context-menu Rename;
  Enter commits, Esc reverts, blur commits. The row's label becomes a 20 px input in place; the
  placeholder is the path or host, so clearing the name falls back to it. In the narrow layout a
  click already opens the detail, so there F2, the row menu and the toast's Rename do the work.
- Right-click on a row opens the same menu as the ⋯ next to Send: Rename `F2`, Duplicate,
  Copy as cURL, — Delete `⌫` (requests); Rename `F2`, Copy origin, — Delete group (groups).
  Menu items use the inline nouns; the shortcut hints are the only discovery aid for F2.
- Toast after saving: `Saved to <group label> · Rename` (the only first-run hint). The Rename
  action starts the inline rename of the row just saved.

### Data shape (for the migration this needs)

```
groups: { [origin]: { name?: string, sets: { [setName]: [{ k, v, secret? }] }, active?: setName } }
request: { …, group: origin }   // assigned at save time; editing the URL (e.g. to {{baseUrl}}/…) does not move it
```

The group key is stored on the request at save time because a URL that starts with `{{baseUrl}}`
has no literal origin to derive it from. The migration derives `group` from each saved URL once.

### Tokens and dimensions

No new colours. Reused: `--warn` (unresolved counts, ● on the Variables tab), `--err` (unresolved
rows), `--accent` (selected chip), `--border-strong` (chip border). New dimensions: renamed group
row 32/36 px, chip 14 px line / 64 px max, Set row 28 px, mask column 24 px, ctx group-link fold
at 340 px. Type stays 11–12 px; mono for set names, chips and values.

## Decisions on the six open questions of #12

1. **Where do variables live?** (c) with a fixed split: the **group detail edits**, the request's
   **Variables tab shows** (resolved values, set select, link to the group). At 214 px the group
   header carries only the chip; at 320 px the four request tabs fit in one row. No editor in the
   list, no header row on the group.
2. **Active set:** the selected set tab in the group detail; repeated only as the Set select at the
   top of the Variables tab, because the group detail is off-screen while a request is shown.
   Never next to Send and never in the response header, so it cannot compete with Recorded/Sent
   or Preview/Raw. The list chip shows it for groups with two or more sets.
3. **Placeholders:** literal text in the plain inputs and textarea, no token highlighting (an
   overlay or contenteditable is not worth its cost in a 320 px panel). State lives in the
   Variables tab, the status line and the tooltips. **Send proceeds with the literal text**: status
   line before, toast with a Variables action after. DevTools never refuses a request.
4. **Extraction on save:** save literal. The group's empty state offers `Add baseUrl = <origin>`,
   which creates the variable but rewrites no request. **Left open:** a per-value "Use variable…"
   on a header or param row; it needs its own mockup (candidate: an item in the kv row's context
   menu that offers the matching variable names from the active set).
5. **Empty and first-run:** Saved empty: "Nothing saved yet — ⌘S or the bookmark keeps the
   selected request. Saved requests are grouped by origin." Group: "No variables yet …" with the
   starter. Variables tab without a group set: "<group> has no variables · Open <group>". The save
   toast with Rename is the only hint; the ever-present Variables tab is the discovery path.
6. **Naming:** **Variables** for name → value, **set** for dev/staging/prod (tabs, chip, select,
   "Duplicate set"). "Environment", "collection" and "global" are avoided; groups are shown by
   origin and called "group" only in tooltips and menu items ("Open Shop API", "Delete group").

## Reference details and implementation boundaries

- Tokens, fonts and control sizes are those of `src/panel.css` on `feat/compact-docking-layout`;
  the prototype's CSS is scoped to `.pc` and can be diffed against it.
- The prototype's in-memory data, the simulated 401, the `default` set name and the sample
  values are illustrative. Retain existing behaviour and data handling; omitted controls are
  not a request to remove them.
- Storage stays `chrome.storage.local`, plain text, as documented in SECURITY.md. The format
  change (names, `group` on requests, sets) needs the versioned migration and maintainer approval
  from AGENTS.md § Workflow.
- cURL export substitutes the active set's values ("Copy as cURL" tooltip says so); import leaves
  text as is. Captured requests are unchanged: no Variables tab, no groups.

## Suggested validation sizes

1024 × 320, 1024 × 240, 850 × 300, 680 × 280, 580 × 240, 380 × 480, 320 × 260 CSS pixels; both
themes; a renamed group with a long name and a long host; ten groups (scrolling, pinned group on
top); a set with twenty variables; a request with six placeholders (status line ellipsis); the
Variables tab at 320 px with the ctx label folded; rename in every row type; the toast together
with the status line in the narrow layout.
