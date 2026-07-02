import test from "node:test";
import assert from "node:assert/strict";
import { __testing } from "../backend/services/ai-search-service.js";

test("AI creator reviews normalize by id and handle", () => {
  const reviews = __testing.normalizeAiCreatorReviews({
    reviews: [
      {
        id: "tiktok:@one",
        handle: "@one",
        semanticScore: 88,
        evidenceConfidence: 70,
        collaborationFit: 82,
        normalizedTags: ["beauty", "review"],
        reasons: ["内容垂直"],
        concerns: ["粉丝数未知"]
      }
    ]
  });

  assert.equal(reviews.get("tiktok:@one").semanticScore, 88);
  assert.equal(reviews.get("@one").collaborationFit, 82);
});

test("AI creator reviews merge cleaned metadata into creators", () => {
  const creators = [{
    id: "tiktok:@one",
    platform: "tiktok",
    handle: "@one",
    bio: "",
    tags: ["beauty"],
    match: { score: 60, reasons: [], concerns: [], dimensions: {} },
    quality: { signals: [], concerns: [] }
  }];
  const reviews = __testing.normalizeAiCreatorReviews({
    reviews: [{
      id: "tiktok:@one",
      semanticScore: 90,
      evidenceConfidence: 75,
      collaborationFit: 86,
      isPersonalCreator: true,
      cleanedBio: "Beauty creator sharing skincare reviews.",
      normalizedTags: ["skincare"],
      reasons: ["符合美妆测评"],
      concerns: []
    }]
  });
  const [merged] = __testing.mergeAiCreatorReviews(creators, reviews);

  assert.equal(merged.bio, "Beauty creator sharing skincare reviews.");
  assert.deepEqual(merged.tags, ["beauty", "skincare"]);
  assert.equal(merged.aiReview.semanticScore, 90);
  assert.equal(merged.match.provider, "discovery-ai-rerank-v1");
  assert.ok(merged.match.reasons.some((reason) => reason.includes("AI复核")));
});

test("Feedback summary compacting keeps only small serializable hints", () => {
  const compact = __testing.compactFeedbackSummary({
    total: 3,
    saved: 2,
    ignored: 1,
    removed: 0,
    preferredTags: ["beauty", "review"],
    rejectedTags: ["shop"],
    savedExamples: [{ handle: "@a" }],
    ignoredExamples: [{ handle: "@b" }]
  });

  assert.equal(compact.total, 3);
  assert.deepEqual(compact.preferredTags, ["beauty", "review"]);
  assert.deepEqual(compact.ignoredExamples, [{ handle: "@b" }]);
});
