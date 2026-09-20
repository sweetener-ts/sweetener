import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

const taskStatuses = new Set([
  "not-ready",
  "ready",
  "in-progress",
  "review",
  "blocked",
  "done",
  "superseded",
]);
const healthStatuses = new Set(["green", "yellow", "red"]);
const capabilityStatuses = new Set([
  "pending",
  "in-progress",
  "done",
  "blocked",
]);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read JSON at ${relative(repositoryRoot, path)}: ${error.message}`,
      { cause: error },
    );
  }
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadStatusData() {
  const statePath = join(repositoryRoot, "status", "state.json");
  const reviewPath = join(repositoryRoot, "status", "review.json");
  return {
    state: await readJson(statePath),
    review: await readJson(reviewPath),
  };
}

export async function validateStatusData(state, review) {
  const errors = [];
  assert(
    state.schemaVersion === 1,
    "status schemaVersion must equal 1",
    errors,
  );
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(state.updatedAt ?? ""),
    "updatedAt must use YYYY-MM-DD",
    errors,
  );
  assert(
    /^phase-\d{2}$/.test(state.currentPhase ?? ""),
    "currentPhase must use phase-NN",
    errors,
  );
  assert(
    healthStatuses.has(state.health),
    `unknown health status: ${state.health}`,
    errors,
  );
  assert(
    typeof state.summary === "string" && state.summary.length > 0,
    "summary is required",
    errors,
  );
  assert(Array.isArray(state.tasks), "tasks must be an array", errors);
  assert(
    Array.isArray(state.capabilities),
    "capabilities must be an array",
    errors,
  );
  assert(Array.isArray(state.blockers), "blockers must be an array", errors);
  assert(Array.isArray(state.nextTasks), "nextTasks must be an array", errors);

  const taskIds = new Set();
  const taskOrders = new Set();
  for (const task of state.tasks ?? []) {
    assert(
      /^[A-Z]+-\d{3}$/.test(task.id ?? ""),
      `invalid task ID: ${task.id}`,
      errors,
    );
    assert(!taskIds.has(task.id), `duplicate task ID: ${task.id}`, errors);
    taskIds.add(task.id);
    assert(
      taskStatuses.has(task.status),
      `unknown task status for ${task.id}: ${task.status}`,
      errors,
    );
    assert(
      Number.isInteger(task.order),
      `task order must be an integer: ${task.id}`,
      errors,
    );
    assert(
      !taskOrders.has(task.order),
      `duplicate task order: ${task.order}`,
      errors,
    );
    taskOrders.add(task.order);
    assert(
      Array.isArray(task.prerequisites),
      `task prerequisites must be an array: ${task.id}`,
      errors,
    );
    assert(
      Array.isArray(task.specifications),
      `task specifications must be an array: ${task.id}`,
      errors,
    );
    assert(
      typeof task.nextAction === "string" && task.nextAction.length > 0,
      `task nextAction is required: ${task.id}`,
      errors,
    );
  }

  for (const task of state.tasks ?? []) {
    for (const prerequisite of task.prerequisites) {
      assert(
        taskIds.has(prerequisite),
        `${task.id} references unknown prerequisite ${prerequisite}`,
        errors,
      );
    }
    for (const specification of task.specifications) {
      const filePart = specification.split("#", 1)[0];
      assert(
        await pathExists(join(repositoryRoot, filePart)),
        `${task.id} references missing specification ${specification}`,
        errors,
      );
    }
  }

  if (state.currentTask !== null) {
    assert(
      taskIds.has(state.currentTask),
      `currentTask is unknown: ${state.currentTask}`,
      errors,
    );
    const current = state.tasks.find((task) => task.id === state.currentTask);
    assert(
      current?.status === "in-progress" ||
        current?.status === "review" ||
        current?.status === "blocked",
      "currentTask must be in-progress, review, or blocked",
      errors,
    );
  }

  for (const taskId of state.nextTasks ?? []) {
    assert(
      taskIds.has(taskId),
      `nextTasks references unknown task ${taskId}`,
      errors,
    );
  }

  for (const capability of state.capabilities ?? []) {
    assert(
      typeof capability.id === "string" && capability.id.length > 0,
      "capability ID is required",
      errors,
    );
    assert(
      capabilityStatuses.has(capability.status),
      `unknown capability status for ${capability.id}: ${capability.status}`,
      errors,
    );
  }

  assert(
    review.schemaVersion === 1,
    "review schemaVersion must equal 1",
    errors,
  );
  assert(Array.isArray(review.ready), "review.ready must be an array", errors);
  assert(
    Array.isArray(review.upcoming),
    "review.upcoming must be an array",
    errors,
  );
  for (const item of review.ready ?? []) {
    for (const blockedTask of item.blocks ?? []) {
      assert(
        taskIds.has(blockedTask),
        `${item.id} blocks unknown task ${blockedTask}`,
        errors,
      );
    }
    for (const evidence of item.evidence ?? []) {
      const filePart = evidence.split("#", 1)[0];
      assert(
        await pathExists(join(repositoryRoot, filePart)),
        `${item.id} references missing evidence ${evidence}`,
        errors,
      );
    }
  }

  return errors;
}

function statusMark(status) {
  if (status === "done") return "[x]";
  if (status === "in-progress") return "[~]";
  if (status === "blocked") return "[!]";
  return "[ ]";
}

function taskLink(task) {
  return `[${task.id}](status/tasks/${task.id}.md)`;
}

function specificationLinks(specifications) {
  return specifications
    .map((path) => {
      const [file, anchor] = path.split("#", 2);
      const suffix = anchor ? `#${anchor}` : "";
      return `[${file.split("/").at(-1)}](${file}${suffix})`;
    })
    .join(", ");
}

