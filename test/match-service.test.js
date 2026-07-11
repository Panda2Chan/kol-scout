import test from "node:test";
import assert from "node:assert/strict";
import { buildCreatorSearchPlan } from "../backend/services/match-service.js";

test("creator search defaults to TikTok", () => {
  const plan = buildCreatorSearchPlan({ rawText: "美妆测评 creator" });

  assert.equal(plan.platform, "tiktok");
});

test("TikTok has priority when multiple platforms are mentioned", () => {
  const plan = buildCreatorSearchPlan({ rawText: "同时找 TikTok 和 X 的美妆 creator" });

  assert.equal(plan.platform, "tiktok");
});

test("creator search supports YouTube aliases and strips platform stopwords", () => {
  const plan = buildCreatorSearchPlan({ rawText: "找 YouTube / YT 上的 AI 教程频道，粉丝 10k+，排除 news" });

  assert.equal(plan.platform, "youtube");
  assert.ok(plan.positiveTerms.includes("ai"));
  assert.ok(plan.positiveTerms.includes("教程"));
  assert.equal(plan.positiveTerms.includes("youtube"), false);
  assert.equal(plan.positiveTerms.includes("yt"), false);
  assert.equal(plan.constraints.followerRange.min, 10_000);
});

test("creator search extracts YouTube direct profiles", () => {
  const plan = buildCreatorSearchPlan({
    rawText: "参考 https://www.youtube.com/@BeautyCreator 和 https://youtube.com/channel/UCabc123_xyz"
  }, { platform: "YouTube" });

  assert.equal(plan.platform, "youtube");
  assert.ok(plan.directProfiles.includes("@BeautyCreator"));
  assert.ok(plan.directProfiles.includes("channel/UCabc123_xyz"));
});

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
