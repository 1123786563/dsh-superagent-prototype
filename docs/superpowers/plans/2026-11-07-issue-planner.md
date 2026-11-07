# Issue planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scan all open issues, select one ready leaf using root context and dependencies, create a detailed plan, then hand off once through an independent GitHub account mentioning wuyj-agent.

**Architecture:** Independent Host bundle in plugins/issue-planner; GitHub adapter supplies complete graph, deterministic eligibility gates select a candidate, file-locked state machine owns planning and publication. Restricted DSH planner reads a pinned Git checkout using bounded read tools. Publisher persists every outbound intent and reconciles uncertain comments without resending.

**Tech Stack:** Node ESM, node:test, proper-lockfile, Cordis Services.

**Spec:** Approved conversation design, decisions: independent planner account; planning serial, execution uses existing worker concurrency.

## Global Constraints

- Preserve all pre-existing dirty files; work on issue-planner isolated branch.
- No self-mention dispatch: planner login differs from executor and must be allowlisted.
- Entire open-issue set paginated; root-first context; no partial-data eligibility.
- Ready label cannot override dependencies or pending root approval.
- One planner per repository per host; no automatic resend after ambiguous POST.
- Register real superpowers skills with resource bases; missing skills block activation.
- No live external comments during automated tests.

## Review Focus

- Text dependency aliases and parent chains can disagree with native relations.
- Publication may succeed without a response or local receipt.
- Lease loss and pause can occur after planning or between comment segments.
- Skills may reference resources unavailable in worker scope.
- Existing ticket/PR detection must fail closed on incomplete pagination.

### Task 1: Graph and eligibility
Files: plugins/issue-planner/github.js, eligibility.js, tests/eligibility.node.js, tests/github.node.js.
Interfaces: Github.scan() -> snapshot {issues}; evaluate(snapshot, config, busyNumbers) -> {candidates, skipped}; contextFor(snapshot, number) -> root-first issue array.
- [ ] Write tests for dependency contradiction, root approval, alias resolution, cycles, trackers, stable order, >100 issues and pagination failure.
- [ ] Run node --test plugins/issue-planner/tests/{eligibility,github}.node.js; observe RED.
- [ ] Implement snapshot adapter, relationship resolution and deterministic gates.
- [ ] Run same command; require PASS.

### Task 2: Durable publication state machine
Files: store.js, publisher.js, engine.js, tests/store.node.js, tests/engine.node.js.
Interfaces: openStore(lockRoot, repository) -> {data, save, assertHeld, close}; Engine.tick(); publish(record) -> receipt or uncertain.
- [ ] Tests: concurrent locks, crash recovery, atomic records, one plan per tick, one mention, ambiguous POST never resent, pause/lock loss during publication.
- [ ] Observe RED; implement minimal durable state and reconciliation; require PASS.

### Task 3: Skill and runtime integration
Files: skills.js, planner.js, index.js, prompts/plan-issue.md, tests/runtime.node.js.
Interfaces: loadSkills(root) -> registrations + digest; plan(snapshot, record, signal) -> {text, commit, sessionId}; availability() -> authorization and busyNumbers.
- [ ] Tests: missing skills/resources, distinct identity and allowlist, safe read paths, plan contract, stopped/failed planner, configuration and no-op disabled mode.
- [ ] Observe RED; implement scoped skill registration, pinned checkout, read-only tools and explicit plan submission.
- [ ] Require runtime tests PASS and bundle syntax checks.

### Task 4: Distribution and verification
Files: package.json, cordis.patch.yml, locale/*.json, icon.svg, README.md, VERIFICATION.md.
- [ ] Add distribution files and explicit disabled, unconfigured defaults.
- [ ] Run node --test plugins/issue-planner/tests/*.node.js; validate package manifest and icon.
- [ ] Independent review of new bundle; fix material findings with regression tests.
- [ ] Perform target repository read-only scan; install disabled bundle if profile permits. Missing independent credentials remain explicit not_ready, no live comments.

## Ledger

Plan approved before implementation. HiRoute discovery unavailable (DaemonUnavailable); execute inline. Base d59542f332ddf39ccd42f48d729ddf34b418676a. New implementation lives in isolated worktree, existing dirty source unchanged.
