# Status and Visibility Workflow

## Purpose

The repository records project state in files that developers, reviewers, CI,
and automation can inspect. `status/state.json` supplies canonical task and
capability state. Scripts combine that state with review data and command reports
to generate [STATUS.md](../../STATUS.md).

## Files

```text
STATUS.md                  generated dashboard
status/state.json          canonical phase, task, capability, and blocker state
status/review.json         canonical review queue
status/REVIEW.md           human context for pending decisions
status/WORKLOG.md          chronological checkpoint log
status/tasks/<TASK>.md     evidence and review record for one task
artifacts/test-results/    machine-readable test reports
artifacts/benchmarks/      machine-readable benchmark samples
artifacts/review/          token trees, traces, maps, and other review artifacts
scripts/status.mjs         validate data and regenerate dashboard
scripts/status-check.mjs   fail when data is invalid or dashboard is stale
scripts/evidence.mjs       print or create a task evidence record
```

## Commands

The initial scripts require Node and no installed packages:

```text
node scripts/status.mjs
node scripts/status.mjs --json
node scripts/status-check.mjs
node scripts/evidence.mjs FND-001
node scripts/evidence.mjs FND-001 --write
```

The workspace task can add `pnpm status`, `pnpm status:check`, and
`pnpm evidence` aliases after ADR-0001 selects the package manager.

## Canonical-data rule

Edit `status/state.json` and `status/review.json`; regenerate `STATUS.md`. Do not
edit generated dashboard content by hand. `status-check.mjs` compares the file
byte for byte and fails when it is stale.

Status validation checks:

- state and status enums;
- task ID and order uniqueness;
- prerequisite and next-task references;
- current-task consistency;
- specification and review-evidence paths;
- review references to blocked tasks.

The JSON schemas document the formats. The dependency-free script performs the
runtime checks until the workspace adds a schema validator.

## Task start procedure

1. Confirm that the task has status `ready` and its prerequisites have finished.
2. Set the task to `in-progress` in `status/state.json`.
3. Set `currentTask`, owner, branch, and next action.
4. Update `updatedAt`.
5. Add a work-log entry with the task goal and expected evidence.
6. Run `node scripts/status.mjs`.
7. Run `node scripts/status-check.mjs` before publishing the change.

## Checkpoint procedure

At a working result, discovery, failed validation, or review point:

1. Update the task evidence record with facts and command results.
2. Add a concise work-log entry.
3. Add or update blockers and review items in canonical JSON.
4. Store generated review material under `artifacts/review/<slice>/`.
5. Store command reports as JSON under `artifacts/test-results/` or
   `artifacts/benchmarks/`.
6. Regenerate the dashboard.

## Task completion procedure

1. Run the task's required validation ladder.
2. Update the evidence record with files, diagnostics, tests, benchmark result,
   deviations, and remaining limits.
3. Set the task status to `done`.
4. Clear `currentTask` or assign the next started task.
5. Change dependent tasks from `not-ready` to `ready` when all prerequisites
   have status `done`.
6. Update capability status from conformance evidence.
7. Add one completion entry to the work log.
8. Regenerate and check the dashboard.

## Test-report contract

Each root test command writes a JSON report:

```json
{
  "schemaVersion": 1,
  "commit": "abc123",
  "startedAt": "2026-08-02T14:00:00Z",
  "durationMs": 842,
  "passed": 128,
  "failed": 0,
  "skipped": 3,
  "capabilities": ["PAT-REP-NESTED"]
}
```

Use stable report names: `unit.json`, `conformance.json`, `property.json`,
`incremental.json`, and `typescript.json`. The dashboard names the commit each
report ran against, so a reader can see which ones predate the current tree.

Nothing generated names the current commit. The dashboard is committed with the
change it describes, so a value read from `git` at render time would be one
commit behind the moment it landed, and the check that compares the file byte
for byte could never pass again.

## Status update format

A human or agent update contains:

```text
Task: FND-001
State: in progress
Outcome: workspace builds with strict project references
Validation: typecheck pass; 14 tests pass; boundary check pending
Discovery: type-aware lint adds startup time
Decision needed: none
Next action: implement package boundary checks
```

Report command evidence and next action. Avoid percentages and unsupported time
estimates.

## Review checkpoints

Task review checks the task contract. Phase review checks the integrated vertical
slice. A phase review needs:

- capability status;
- clean and incremental validation where available;
- playground acceptance results;
- benchmark change;
- review artifacts for the compiler stages added in that phase;
- unresolved decisions and specification deviations.

The phase review produces a go, revise, or stop decision in the work log and
review queue.

## Git policy

Commit canonical status changes and `STATUS.md` with the task change they
describe. Generated test and benchmark artifacts remain ignored unless a phase
review promotes a selected report into a tracked document. Task evidence records
remain tracked.

CI runs `node scripts/status-check.mjs`. A stale dashboard, invalid task
reference, missing specification, or inconsistent current task blocks the change.
