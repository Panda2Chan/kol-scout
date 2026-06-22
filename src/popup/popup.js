import { downloadCsv, downloadJson } from "../shared/export.js";
import { PLATFORM_LABELS, createKol, createMatchBrief } from "../shared/schema.js";
import {
  getMatchBrief,
  getKols,
  removeKol,
  setMatchBrief,
  updateKol,
  upsertKols
} from "../shared/storage.js";

const state = {
  candidates: [],
  saved: [],
  loadingTimer: null,
  loadingStep: 0
};

const DISCOVERY_LOADING_STEPS = [
  "正在理解你的筛选需求，生成 KOL 搜索策略...",
  "正在调用 AI Web Search 全站检索真实 X OP...",
  "正在读取公开简介、粉丝量和邮箱...",
  "正在过滤品牌号、低质号和低匹配账号...",
  "正在按匹配度整理候选列表..."
];

const elements = {
  scanButton: document.querySelector("#scanButton"),
  saveAllButton: document.querySelector("#saveAllButton"),
  matchButton: document.querySelector("#matchButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  exportJsonButton: document.querySelector("#exportJsonButton"),
  matchBrief: document.querySelector("#matchBrief"),
  minFollowers: document.querySelector("#minFollowers"),
  savedCount: document.querySelector("#savedCount"),
  candidateCount: document.querySelector("#candidateCount"),
  avgScore: document.querySelector("#avgScore"),
  notice: document.querySelector("#notice"),
  candidateList: document.querySelector("#candidateList"),
  savedList: document.querySelector("#savedList"),
  template: document.querySelector("#kolCardTemplate")
};

elements.scanButton.addEventListener("click", scanCurrentPage);
elements.matchButton.addEventListener("click", discoverCreators);
elements.saveAllButton.addEventListener("click", saveAllCandidates);
elements.exportCsvButton.addEventListener("click", () => downloadCsv("kol-lite.csv", state.saved));
elements.exportJsonButton?.addEventListener("click", () => {
  downloadJson(`kol-lite-${new Date().toISOString().slice(0, 10)}.json`, state.saved);
});

await hydrateBrief();
await refreshSaved();

async function scanCurrentPage() {
  setNotice("正在扫描当前页面...");
  setBusy(true);

  const response = await chrome.runtime.sendMessage({ type: "SCAN_ACTIVE_TAB" });
  setBusy(false);

  if (!response?.ok) {
    setNotice(response?.error || "扫描失败，请确认当前页面允许插件访问。", "error");
    return;
  }

  state.candidates = response.scan.candidates.map(createKol);
  render();
  if (!state.candidates.length) {
    setNotice(`当前页面未识别到可见创作者：${response.scan.pageUrl}`, "error");
    return;
  }

  setNotice(`扫描完成，发现 ${state.candidates.length} 个候选。`, "success");
}

async function matchCandidates() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先输入理想创作者 Brief，再进行智能匹配。", "error");
    return;
  }

  const target = state.candidates.length ? state.candidates : state.saved;
  if (!target.length) {
    setNotice("当前没有可匹配的候选或已保存线索。", "error");
    return;
  }

  await setMatchBrief(brief);
  setNotice("正在进行 AI 智能匹配...");
  const response = await chrome.runtime.sendMessage({
    type: "MATCH_CANDIDATES",
    payload: { brief, candidates: target }
  });

  if (!response?.ok) {
    setNotice(response?.error || "匹配失败，请确认后端已启动。", "error");
    return;
  }

  if (state.candidates.length) {
    state.candidates = response.candidates.map(createKol);
  } else {
    state.saved = response.candidates.map(createKol);
  }
  render();
  setNotice("智能匹配完成，已按匹配分排序。", "success");
}

async function searchCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先输入理想创作者 Brief，再进行 X 全站搜索。", "error");
    return;
  }

  await setMatchBrief(brief);
  setBusy(true, "搜索中");
  setNotice("正在生成 X 全站搜索并跳转...");

  const response = await chrome.runtime.sendMessage({
    type: "SEARCH_CREATORS",
    payload: { brief }
  });

  setBusy(false);

  if (!response?.ok) {
    setNotice(response?.error || "全站搜索失败，请确认后端已启动。", "error");
    return;
  }

  const terms = response.plan?.positiveTerms?.slice(0, 4).join(" / ") || response.plan?.query || "关键词";
  setNotice(`已跳转 X 用户搜索：${terms}。`, "success");
}

