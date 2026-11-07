# Superagent interface

## Direction

A Plane-inspired working board within the existing DeepSeek Harness application. The operator should see work and human decisions immediately, inspect a task in side details and return to the same board position. The user requested the five-column replacement and approved its implementation.

## Visual system

Use the host's `--dsw-alias-*` semantic tokens, inherited font, locale and control behavior. Application base, layer 1 and layer 2 separate the workspace, navigation and interaction surfaces. Use a single thin border to define cards and columns; semantic warning/error colors identify actual attention states. New cards use a 12px radius and compact 13px titles with 21px leading. Small metadata uses tabular numerals; page titles use 22px/30px and -0.025em tracking.

## Structure

The plugin heading contains the Superagent identity, configured repository, global record search, glossary and main-session shortcut. A 156px inner navigation provides the board and the existing management pages. The board has title and executor status, then search/source/sort controls and a board/list switch. Five mutually exclusive columns derive from the domain: queued, working, person, idle, ended. Empty columns initially collapse when the board has Tickets; users can expand them. Preserve explicit visibility choices while the board is mounted.

The canvas scrolls horizontally and each expanded column scrolls vertically. Card properties come from real Ticket projections. Clicking a card opens a non-modal side detail, retaining mounted cards, filters and scroll positions. Escape closes it and returns focus to the opener. Confirmations retain their existing modal behavior.

## Responsive behavior

At a workspace width under 680px, inner navigation becomes a horizontal scrolling row. Controls wrap, columns remain horizontally navigable and side details become full width. The page itself must not overflow horizontally. Reduced-motion preferences disable the detail entrance. Dark mode inherits the host theme rather than applying an independent palette.

## Assets

The package icon is original SVG geometry authored for this board. No Plane components, source fragments or artwork were copied. No raster asset ships as part of the interface. Validation screenshots are captures of the actual existing DSH page, not product artwork.

## Verification

Implementation received type checking, full repository tests and production builds. Browser review covers the actual installed plugin at http://127.0.0.1:3200/, board counts, empty-column treatment, task detail and focus restoration, filtering, list switching, pagination, light rendering, actual dark-theme colors and narrow layout. See docs/research/kanban-verification.md for the final observed results and limitations.
