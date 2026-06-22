import { STORAGE_KEYS, createKol } from "./schema.js";

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
