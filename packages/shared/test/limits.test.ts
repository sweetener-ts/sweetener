import { describe, expect, it } from "vitest";
import {
  createResourceBudget,
  ResourceLimitError,
  ResourceTracker,
} from "../src/limits.js";

describe("resource budgets", () => {
  it("tracks each compiler resource", () => {
    const tracker = new ResourceTracker(createResourceBudget());
    tracker.chargeInputTokens(2);
    tracker.chargeOutputTokens(3);
    tracker.chargeExpansionSteps();
    tracker.chargeTemplateSteps(2);
    tracker.chargeMatcherSteps(4);
    tracker.enterNesting();
    expect(tracker.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      expansionSteps: 1,
      templateSteps: 2,
      matcherSteps: 4,
      nestingDepth: 1,
    });
    tracker.leaveNesting();
    expect(tracker.usage.nestingDepth).toBe(0);
  });

  it("reports the resource, limit, and observed value", () => {
    const tracker = new ResourceTracker(
      createResourceBudget({ maxMatcherSteps: 2 }),
    );
    tracker.chargeMatcherSteps(2);
    expect(() => tracker.chargeMatcherSteps()).toThrowError(
      new ResourceLimitError("matcher-steps", 2, 3),
    );
  });

  it("measures the deadline from when it started, not from the epoch", () => {
    // A deadline is how long expansion may take. Compared against the clock
    // directly, any plausible setting is a moment decades past and fails on
    // the first check, as `deadlineMs: 30000` would.
    let clock = 1_000_000;
    const tracker = new ResourceTracker(
      createResourceBudget({ deadlineMs: 10 }),
      () => clock,
    );
    expect(() => tracker.checkDeadline()).not.toThrow();
    clock += 5;
    expect(() => tracker.checkDeadline()).not.toThrow();
    clock += 20;
    expect(() => tracker.checkDeadline()).toThrowError(
      new ResourceLimitError("deadline", 10, 25),
    );
  });

  it("rejects invalid budgets and unbalanced nesting", () => {
    expect(() => createResourceBudget({ maxInputTokens: -1 })).toThrow(
      RangeError,
    );
    const tracker = new ResourceTracker(createResourceBudget());
    expect(() => tracker.leaveNesting()).toThrow(RangeError);
  });
});
