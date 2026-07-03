import test from "node:test";
import assert from "node:assert/strict";
import { buildCreatorSearchPlan } from "../backend/services/match-service.js";

test("basic trait constraints add positive and negative search terms", () => {
  const plan = buildCreatorSearchPlan({ rawText: "女，coser，颜值，亚洲" }, { platform: "tiktok" });

  assert.equal(plan.platform, "tiktok");
  assert.ok(plan.positiveTerms.includes("female"));
  assert.ok(plan.positiveTerms.includes("asian"));
  assert.ok(plan.positiveTerms.includes("asian girl"));
  assert.ok(plan.positiveTerms.includes("coser"));
  assert.ok(plan.negativeTerms.includes("male"));
  assert.ok(plan.negativeTerms.includes("男"));
  assert.ok(plan.negativeTerms.includes("european"));
  assert.ok(plan.negativeTerms.includes("白人"));
  assert.match(plan.query, /-male/);
  assert.match(plan.query, /-european/);
});
