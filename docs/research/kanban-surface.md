# Superagent board surface

Mode: Operate. Destination: the existing `main` slot at `dsh-superagent`.

The user approved implementation of the previously proposed Plane-style five-column board. The explicit reference and accepted layout pin the direction; no visual variant round is needed.

## Direction contract

THESIS: Put the real work and its human blockers in one navigable board. The board occupies the available work area and retains context when inspecting a Ticket.

OWN-WORLD: Inherit DSH theme tokens, system typography and familiar controls. Use distinct neutral surfaces, thin boundaries and compact cards. Semantic state colors identify working, attention and actual ending outcomes. No borrowed Plane artwork or source components.

STORY: The operator opens Superagent, sees counts and task stages, filters to relevant work, then opens a side detail to inspect or act. Sources, evaluations and settings remain one navigation step away.

FIRST VIEWPORT: Compact application heading and repository identity, workspace navigation, then a search/filter/sort toolbar. Five horizontal columns fill the remaining height; each has a fixed heading, total, collapse control and separately scrolling cards. A side detail overlays the right of the board without resetting board scroll. Narrow screens scroll the board horizontally and show detail full width.

FORM: User-pinned Plane-style application board; `seed: none (unavailable)`. Signature interaction: inspect and act on a Ticket in side details while retaining the board's view and scroll position.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Scope

Accurate five-column API, search and source filter, updated/created ordering, board/list switch, collapsible columns, column pagination, real Ticket metadata, existing confirmed actions, side detail and existing management pages. No arbitrary stage writes or invented project-management fields.
