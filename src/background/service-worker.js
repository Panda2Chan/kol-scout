import {
  clearKols,
  getDiscoveryFeedback,
  getKols,
  recordDiscoveryFeedback,
  removeKol,
  setLastScan,
  upsertKols
} from "../shared/storage.js";
import { buildBackendHeaders, getBackendApiBaseUrl } from "../shared/backend-config.js";
import { formatBackendErrorMessage } from "../shared/backend-errors.js";

const API_BASE_URL = getBackendApiBaseUrl();
const DEFAULT_MIN_FOLLOWERS = 10_000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: "#276ef1" });
  enableSidePanelAction();
});

chrome.runtime.onStartup?.addListener?.(enableSidePanelAction);
enableSidePanelAction();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN_ACTIVE_TAB") {
    scanActiveTab()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SAVE_CANDIDATES") {
    saveCandidates(message.payload?.candidates || [], message.payload?.context || {})
      .then((kols) => sendResponse({ ok: true, kols }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "GET_SAVED_KOLS") {
    getKols()
      .then((kols) => sendResponse({ ok: true, kols }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CLEAR_SAVED_KOLS") {
    clearSavedKols(message.payload?.context || {})
      .then(() => sendResponse({ ok: true, kols: [] }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "REMOVE_SAVED_KOL") {
    removeSavedKol(message.payload?.id || "", message.payload?.creator || null, message.payload?.context || {})
      .then((kols) => sendResponse({ ok: true, kols }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "RECORD_DISCOVERY_FEEDBACK") {
    recordDiscoveryFeedback(
      message.payload?.creators || [],
      message.payload?.action || "",
      message.payload?.context || {}
    )
      .then((feedback) => sendResponse({ ok: true, feedback }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "MATCH_CANDIDATES") {
    matchCandidates(message.payload?.brief || {}, message.payload?.candidates || [])
      .then((candidates) => sendResponse({ ok: true, candidates }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "SEARCH_CREATORS") {
    searchCreators(message.payload?.brief || {}, message.payload || {})
      .then((plan) => sendResponse({ ok: true, plan }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "DISCOVER_CREATORS") {
    discoverCreators(message.payload?.brief || {}, message.payload || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "OPEN_CREATOR_PROFILE") {
    openCreatorProfile(message.payload?.profileUrl || "")
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

function enableSidePanelAction() {
  const pending = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  pending?.catch?.(() => {});
}

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("没有找到当前活动页面");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content/detector.js"]
  });

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => window.__KOL_LITE_DETECTOR__.scan()
  });

  const scan = {
    pageUrl: tab.url || "",
    pageTitle: tab.title || "",
    capturedAt: Date.now(),
    candidates: result?.result || []
  };

  await setLastScan(scan);
  await chrome.action.setBadgeText({ text: String(scan.candidates.length) });
  return { ok: true, scan };
}

async function matchCandidates(brief, candidates) {
  const response = await postJson("/api/match/creators", { brief, creators: candidates, locale: "zh-CN" });
  const byId = new Map((response.results || []).map((result) => [result.creatorId, result.match]));
  return candidates
    .map((candidate) => ({
      ...candidate,
      match: byId.get(candidate.id) || candidate.match
    }))
    .sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1));
}

async function searchCreators(brief, options = {}) {
  const platform = normalizePlatform(options.platform || brief.platforms?.[0] || "tiktok");
  const response = await postJson("/api/search/creators", { brief, platform, locale: "zh-CN" });
  const plan = response.plan;
  if (!plan?.searchUrl) {
    throw new Error("后端没有返回可跳转的搜索地址");
  }

  await navigateActiveTab(plan.searchUrl);
  return plan;
}

async function discoverCreators(brief, options = {}) {
  const platform = normalizePlatform(options.platform || brief.platforms?.[0] || "tiktok");
  const feedback = await getDiscoveryFeedback({ platform });
  return postJson("/api/discover/creators", {
    brief,
    platform,
    limit: options.limit || 20,
    filters: options.filters || {
      minMatchScore: 50,
      minQualityScore: 55,
      minFollowers: DEFAULT_MIN_FOLLOWERS,
      maxFakeFollowerRisk: "medium"
    },
    feedback,
    locale: "zh-CN"
  });
}

async function saveCandidates(candidates, context = {}) {
  const kols = await upsertKols(candidates);
  await recordDiscoveryFeedback(candidates, "saved", {
    ...context,
    source: context.source || "background",
    scope: context.scope || "candidate"
  }).catch(() => null);
  return kols;
}

async function removeSavedKol(id, creator, context = {}) {
  const kols = await getKols();
  const target = creator || kols.find((kol) => kol.id === id);
  if (target) {
    await recordDiscoveryFeedback(target, "removed", {
      ...context,
      source: context.source || "background",
      scope: context.scope || "saved"
    }).catch(() => null);
  }
  return removeKol(id);
}

async function clearSavedKols(context = {}) {
  const kols = await getKols();
  if (kols.length) {
    await recordDiscoveryFeedback(kols, "removed", {
      ...context,
      source: context.source || "background",
      scope: context.scope || "saved"
    }).catch(() => null);
  }
  return clearKols();
}

async function openCreatorProfile(profileUrl) {
  if (!profileUrl) {
    throw new Error("缺少创作者主页地址");
  }

  const url = new URL(profileUrl);
  if (!isAllowedCreatorProfileHost(url.hostname)) {
    throw new Error("当前仅支持跳转 X、TikTok 或 YouTube 创作者主页");
  }

  return navigateActiveTab(url.toString());
}

function isAllowedCreatorProfileHost(hostname) {
  const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
  return ["x.com", "twitter.com", "tiktok.com", "m.tiktok.com", "vm.tiktok.com", "youtube.com", "m.youtube.com"].includes(host);
}

function normalizePlatform(platform) {
  const normalized = String(platform || "tiktok").toLowerCase().replace(/\s+/g, "");
  if (normalized === "twitter") return "x";
  if (normalized === "tiktok" || normalized === "douyin" || normalized === "抖音") return "tiktok";
  return normalized || "tiktok";
}

async function navigateActiveTab(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("没有找到当前活动页面");
  }

  return chrome.tabs.update(tab.id, { url });
}

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: buildBackendHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(formatBackendErrorMessage(data, `后端请求失败：${response.status}`));
  }

  return data;
}
