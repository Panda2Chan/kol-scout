import test from "node:test";
import assert from "node:assert/strict";
import { DiscoveryTimeoutError, __testing } from "../backend/services/discovery-service.js";

test("Discovery timeout message defaults to the 10-minute global budget", () => {
  const error = new DiscoveryTimeoutError();

  assert.equal(error.timeoutMs, 10 * 60 * 1000);
  assert.equal(error.message, "全站匹配超过 10 分钟，请缩小筛选条件后重试。");
});

test("Discovery timeout message reports early abort elapsed time separately from total budget", () => {
  const error = new DiscoveryTimeoutError(5 * 60 * 1000, 101_000);

  assert.equal(
    error.message,
    "全站匹配已等待 1 分 41 秒后中止（总上限 5 分钟），请缩小筛选条件后重试。"
  );
});

test("Discovery timeout message keeps the original total-timeout wording near the limit", () => {
  const error = new DiscoveryTimeoutError(5 * 60 * 1000, 301_000);

  assert.equal(error.message, "全站匹配超过 5 分钟，请缩小筛选条件后重试。");
});

test("TikTok discovery fetch limit keeps a large raw recall pool", () => {
  assert.equal(__testing.calculateDiscoveryFetchLimit("tiktok", 5), 80);
  assert.equal(__testing.calculateDiscoveryFetchLimit("tiktok", 20), 100);
  assert.equal(__testing.calculateDiscoveryFetchLimit("tiktok", 50), 150);
  assert.equal(__testing.calculateDiscoveryFetchLimit("x", 20), 60);
});

test("TikTok unknown followers are kept with a penalty instead of hard-filtered", () => {
  const filters = {
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium"
  };
  const baseCreator = {
    platform: "tiktok",
    discovery: { kind: "third-party-search" },
    metrics: { followers: null },
    match: { score: 75, dimensions: { baseMatch: 75 } },
    quality: { score: 72, fakeFollowerRisk: "low", concerns: [] },
    tags: ["beauty", "review"]
  };

  assert.equal(__testing.getFilteredReason(baseCreator, filters), "");
  assert.equal(__testing.getUnknownFollowerPenalty(baseCreator, filters), 6);
  assert.equal(
    __testing.getFilteredReason({ ...baseCreator, platform: "x" }, filters),
    "粉丝数未知"
  );
  assert.equal(
    __testing.getFilteredReason({
      ...baseCreator,
      metrics: { followers: 5000 }
    }, filters),
    "粉丝数不足"
  );
});

test("extra penalties reduce final score without bypassing risk penalty", () => {
  const quality = { score: 80, fakeFollowerRisk: "medium" };
  assert.equal(__testing.calculateFinalScore(80, quality, 0), 72);
  assert.equal(__testing.calculateFinalScore(80, quality, 6), 66);
});

test("AI adjusted score blends review scores and leaves missing scores neutral", () => {
  assert.equal(__testing.calculateAiAdjustedScore(70, null, 0), 70);
  assert.equal(__testing.calculateAiAdjustedScore(70, { semanticScore: null }, 0), 70);
  assert.equal(__testing.calculateAiAdjustedScore(70, {
    semanticScore: 90,
    collaborationFit: 80,
    evidenceConfidence: 70
  }, 4), 78);
  assert.equal(__testing.calculateAiAdjustedScore(70, {
    semanticScore: 90,
    collaborationFit: 80,
    evidenceConfidence: 70,
    reject: true
  }, 0), 52);
});

test("feedback summary boosts preferred tags and serializes without Sets", () => {
  const summary = __testing.summarizeFeedback({
    items: [
      { action: "saved", platform: "tiktok", id: "tiktok:@a", tags: ["beauty", "review"], updatedAt: 3 },
      { action: "ignored", platform: "tiktok", id: "tiktok:@b", tags: ["shop"], updatedAt: 2 },
      { action: "removed", platform: "x", id: "x:@c", tags: ["ai"], updatedAt: 1 }
    ]
  }, "tiktok");

  assert.equal(summary.total, 2);
  assert.deepEqual(summary.preferredTags, ["beauty", "review"]);
  assert.deepEqual(summary.rejectedTags, ["shop"]);
  assert.equal(__testing.calculateFeedbackBoost({ id: "tiktok:@a", tags: ["beauty"] }, summary), 10);

  const serialized = __testing.serializeFeedbackSummary(summary);
  assert.deepEqual(Object.keys(serialized).sort(), [
    "ignored",
    "ignoredExamples",
    "preferredTags",
    "rejectedTags",
    "removed",
    "saved",
    "savedExamples",
    "total"
  ].sort());
  assert.equal(serialized.saved, 1);
});

test("TikTok web-search candidates need enough profile evidence", () => {
  const bareCreator = {
    platform: "tiktok",
    discovery: { kind: "web-search" },
    metrics: { followers: null },
    tags: ["颜值", "黑丝"],
    bio: "",
    avatarUrl: "",
    contact: {}
  };
  const enrichedCreator = {
    ...bareCreator,
    bio: "颜值 交友 黑丝 fashion creator with daily outfit videos"
  };

  assert.equal(__testing.hasMinimumProfileEvidence(bareCreator), false);
  assert.equal(__testing.hasMinimumProfileEvidence(enrichedCreator), true);
});

test("Low-score TikTok candidates do not bypass the minimum match score", () => {
  const filters = {
    minFollowers: 2000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium"
  };
  const creator = {
    platform: "tiktok",
    discovery: { kind: "web-search" },
    metrics: { followers: null },
    tags: ["颜值", "黑丝"],
    bio: "颜值 交友 黑丝 fashion creator with daily outfit videos",
    avatarUrl: "",
    contact: {},
    match: { score: 0, dimensions: { baseMatch: 0 } },
    quality: { score: 72, fakeFollowerRisk: "low", concerns: [] }
  };

  assert.equal(__testing.getFilteredReason(creator, filters), "低匹配度");
});
