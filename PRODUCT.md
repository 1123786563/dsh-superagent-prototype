# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Operators supervising the coding agent for a GitHub repository inside DeepSeek Harness.

## Product Purpose

Superagent receives requests from configured sources, evaluates authorization, and executes accepted Tickets in dedicated DSH sessions. The management interface shows work in progress and work needing human attention.

## Capabilities and Constraints

- Tickets are authorized work. Their stages derive from assignments, reports, human questions and ending facts.
- The board presents five mutually exclusive columns: queued, working, needs a person, waiting for events, and ended. Ended preserves each actual outcome.
- Existing source, trigger, evaluation, execution and settings pages remain available.
- Reuse existing retry, stop, source discussion and execution session operations.
- Column totals, filtering and pagination must reflect the full matching set.
- The interface runs as the installed DSH plugin, using the host's theme tokens and locale service.

## Brand Commitments

The user requested a Plane-style kanban interface replacing the Superagent default management page, and then requested implementation of the proposed five-column page. Keep the Superagent sidebar destination and provide a wide board, compact task cards, list switching and side details. Follow the host's light/dark appearance.

## Evidence on Hand

Existing implementation and domain documentation live in src and docs. The implementation proposal is docs/research/superagent-kanban-plan.md. Plane preview commit 618d0eb74658329a6f6e92434ac54231422c5b96 supplied design research; independently implement the interface using this project's own components.
