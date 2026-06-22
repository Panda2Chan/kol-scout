export const STORAGE_KEYS = {
  KOLS: "kolLite.kols",
  LAST_SCAN: "kolLite.lastScan",
  MATCH_BRIEF: "kolLite.matchBrief"
};

export const STATUS_OPTIONS = ["saved", "shortlisted", "contacted", "ignored"];

export const PLATFORM_LABELS = {
  x: "X",
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  website: "Website",
  unknown: "Unknown"
};

export function createKol(input) {
  const now = Date.now();
  const email = input.contact?.email || extractEmail(`${input.bio || ""} ${input.discovery?.evidenceText || ""}`);
  const normalized = {
    id: input.id || buildKolId(input.platform, input.handle, input.profileUrl),
    platform: input.platform || "unknown",
    name: input.name || input.handle || "Unknown creator",
    handle: input.handle || "",
    profileUrl: input.profileUrl || "",
    avatarUrl: input.avatarUrl || "",
    bio: input.bio || "",
    contact: {
      email,
      source: input.contact?.source || (email ? "public-text" : ""),
      available: Boolean(email)
    },
    metrics: {
      followers: input.metrics?.followers ?? null,
      following: input.metrics?.following ?? null,
      likes: input.metrics?.likes ?? null,
      posts: input.metrics?.posts ?? null
    },
    discovery: {
      kind: input.discovery?.kind || "manual",
      confidence: input.discovery?.confidence ?? 50,
      summary: input.discovery?.summary || "",
      evidenceText: input.discovery?.evidenceText || "",
      needsEnrichment: input.discovery?.needsEnrichment ?? !input.metrics?.followers,
      seenCount: input.discovery?.seenCount || 1,
      surfaces: input.discovery?.surfaces || []
    },
    enrichment: {
      status: input.enrichment?.status || "pending",
      provider: input.enrichment?.provider || "local",
      lastEnrichedAt: input.enrichment?.lastEnrichedAt || null,
      error: input.enrichment?.error || ""
    },
    match: {
      briefId: input.match?.briefId || "",
      score: input.match?.score ?? null,
      level: input.match?.level || "",
      provider: input.match?.provider || "",
      reasons: input.match?.reasons || [],
      concerns: input.match?.concerns || [],
      matchedKeywords: input.match?.matchedKeywords || [],
      missingData: input.match?.missingData || [],
      dimensions: input.match?.dimensions || {},
      evaluatedAt: input.match?.evaluatedAt || null
    },
    quality: {
      score: input.quality?.score ?? null,
      level: input.quality?.level || "",
      fakeFollowerRisk: input.quality?.fakeFollowerRisk || "",
      engagementRate: input.quality?.engagementRate ?? null,
      signals: input.quality?.signals || [],
      concerns: input.quality?.concerns || []
    },
    score: input.score ?? scoreKol(input),
    tags: input.tags || [],
    notes: input.notes || "",
    status: input.status || "saved",
    source: {
      pageUrl: input.source?.pageUrl || "",
      pageTitle: input.source?.pageTitle || "",
      capturedAt: input.source?.capturedAt || now
    },
    schemaVersion: 2,
    createdAt: input.createdAt || now,
    updatedAt: now
  };

  return normalized;
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

export function buildKolId(platform, handle, profileUrl) {
  const key = handle || profileUrl || crypto.randomUUID();
  return `${platform || "unknown"}:${key}`.toLowerCase();
}

export function createMatchBrief(rawText) {
  const normalized = String(rawText || "").trim();
  return {
    id: `brief:${hashText(normalized)}`,
    rawText: normalized,
    updatedAt: Date.now()
  };
}

export function scoreKol(input) {
  let score = 20;

  if (input.profileUrl) score += 15;
  if (input.handle) score += 10;
  if (input.bio && input.bio.length > 30) score += 10;
  if (input.avatarUrl) score += 8;
  if (input.metrics?.followers) score += 14;
  if (input.platform && input.platform !== "unknown") score += 8;
  if (input.discovery?.kind === "profile") score += 12;
  if (input.discovery?.kind === "x-post-author") score += 8;
  if (input.discovery?.kind === "x-visible-profile") score += 10;
  if (input.discovery?.seenCount > 1) score += Math.min(input.discovery.seenCount * 3, 12);

  return Math.min(score, 100);
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