async function discoverCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先输入关键词和筛选需求，再进行全站匹配。", "error");
    return;
  }

  await setMatchBrief(brief);
  setBusy(true, "匹配中");
  startDiscoveryLoading();

  const response = await chrome.runtime.sendMessage({
    type: "DISCOVER_CREATORS",
    payload: {
      brief,
      platform: "x",
      limit: 20,
      filters: buildDiscoveryFilters()
    }
  });

  setBusy(false);
  stopDiscoveryLoading();

  if (!response?.ok) {
    setNotice(response?.error || "全站匹配失败，请确认后端或三方数据源已启动。", "error");
    return;
  }

  state.candidates = (response.candidates || []).map(createKol);
  if (state.candidates.length) {
    state.saved = await upsertKols(state.candidates);
  }

  render();
  const summary = response.summary || {};
  const aiStatus = summary.aiSearch?.enabled
    ? `AI ${summary.aiSearch.cached ? "缓存" : "规划"}已启用`
    : "规则兜底";
  if (!state.candidates.length) {
    const reasonText = formatFilteredReasons(summary.filteredReasons);
    const sourceText = summary.totalFetched
      ? `已召回 ${summary.totalFetched} 个，但全部被过滤${reasonText ? `：${reasonText}` : ""}`
      : "真实数据源没有召回账号";
    setNotice(`全站匹配未得到候选：${aiStatus}，${sourceText}。请放宽关键词或筛选条件。`, "error");
    return;
  }

  setNotice(
    `全站匹配完成：${aiStatus}，保留 ${state.candidates.length} 个，过滤 ${summary.filtered || 0} 个低质/低匹配账号。`,
    "success"
  );
}

function formatFilteredReasons(reasons = {}) {
  return Object.entries(reasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join("，");
}

function buildDiscoveryFilters() {
  return {
    minMatchScore: 50,
    minQualityScore: 55,
    minFollowers: Math.max(0, Number(elements.minFollowers?.value || 0) || 0),
    maxFakeFollowerRisk: "medium"
  };
}

function startDiscoveryLoading() {
  stopDiscoveryLoading();
  state.loadingStep = 0;
  setNotice(DISCOVERY_LOADING_STEPS[state.loadingStep]);
  state.loadingTimer = setInterval(() => {
    state.loadingStep = Math.min(state.loadingStep + 1, DISCOVERY_LOADING_STEPS.length - 1);
    const suffix = state.loadingStep >= 1 ? "AI 搜索通常需要 1-3 分钟，请保持弹窗打开。" : "";
    setNotice([DISCOVERY_LOADING_STEPS[state.loadingStep], suffix].filter(Boolean).join(" "));
  }, 12_000);
}

function stopDiscoveryLoading() {
  if (!state.loadingTimer) return;
  clearInterval(state.loadingTimer);
  state.loadingTimer = null;
}

async function saveAllCandidates() {
  if (!state.candidates.length) {
    setNotice("当前没有可保存的候选。", "error");
    return;
  }

  state.saved = await upsertKols(state.candidates);
  render();
  setNotice(`已保存 ${state.candidates.length} 个候选。`, "success");
}

async function refreshSaved() {
  state.saved = await getKols();
  render();
}

async function hydrateBrief() {
  const brief = await getMatchBrief();
  if (brief?.rawText) elements.matchBrief.value = brief.rawText;
}

function render() {
  elements.savedCount.textContent = state.saved.length;
  elements.candidateCount.textContent = state.candidates.length;
  elements.avgScore.textContent = averageScore(state.saved);

  renderList(elements.candidateList, state.candidates, { mode: "candidate" });
  renderList(elements.savedList, state.saved, { mode: "saved" });
}

function renderList(container, kols, options) {
  container.innerHTML = "";
  container.classList.toggle("empty", !kols.length);

  if (!kols.length) {
    container.textContent = options.mode === "candidate" ? "暂无候选" : "暂无保存线索";
    return;
  }

  for (const kol of kols) {
    container.appendChild(renderCard(kol, options));
  }
}

function renderCard(kol, options) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".kol-card");
  const avatar = fragment.querySelector(".avatar");
  const statusSelect = fragment.querySelector(".status-select");
  const tagInput = fragment.querySelector(".tag-input");
  const notesInput = fragment.querySelector(".notes-input");
  const saveButton = fragment.querySelector(".save-one");
  const deleteButton = fragment.querySelector(".delete-one");
  const contactButton = fragment.querySelector(".contact-one");
  const profileLink = fragment.querySelector(".profile-link");

  fragment.querySelector(".kol-name").textContent = kol.name || kol.handle || "Unknown creator";
  fragment.querySelector(".score").textContent = `${kol.score || 0} 分`;
  fragment.querySelector(".meta").textContent = buildMeta(kol);
  fragment.querySelector(".discovery").textContent = buildDiscovery(kol);
  fragment.querySelector(".match").textContent = buildMatch(kol);
  fragment.querySelector(".bio").textContent = buildBioText(kol);
  profileLink.href = kol.profileUrl || "#";
  profileLink.textContent = kol.profileUrl ? "跳转主页" : "";
  profileLink.hidden = !kol.profileUrl;
  profileLink.addEventListener("click", async (event) => {
    event.preventDefault();
    await openCreatorProfile(kol.profileUrl);
  });

  if (kol.avatarUrl) avatar.style.backgroundImage = `url("${kol.avatarUrl}")`;
  contactButton.addEventListener("click", () => showContact(kol));

  statusSelect.value = kol.status || "saved";
  tagInput.value = (kol.tags || []).join(", ");
  notesInput.value = kol.notes || "";

  if (options.mode === "candidate") {
    deleteButton.remove();
    saveButton.addEventListener("click", async () => {
      const edited = readCardEdits(kol, card);
      state.saved = await upsertKols([edited]);
      render();
      setNotice("已保存当前候选。", "success");
    });
  } else {
    saveButton.textContent = "更新";
    saveButton.addEventListener("click", async () => {
      await updateKol(kol.id, readCardEdits(kol, card));
      await refreshSaved();
      setNotice("线索已更新。", "success");
    });

    deleteButton.addEventListener("click", async () => {
      state.saved = await removeKol(kol.id);
      render();
      setNotice("线索已删除。", "success");
    });
  }

  return fragment;
}