async function loadCheckReports() {
  const directory = join(repositoryRoot, "artifacts", "test-results");
  if (!(await pathExists(directory))) return [];
  const entries = (await readdir(directory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const reports = [];
  for (const name of entries) {
    const report = await readJson(join(directory, name));
    reports.push({ name: name.slice(0, -5), ...report });
  }
  return reports;
}

/** The commit the tree in front of you is at, where git can say. */
function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Whether `commit` is a commit this repository holds. */
function commitExists(commit) {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What to say about each check report that did not come from the tree in front
 * of you.
 *
 * The validation table records the commit each report ran at and nothing reads
 * it, so a green row can sit above a `Health: green` at a commit where the
 * suite never ran. The staleness is worked out here, when the dashboard is
 * *checked*, rather than written into the file: `STATUS.md` is committed
 * alongside the change it describes, so anything in it that named the current
 * commit was one behind the moment it landed -- which is what made the
 * byte-for-byte render comparison fail from 0.1.0-alpha.3 until `a943ead`
 * removed the marker.
 */
export function staleReports(reports, head, exists = commitExists) {
  if (head === undefined) return [];
  const stale = [];
  for (const report of reports) {
    if (report.commit === undefined) {
      stale.push(
        `${report.name} records no commit, so nothing says when it ran.`,
      );
      continue;
    }
    if (report.commit === head) continue;
    stale.push(
      exists(report.commit)
        ? `${report.name} ran at ${report.commit}, and HEAD is ${head}.`
        : `${report.name} ran at ${report.commit}, which is not a commit in this repository.`,
    );
  }
  return stale;
}

export async function renderStatus(state, review) {
  const current = state.currentTask
    ? state.tasks.find((task) => task.id === state.currentTask)
    : undefined;
  const tasks = [...state.tasks].sort(
    (left, right) => left.order - right.order,
  );
  const reports = await loadCheckReports();
  const lines = [];

  lines.push("# Project Status", "");
  lines.push(`Updated: ${state.updatedAt}  `);
  lines.push(`Current phase: ${state.currentPhase}  `);
  lines.push(`Current slice: ${state.currentSlice}  `);
  lines.push(`Health: ${state.health}  `, "");
  lines.push(state.summary, "");

  lines.push("## Current task", "");
  if (current) {
    lines.push(`Task: ${taskLink(current)} ${current.title}  `);
    lines.push(`Status: ${current.status}  `);
    lines.push(`Owner: ${current.owner ?? "Unassigned"}  `);
    lines.push(`Branch: ${current.branch ?? "None"}`, "");
    lines.push(`Next action: ${current.nextAction}`, "");
  } else {
    lines.push("No task is in progress.", "");
    const firstReady = tasks.find((task) => task.status === "ready");
    if (firstReady)
      lines.push(
        `Next ready task: ${taskLink(firstReady)} ${firstReady.title}`,
        "",
      );
  }

  lines.push("## Phase tasks", "");
  lines.push(
    "| Task | Title | Status | Prerequisites | Specification |",
    "|---|---|---|---|---|",
  );
  for (const task of tasks.filter(
    (task) => task.phase === state.currentPhase,
  )) {
    lines.push(
      `| ${taskLink(task)} | ${task.title} | ${task.status} | ${task.prerequisites.join(", ") || "None"} | ${specificationLinks(task.specifications)} |`,
    );
  }
  lines.push("");

  lines.push("## Capability status", "");
  for (const capability of state.capabilities) {
    lines.push(
      `- ${statusMark(capability.status)} ${capability.id}: ${capability.title}`,
    );
  }
  lines.push("");

  lines.push("## Validation", "");
  if (reports.length === 0) {
    lines.push(
      "No machine-readable test reports exist yet. Compiler implementation has not started.",
      "",
    );
  } else {
    lines.push("| Check | Result | Commit |", "|---|---|---|");
    for (const report of reports) {
      const result =
        report.failed > 0
          ? `${report.failed} failed`
          : `${report.passed ?? 0} passed`;
      lines.push(
        `| ${report.name} | ${result} | ${report.commit ?? "unknown"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Decisions requiring review", "");
  if (review.ready.length === 0) {
    lines.push("None.", "");
  } else {
    for (const item of review.ready) {
      lines.push(`### ${item.id}: ${item.title}`, "", item.decision, "");
      lines.push(`Blocks: ${item.blocks.join(", ") || "None"}`, "");
    }
  }

  lines.push("## Blockers", "");
  if (state.blockers.length === 0) {
    lines.push("None.", "");
  } else {
    for (const blocker of state.blockers) {
      lines.push(
        `- **${blocker.id}: ${blocker.title}.** ${blocker.requiredAction} Evidence: ${blocker.evidence}`,
      );
    }
    lines.push("");
  }

  lines.push("## Next tasks", "");
  state.nextTasks.forEach((id, index) => {
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (task)
      lines.push(
        `${index + 1}. ${taskLink(task)} ${task.title}: ${task.nextAction}`,
      );
  });
  lines.push("");

  lines.push("## Navigation", "");
  lines.push("- [Review queue](status/REVIEW.md)");
  lines.push("- [Work log](status/WORKLOG.md)");
  lines.push("- [Start implementation](docs/tasks/START-HERE.md)");
  lines.push("- [Task index](docs/tasks/README.md)");
  lines.push("- [Specifications](docs/specifications/README.md)");
  lines.push("");
  lines.push(
    "This file is generated from `status/state.json`, `status/review.json`, and machine-readable reports under `artifacts/`.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

export async function runStatus(args = process.argv.slice(2)) {
  const { state, review } = await loadStatusData();
  const errors = await validateStatusData(state, review);
  if (errors.length > 0) {
    throw new Error(
      `Status validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ state, review }, null, 2)}\n`);
    return;
  }

  const rendered = await renderStatus(state, review);
  const statusPath = join(repositoryRoot, "STATUS.md");
  if (args.includes("--check")) {
    const existing = await readFile(statusPath, "utf8").catch(() => "");
    if (existing !== rendered) {
      throw new Error("STATUS.md is stale. Run `node scripts/status.mjs`.");
    }
    const stale = staleReports(await loadCheckReports(), headCommit());
    if (stale.length > 0) {
      throw new Error(
        `A check report in STATUS.md predates this tree, so the result it ` +
          `records is not this commit's:\n${stale
            .map((message) => `- ${message}`)
            .join("\n")}\nRe-run the check and regenerate the status snapshot.`,
      );
    }
    process.stdout.write("Status data is valid and STATUS.md is current.\n");
    return;
  }

  await writeFile(statusPath, rendered, "utf8");
  process.stdout.write(rendered);
}
