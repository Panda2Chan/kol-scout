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

test("TikTok unknown followers are filtered when a follower floor is required", () => {
  const filters = {
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium"
  };
  const baseCreator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@beauty.creator",
    discovery: { kind: "third-party-search" },
    metrics: { followers: null },
    match: { score: 75, dimensions: { baseMatch: 75 } },
    quality: { score: 72, fakeFollowerRisk: "low", concerns: [] },
    tags: ["beauty", "review"]
  };

  assert.equal(__testing.getFilteredReason(baseCreator, filters), "粉丝数未知");
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

test("Discovery filters default to 10000 followers but allow explicit zero", () => {
  assert.equal(__testing.normalizeFilters({}, {}).minFollowers, 10000);
  assert.equal(__testing.normalizeFilters({ minFollowers: 0 }, {}).minFollowers, 0);
  assert.equal(__testing.normalizeFilters({}, { followerRange: { min: 50000 } }).minFollowers, 50000);
});

test("Country filter rejects mismatches and downgrades missing evidence", () => {
  const filters = __testing.normalizeFilters({
    country: "JP",
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium"
  });
  const baseCreator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@cosplay.creator",
    name: "Cosplay Creator",
    handle: "@cosplay.creator",
    bio: "cosplay creator with daily costume videos",
    discovery: { kind: "web-search", evidenceText: "title: Cosplay Creator on TikTok; snippet: cosplay creator" },
    enrichment: { status: "ready" },
    metrics: { followers: 30000 },
    tags: ["cosplay"],
    contact: {},
    match: { score: 82, reasons: ["内容命中 cosplay"], dimensions: { baseMatch: 82 } },
    quality: { score: 76, fakeFollowerRisk: "low", concerns: [] }
  };
  const japaneseCreator = {
    ...baseCreator,
    bio: "Tokyo based Japanese cosplay creator with daily costume videos",
    discovery: { ...baseCreator.discovery, evidenceText: "title: Japanese Cosplayer; snippet: Tokyo cosplay creator" }
  };
  const [missingCountryCreator] = __testing.applyPostProcessingScores([
    __testing.buildRuleAnalyzedCreator(baseCreator, baseCreator.match, filters)
  ]);
  const [matchedCountryCreator] = __testing.applyPostProcessingScores([
    __testing.buildRuleAnalyzedCreator(japaneseCreator, japaneseCreator.match, filters)
  ]);

  assert.equal(__testing.getFilteredReason(japaneseCreator, filters), "");
  assert.equal(
    __testing.getFilteredReason({
      ...baseCreator,
      bio: "Brazilian cosplay creator with daily costume videos",
      discovery: { ...baseCreator.discovery, evidenceText: "title: Brazilian Cosplayer; snippet: Sao Paulo cosplay creator" }
    }, filters),
    "国家不匹配：日本"
  );
  assert.equal(__testing.getFilteredReason(baseCreator, filters), "");
  assert.ok(missingCountryCreator.score < matchedCountryCreator.score);
  assert.equal(missingCountryCreator.tags.includes("待确认：日本"), false);
  assert.equal(missingCountryCreator.match.reasons.includes("日本证据未确认，排序降权"), false);
  assert.equal(missingCountryCreator.match.concerns.includes("国家证据不足：日本，已降权"), false);
  assert.deepEqual(missingCountryCreator.match.dimensions.featureEvidenceGaps, [{
    type: "country",
    id: "country:JP",
    category: "country",
    label: "日本",
    reason: "国家证据不足：日本"
  }]);
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

test("TikTok web-search candidates need verified profile evidence", () => {
  const bareCreator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@pretty.friend",
    discovery: { kind: "web-search" },
    enrichment: { status: "partial" },
    metrics: { followers: null },
    tags: ["颜值", "黑丝"],
    bio: "",
    avatarUrl: "",
    contact: {}
  };
  const snippetOnlyCreator = {
    ...bareCreator,
    bio: "Keywords: Harley Quinn cosplay Halloween ideas, Asian girl cosplay",
    tags: ["cosplay", "asian"]
  };
  const enrichedCreator = {
    ...bareCreator,
    enrichment: { status: "ready" },
    bio: "颜值 交友 黑丝 fashion creator with daily outfit videos",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg",
    metrics: { followers: 12000 }
  };

  assert.equal(__testing.hasMinimumProfileEvidence(bareCreator), false);
  assert.equal(__testing.hasMinimumProfileEvidence(snippetOnlyCreator), false);
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
    profileUrl: "https://www.tiktok.com/@pretty.friend",
    discovery: { kind: "web-search" },
    enrichment: { status: "ready" },
    metrics: { followers: 3000 },
    tags: ["颜值", "黑丝"],
    bio: "颜值 交友 黑丝 fashion creator with daily outfit videos",
    avatarUrl: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/avatar.jpeg",
    contact: {},
    match: { score: 0, dimensions: { baseMatch: 0 } },
    quality: { score: 72, fakeFollowerRisk: "low", concerns: [] }
  };

  assert.equal(__testing.getFilteredReason(creator, filters), "低匹配度");
});