async function openCreatorProfile(profileUrl) {
  if (!profileUrl) {
    setNotice("这个候选缺少主页地址。", "error");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "OPEN_CREATOR_PROFILE",
    payload: { profileUrl }
  });

  if (!response?.ok) {
    setNotice(response?.error || "主页跳转失败。", "error");
    return;
  }

  setNotice("已跳转到创作者主页。", "success");
}

function showContact(kol) {
  const email = findContactEmail(kol);
  if (!email) {
    setNotice(`${kol.name || kol.handle || "该 OP"} 暂未获取到公开邮箱。`, "error");
    return;
  }

  setNotice(`${kol.name || kol.handle} 的邮箱：${email}`, "success");
}

function readCardEdits(kol, card) {
  return {
    ...kol,
    status: card.querySelector(".status-select").value,
    tags: card
      .querySelector(".tag-input")
      .value.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    notes: card.querySelector(".notes-input").value.trim()
  };
}

function buildMeta(kol) {
  const platform = PLATFORM_LABELS[kol.platform] || kol.platform || "Unknown";
  const followers = kol.metrics?.followers ? `${formatNumber(kol.metrics.followers)} 粉丝` : "粉丝未知";
  const email = findContactEmail(kol) ? "有邮箱" : "邮箱未知";
  return [platform, kol.handle, followers, email].filter(Boolean).join(" · ");
}

function buildBioText(kol) {
  if (kol.bio) return kol.bio;
  const evidence = kol.discovery?.evidenceText || "";
  if (evidence) return evidence.slice(0, 220);
  return "简介未知";
}

function findContactEmail(kol) {
  return kol.contact?.email || extractEmail(`${kol.bio || ""} ${kol.discovery?.evidenceText || ""}`);
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at\]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

function buildDiscovery(kol) {
  const kindMap = {
    profile: "当前主页",
    "x-post-author": "X 帖子作者",
    "x-visible-profile": "X 可见用户",
    "page-link": "页面链接",
    website: "网页作者",
    manual: "手动线索"
  };
  const kind = kindMap[kol.discovery?.kind] || "页面发现";
  const status = kol.enrichment?.status === "ready" || kol.enrichment?.status === "enriched" ? "资料可用" : "资料有限";
  return [kind, status, kol.discovery?.summary].filter(Boolean).join(" · ");
}

function buildMatch(kol) {
  if (kol.match?.score == null) return "";

  const levelMap = {
    high: "高匹配",
    medium: "中匹配",
    low: "低匹配"
  };
  const reasons = (kol.match.reasons || []).slice(0, 2).join("；");
  const quality = kol.quality?.score ? `质量 ${kol.quality.score}` : "";
  const fakeRisk = kol.quality?.fakeFollowerRisk ? `假粉风险 ${riskLabel(kol.quality.fakeFollowerRisk)}` : "";
  return [`匹配 ${kol.match.score}`, quality, fakeRisk, levelMap[kol.match.level] || "", reasons]
    .filter(Boolean)
    .join(" · ");
}

function averageScore(kols) {
  if (!kols.length) return 0;
  return Math.round(kols.reduce((sum, kol) => sum + (kol.score || 0), 0) / kols.length);
}

function formatNumber(value) {
  return Intl.NumberFormat("en", { notation: "compact" }).format(value);
}

function setNotice(text, type = "") {
  elements.notice.textContent = text;
  elements.notice.className = `notice ${type}`.trim();
}

function setBusy(isBusy, label = "扫描中") {
  elements.scanButton.disabled = isBusy;
  elements.matchButton.disabled = isBusy;
  elements.scanButton.textContent = isBusy && label === "扫描中" ? label : "扫描";
  elements.matchButton.textContent = isBusy && label !== "扫描中" ? label : "全站匹配";
}

function riskLabel(value) {
  return {
    low: "低",
    medium: "中",
    high: "高"
  }[value] || value;
}
