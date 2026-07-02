import { STORAGE_KEYS, createKol } from "./schema.js";

const FEEDBACK_LIMIT = 240;

export async function getKols() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.KOLS);
  return data[STORAGE_KEYS.KOLS] || [];
}

export async function saveKols(kols) {
  await chrome.storage.local.set({ [STORAGE_KEYS.KOLS]: kols });
  return kols;
}

export async function upsertKols(candidates) {
  const existing = await getKols();
  const byId = new Map(existing.map((kol) => [kol.id, kol]));

  for (const candidate of candidates) {
    const normalized = createKol(candidate);
    const previous = byId.get(normalized.id);
    byId.set(normalized.id, {
      ...previous,
      ...normalized,
      tags: previous?.tags?.length ? previous.tags : normalized.tags,
      notes: previous?.notes || normalized.notes,
      status: previous?.status || normalized.status,
      createdAt: previous?.createdAt || normalized.createdAt,
      updatedAt: Date.now()
    });
  }

  return saveKols([...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt));
}

export async function updateKol(id, patch) {
  const kols = await getKols();
  const next = kols.map((kol) =>
    kol.id === id ? { ...kol, ...patch, updatedAt: Date.now() } : kol
  );
  await saveKols(next);
  return next.find((kol) => kol.id === id);
}

export async function removeKol(id) {
  const kols = await getKols();
  const next = kols.filter((kol) => kol.id !== id);
  await saveKols(next);
  return next;
}

export async function clearKols() {
  await chrome.storage.local.remove(STORAGE_KEYS.KOLS);
}

export async function getDiscoveryFeedback(options = {}) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.DISCOVERY_FEEDBACK);
  const store = data[STORAGE_KEYS.DISCOVERY_FEEDBACK] || { version: 1, items: [] };
  const items = Array.isArray(store.items) ? store.items : [];
  const platform = options.platform || "";
  return {
    version: 1,
    items: items
      .filter((item) => !platform || !item.platform || item.platform === platform)
      .slice(0, options.limit || FEEDBACK_LIMIT)
  };
}

export async function recordDiscoveryFeedback(creators, action, context = {}) {
  if (!action) return getDiscoveryFeedback();
  const incoming = (Array.isArray(creators) ? creators : [creators])
    .filter(Boolean)
    .map((creator) => createFeedbackItem(creator, action, context));
  if (!incoming.length) return getDiscoveryFeedback();

  const existing = await getDiscoveryFeedback({ limit: FEEDBACK_LIMIT });
  const byKey = new Map(existing.items.map((item) => [feedbackKey(item), item]));

  for (const item of incoming) {
    byKey.set(feedbackKey(item), {
      ...byKey.get(feedbackKey(item)),
      ...item,
      updatedAt: Date.now()
    });
  }

  const next = {
    version: 1,
    items: [...byKey.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, FEEDBACK_LIMIT)
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.DISCOVERY_FEEDBACK]: next });
  return next;
}

export async function getLastScan() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LAST_SCAN);
  return data[STORAGE_KEYS.LAST_SCAN] || null;
}

export async function setLastScan(scan) {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_SCAN]: scan });
  return scan;
}

export async function getMatchBrief() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.MATCH_BRIEF);
  return data[STORAGE_KEYS.MATCH_BRIEF] || null;
}

export async function setMatchBrief(brief) {
  await chrome.storage.local.set({ [STORAGE_KEYS.MATCH_BRIEF]: brief });
  return brief;
}

function createFeedbackItem(creator, action, context = {}) {
  const normalized = createKol(creator);
  return {
    id: normalized.id,
    platform: normalized.platform,
    handle: normalized.handle,
    profileUrl: normalized.profileUrl,
    name: normalized.name,
    action,
    scope: context.scope || "",
    source: context.source || "",
    briefText: context.briefText || "",
    country: context.country || "",
    minFollowers: context.minFollowers ?? null,
    tags: normalized.tags || [],
    score: normalized.score ?? normalized.match?.score ?? null,
    matchScore: normalized.match?.score ?? null,
    qualityScore: normalized.quality?.score ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function feedbackKey(item) {
  return `${item.action}:${item.platform || ""}:${item.id || item.handle || item.profileUrl || ""}`.toLowerCase();
}
