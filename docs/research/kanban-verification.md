# Superagent board implementation verification

Result: implemented, built and applied to the existing DSH profile. Verified against the authenticated application at http://127.0.0.1:3200/ on 2026-11-07 (Asia/Shanghai).

## Delivered behavior

- The default page is Board. Existing Overview, Source, Trigger, Eval, Execution and Settings routes remain available through the workspace navigation.
- Five server-derived columns distinguish queued, working, person, idle and ended. Ended cards retain the real outcome. Empty columns initially collapse when the board has work; manual expansion remains available.
- The read-only board endpoint filters the complete Ticket set before grouping and pagination, supplies complete column counts and uses deterministic ordering.
- Search, source filtering, three sort orders, board/list switching, collapsible columns and load-more controls use actual management data.
- Clicking a Ticket opens non-modal side details with the existing worker session, source conversation, authorization, retry and stop behavior. Escape closes details and restores focus.

## Automated checks

Command: `env -u GIT_CONFIG_GLOBAL pnpm check`

Type checking passed. All 61 test files and 1209 tests passed. Host and browser production artifacts built successfully. The environment adjustment removes the live Superagent worker's inherited global Git configuration from the test process: two existing runtime tests explicitly expect that variable to be absent. It does not alter the application or user configuration.

New coverage exercises five-column classification, all person actions, actual ending outcomes, complete counts, filtering before paging, source discovery, stable ordering, HTTP query normalization and existing request access checks. Panel integration coverage includes route persistence, switching display modes, details and focus restoration, confirmation before retry, detail/board refresh and paging after a Ticket changes columns.

`git diff --check`, documentation module/test indexing, CSS selector/rule checks and locale checks passed. The design detector reported two existing thick left borders in unrelated prompt/Markdown styles (original lines 119 and 369); the new board styles do not introduce that pattern, and those incumbent styles were left intact.

## Runtime application

The bundle was already installed as the linked local package. An install attempt returned `already-installed`; it did not alter the installation. Plugin Manager subsequently disabled and re-enabled the existing `include:dsh-superagent` entry, and both operations returned `application: applied`. Executor load was checked as zero before that reload. The board endpoint answered HTTP 200 afterwards, and live inspection confirmed the Superagent sidebar registration remained active.

Plugin Manager also reported a pre-existing missing `@deepseek-ai/dsh-hooks-claude-code` import for an unrelated hook row. Superagent's endpoint and page remained available. No profile files were edited directly.

## Observed live results

At verification time, the real board contained 106 Tickets: 0 queued, 0 working, 8 needing attention, 4 waiting for events, and 94 ended. The ended column initially displayed 20 cards with a total of 94; clicking load more displayed 40 cards. No test task was added and no retry, stop or pause was submitted against live data.

The actual browser confirmed:

- Searching a deliberately unmatched term showed the no-matches state; clearing filters restored the 106-Ticket total.
- The list switch changed the rendered layout, and switching back restored board mode.
- Opening a real Ticket retained 32 mounted cards. Escape dismissed details; with a focused card as opener, focus returned to that exact card.
- The desktop page did not overflow the document width.
- At a 390×844 viewport with the host sidebar collapsed, the board measured 390px and the document width remained 390px. Inner navigation became horizontal. DSH's expanded outer sidebar consumes 280px at this viewport, so the host sidebar needs to be collapsed for useful phone-width workspace access.
- The host's real dark appearance produced a card background of `rgb(21, 21, 23)` and title text of `rgb(249, 250, 251)`. The dark screenshot was obscured by the host settings dialog and is not used as the primary final preview.

Appearance was restored to the user's original “follow system” preference, browser color preference to light, and the viewport to 1470×802. The desktop host sidebar was restored. A temporary verification tab was used to avoid replacing the user's working tab.

## Finish review

The implemented work board follows the user-pinned Plane layout while using DSH theme tokens and original components. Actual data, complete counts and retained details are the central interactions. The desktop screenshot shows all five columns when the two empty columns collapse. Narrow rendering preserves controls and uses horizontal board navigation.

Verdict: ship. Existing thick left borders elsewhere in the panel and the unrelated hook import warning are outside this change. No product raster assets ship; the package icon is original SVG geometry and its file size, SVG structure, export and package-file inclusion were checked. No Plane source components or artwork were copied.

Primary captures are the desktop board and side details under `.artifacts`. They show the actual installed plugin and real repository data; they are verification captures, not mock previews.