test("Basic trait constraints reject candidates with opposite gender evidence", () => {
  const filters = __testing.normalizeFilters({
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium",
    requiredGender: "female"
  });
  const creator = {
    platform: "tiktok",
    name: "Male Coser",
    handle: "@male.coser",
    bio: "male coser and cosplay creator with daily costume videos",
    discovery: {
      kind: "web-search",
      evidenceText: "title: Male Coser on TikTok; snippet: male cosplay creator"
    },
    metrics: { followers: 30000 },
    tags: ["coser", "cosplay"],
    contact: {},
    match: { score: 82, dimensions: { baseMatch: 82 } },
    quality: { score: 76, fakeFollowerRisk: "low", concerns: [] }
  };

  assert.equal(__testing.getFilteredReason(creator, filters), "基础特征不匹配：女性");
});

test("Basic trait constraints reject candidates with opposite region evidence", () => {
  const filters = __testing.normalizeFilters({
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium",
    requiredRegion: "asian"
  });
  const creator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@euro.coser",
    name: "European Coser",
    handle: "@euro.coser",
    bio: "European cosplay creator with daily costume videos",
    discovery: {
      kind: "web-search",
      evidenceText: "title: European Coser on TikTok; snippet: caucasian cosplay creator"
    },
    enrichment: { status: "ready" },
    metrics: { followers: 30000 },
    tags: ["coser", "cosplay"],
    contact: {},
    match: { score: 82, dimensions: { baseMatch: 82 } },
    quality: { score: 76, fakeFollowerRisk: "low", concerns: [] }
  };

  assert.equal(__testing.getFilteredReason(creator, filters), "基础特征不匹配：亚洲/亚裔");
});

test("Basic trait constraints downgrade missing profile evidence without filtering", () => {
  const filters = __testing.normalizeFilters({
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium",
    requiredRegion: "asian"
  });
  const creator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@cosplay.creator",
    name: "Cosplay Creator",
    handle: "@cosplay.creator",
    bio: "Cosplay creator with daily costume videos and makeup transitions",
    discovery: {
      kind: "web-search",
      evidenceText: "snippet: Keywords: Harley Quinn cosplay Halloween ideas, Asian girl cosplay"
    },
    enrichment: { status: "ready" },
    metrics: { followers: 30000 },
    tags: ["coser", "cosplay", "asian"],
    contact: {},
    match: { score: 82, reasons: ["内容命中 cosplay"], dimensions: { baseMatch: 82 } },
    quality: { score: 76, fakeFollowerRisk: "low", concerns: [] }
  };
  const analyzed = __testing.buildRuleAnalyzedCreator(creator, creator.match, filters);

  assert.equal(__testing.getFilteredReason(creator, filters), "");
  assert.equal(analyzed.tags.includes("待确认：亚洲/亚裔"), false);
  assert.equal(analyzed.match.reasons.includes("亚洲/亚裔证据未确认，排序降权"), false);
  assert.equal(analyzed.match.concerns.includes("基础特征证据不足：亚洲/亚裔，已降权"), false);
  assert.deepEqual(analyzed.match.dimensions.featureEvidenceGaps, [{
    reason: "基础特征证据不足：亚洲/亚裔",
    traitId: "region:asian",
    category: "region",
    label: "亚洲/亚裔",
    type: "basic-trait",
    id: "region:asian"
  }]);
});

test("Basic trait constraints accept candidates with profile-level trait evidence", () => {
  const filters = __testing.normalizeFilters({
    minFollowers: 10000,
    minMatchScore: 50,
    minQualityScore: 55,
    maxFakeFollowerRisk: "medium",
    requiredRegion: "asian"
  });
  const creator = {
    platform: "tiktok",
    profileUrl: "https://www.tiktok.com/@asian.coser",
    name: "Asian Coser",
    handle: "@asian.coser",
    bio: "Asian cosplay creator with daily costume videos and makeup transitions",
    discovery: { kind: "web-search", evidenceText: "snippet: cosplay creator" },
    enrichment: { status: "ready" },
    metrics: { followers: 30000 },
    tags: ["coser", "cosplay"],
    contact: {},
    match: { score: 82, dimensions: { baseMatch: 82 } },
    quality: { score: 76, fakeFollowerRisk: "low", concerns: [] }
  };

  assert.equal(__testing.getFilteredReason(creator, filters), "");
});
