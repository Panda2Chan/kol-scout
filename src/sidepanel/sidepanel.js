import { downloadCsv } from "../shared/export.js";
import { createMatchBrief } from "../shared/schema.js";

const PANEL_STORAGE_KEY = "kolLite.sidePanel";
const DEFAULT_NOTICE = "输入筛选条件后点击找相似博主。结果先进入候选，手动保存后才进入已保存 list。";
const LOADING_STEPS = [
  "正在理解筛选需求，生成 KOL 搜索策略...",
  "正在检索真实创作者主页...",
  "正在读取公开主页简介、粉丝量、邮箱和头像...",
  "正在过滤假粉、低质量和低匹配账号...",
  "正在按匹配度整理候选列表..."
];

const state = {
  activeView: "candidates",
  briefText: "",
  minFollowers: 0,
  platform: "x",
  country: "",
  candidates: [],
  saved: [],
  summary: null,
  notice: DEFAULT_NOTICE,
  noticeType: "",
  busy: false,
  loadingTimer: null,
  loadingStartedAt: 0,
  loadingStep: 0
};

const elements = {
  searchPanel: document.querySelector("#searchPanel"),
  listPanel: document.querySelector("#listPanel"),
  matchBrief: document.querySelector("#matchBrief"),
  minFollowers: document.querySelector("#minFollowers"),
  platformSelect: document.querySelector("#platformSelect"),
  countrySelect: document.querySelector("#countrySelect"),
  discoverButton: document.querySelector("#discoverButton"),
  scanButton: document.querySelector("#scanButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  candidateTab: document.querySelector("#candidateTab"),
  savedTab: document.querySelector("#savedTab"),
  saveAllButton: document.querySelector("#saveAllButton"),
  clearButton: document.querySelector("#clearButton"),
  notice: document.querySelector("#notice"),
  progressPanel: document.querySelector("#progressPanel"),
  progressTitle: document.querySelector("#progressTitle"),
  progressMeta: document.querySelector("#progressMeta"),
  progressBar: document.querySelector("#progressBar"),
  progressSteps: document.querySelector("#progressSteps"),
  cardList: document.querySelector("#cardList"),
  template: document.querySelector("#cardTemplate")
};

elements.discoverButton.addEventListener("click", discoverCreators);
elements.scanButton.addEventListener("click", scanCurrentPage);
elements.exportCsvButton.addEventListener("click", () => downloadCsv("kol-lite.csv", state.saved));
elements.matchBrief.addEventListener("input", handleFormChange);
elements.minFollowers.addEventListener("input", handleFormChange);
elements.platformSelect.addEventListener("change", handleFormChange);
elements.countrySelect.addEventListener("change", handleFormChange);
elements.candidateTab.addEventListener("click", () => switchView("candidates"));
elements.savedTab.addEventListener("click", () => switchView("saved"));
elements.saveAllButton.addEventListener("click", () => saveCandidates(state.candidates));
elements.clearButton.addEventListener("click", clearCurrentView);
elements.cardList.addEventListener("click", handleCardClick);

await boot();

async function boot() {
  await loadState();
  await refreshSaved({ silent: true });
  render();
}

async function handleFormChange() {
  state.briefText = elements.matchBrief.value;
  state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
  state.platform = normalizePlatform(elements.platformSelect.value, state.briefText);
  state.country = elements.countrySelect.value;
  await persistState();
}

async function switchView(view) {
  state.activeView = view === "saved" ? "saved" : "candidates";
  if (state.activeView === "saved") await refreshSaved({ silent: true });
  await persistState();
  render();
}

async function discoverCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先输入关键词和筛选需求。", "error");
    render();
    return;
  }

  state.briefText = brief.rawText;
  state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
  state.platform = normalizePlatform(elements.platformSelect.value, brief.rawText);
  state.country = elements.countrySelect.value;
  state.activeView = "candidates";
  setBusy(true);
  startLoading();

  const response = await sendMessage({
    type: "DISCOVER_CREATORS",
    payload: {
      brief,
      platform: state.platform,
      limit: 20,
      filters: buildDiscoveryFilters()
    }
  });

  setBusy(false);
  stopLoading();

  if (!response?.ok) {
    setNotice(response?.error || "全站匹配失败，请确认本地后端已启动。", "error");
    await persistState();
    render();
    return;
  }

  state.candidates = response.candidates || [];
  state.summary = response.summary || null;

  const summary = response.summary || {};
  if (!state.candidates.length) {
    const reasonText = formatFilteredReasons(summary.filteredReasons);
    setNotice(
      `未得到候选：已召回 ${summary.totalFetched || 0} 个${reasonText ? `，过滤原因：${reasonText}` : ""}。`,
      "error"
    );
  } else {
    setNotice(
      `找到 ${state.candidates.length} 个候选，过滤 ${summary.filtered || 0} 个。确认需要后再手动保存。`,
      "success"
    );
  }

  await persistState();
  render();
}

async function scanCurrentPage() {
  state.activeView = "candidates";
  setBusy(true);
  setNotice("正在扫描当前页面...");

  const response = await sendMessage({ type: "SCAN_ACTIVE_TAB" });
  setBusy(false);

  if (!response?.ok) {
    setNotice(response?.error || "扫描失败，请确认当前页面允许插件访问。", "error");
    await persistState();
    render();
    return;
  }

  state.candidates = response.scan?.candidates || [];
  state.summary = { dataSource: "page-scan" };
  if (!state.candidates.length) {
    setNotice("当前页面未识别到可见 OP。", "error");
  } else {
    setNotice(`扫描完成，发现 ${state.candidates.length} 个候选。确认需要后再手动保存。`, "success");
  }

  await persistState();
  render();
}

async function handleCardClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const card = event.target.closest("[data-id]");
  const creator = card ? getVisibleCreators().find((item) => item.id === card.dataset.id) : null;
  if (!creator) return;

  if (button.dataset.action === "profile") await openCreatorProfile(creator);
  if (button.dataset.action === "contact") showContact(creator);
  if (button.dataset.action === "save") await saveCandidates([creator]);
  if (button.dataset.action === "removeSaved") await removeSavedCreator(creator);
}

async function saveCandidates(candidates) {
  if (!candidates.length) {
    setNotice("当前没有可保存的候选。", "error");
    render();
    return;
  }

  const response = await sendMessage({
    type: "SAVE_CANDIDATES",
    payload: { candidates }
  });

  if (!response?.ok) {
    setNotice(response?.error || "保存失败。", "error");
    render();
    return;
  }

  state.saved = response.kols || [];
  setNotice(`已保存 ${candidates.length} 个候选。`, "success");
  await persistState();
  render();
}

async function refreshSaved(options = {}) {
  const response = await sendMessage({ type: "GET_SAVED_KOLS" });
  if (!response?.ok) {
    if (!options.silent) setNotice(response?.error || "读取已保存 list 失败。", "error");
    return;
  }
  state.saved = response.kols || [];
}

async function removeSavedCreator(creator) {
  const response = await sendMessage({
    type: "REMOVE_SAVED_KOL",
    payload: { id: creator.id }
  });
  if (!response?.ok) {
    setNotice(response?.error || "删除失败。", "error");
    render();
    return;
  }

  state.saved = response.kols || [];
  setNotice("已从保存列表删除。", "success");
  await persistState();
  render();
}

async function clearCurrentView() {
  if (state.activeView === "saved") {
    await clearSavedCreators();
    return;
  }

  state.candidates = [];
  state.summary = null;
  setNotice("已清空候选列表，已保存 list 不受影响。", "success");
  await persistState();
  render();
}

async function clearSavedCreators() {
  if (!state.saved.length) {
    setNotice("已保存 list 为空。", "error");
    render();
    return;
  }

  if (!window.confirm("确认清空已保存 list？这个操作不可恢复。")) return;

  const response = await sendMessage({ type: "CLEAR_SAVED_KOLS" });
  if (!response?.ok) {
    setNotice(response?.error || "清空已保存 list 失败。", "error");
    render();
    return;
  }

  state.saved = [];
  setNotice("已清空保存列表。", "success");
  await persistState();
  render();
}

async function openCreatorProfile(creator) {
  if (!creator.profileUrl) {
    setNotice("这个 OP 缺少主页地址。", "error");
    render();
    return;
  }

  const response = await sendMessage({
    type: "OPEN_CREATOR_PROFILE",
    payload: { profileUrl: creator.profileUrl }
  });

  if (!response?.ok) {
    setNotice(response?.error || "主页跳转失败。", "error");
    render();
  }
}

function showContact(creator) {
  const email = findContactEmail(creator);
  if (!email) {
    setNotice(`${creator.name || creator.handle || "该 OP"} 暂未获取到公开邮箱。`, "error");
    render();
    return;
  }

  setNotice(`${creator.name || creator.handle} 的邮箱：${email}`, "success");
  render();
}

function render() {
  elements.matchBrief.value = state.briefText || "";
  elements.minFollowers.value = state.minFollowers || "";
  elements.platformSelect.value = state.platform || "x";
  elements.countrySelect.value = state.country || "";
  elements.discoverButton.disabled = state.busy;
  elements.scanButton.disabled = state.busy;

  elements.candidateTab.classList.toggle("active", state.activeView === "candidates");
  elements.savedTab.classList.toggle("active", state.activeView === "saved");
  elements.candidateTab.textContent = `候选 ${state.candidates.length}`;
  elements.savedTab.textContent = `已保存 ${state.saved.length}`;
  elements.saveAllButton.hidden = state.activeView !== "candidates";
  elements.saveAllButton.disabled = state.busy || !state.candidates.length;
  elements.clearButton.disabled = state.busy;
  elements.clearButton.textContent = state.activeView === "saved" ? "清空已保存" : "清空候选";
  elements.notice.textContent = state.notice || DEFAULT_NOTICE;
  elements.notice.className = ["notice", state.noticeType].filter(Boolean).join(" ");

  renderCards();
}

function renderCards() {
  elements.cardList.innerHTML = "";
  const creators = getVisibleCreators();
  if (!creators.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.activeView === "saved"
      ? "已保存 list 为空。候选 OP 需要手动保存后才会出现在这里。"
      : "暂无候选。输入筛选条件后全站匹配，或扫描当前页。";
    elements.cardList.appendChild(empty);
    return;
  }

  for (const creator of creators) {
    elements.cardList.appendChild(renderCard(creator));
  }
}

function renderCard(creator) {
  const fragment = elements.template.content.cloneNode(true);
  const card = fragment.querySelector(".creator-card");
  const avatar = fragment.querySelector(".avatar");
  const saveButton = fragment.querySelector('[data-action="save"]');

  card.dataset.id = creator.id || `${creator.platform}:${creator.handle || creator.profileUrl}`;
  avatar.textContent = getInitials(creator);
  if (creator.avatarUrl) {
    avatar.style.backgroundImage = `url("${creator.avatarUrl}")`;
    avatar.textContent = "";
  }

  fragment.querySelector(".name").textContent = creator.name || creator.handle || "Unknown creator";
  fragment.querySelector(".meta").textContent = buildMeta(creator);
  fragment.querySelector(".score").textContent = `${creator.score ?? creator.match?.score ?? 0} 分`;
  fragment.querySelector(".bio").textContent = buildBioText(creator);
  fragment.querySelector(".match-reasons").textContent = buildMatchReasonText(creator);

  const chips = fragment.querySelector(".chips");
  for (const text of buildChips(creator).slice(0, 5)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = text;
    chips.appendChild(chip);
  }

  if (state.activeView === "saved") {
    saveButton.dataset.action = "removeSaved";
    saveButton.textContent = "删除";
  }

  return fragment;
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

function startLoading() {
  stopLoading();
  renderProgressSteps();
  state.loadingStartedAt = Date.now();
  state.loadingStep = 0;
  elements.progressPanel.hidden = false;
  updateLoadingProgress();
  state.loadingTimer = window.setInterval(() => {
    updateLoadingProgress();
  }, 1_000);
}

function stopLoading() {
  if (state.loadingTimer) {
    window.clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }
  elements.progressPanel.hidden = true;
  state.loadingStartedAt = 0;
}

function updateLoadingProgress() {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.loadingStartedAt) / 1000));
  state.loadingStep = calculateLoadingStep(elapsedSeconds);
  const percent = Math.min(96, 8 + state.loadingStep * 18 + (elapsedSeconds % 12) * 1.5);
  const stepText = LOADING_STEPS[state.loadingStep];

  elements.progressTitle.textContent = stepText;
  elements.progressMeta.textContent = `第 ${state.loadingStep + 1}/${LOADING_STEPS.length} 步 · 已等待 ${elapsedSeconds} 秒`;
  elements.progressBar.style.width = `${percent}%`;
  setNotice(`${stepText} 请保持侧边栏打开，长任务会自动降级兜底。`);
  updateProgressStepStates();
}

function calculateLoadingStep(elapsedSeconds) {
  if (elapsedSeconds < 4) return 0;
  if (elapsedSeconds < 14) return 1;
  if (elapsedSeconds < 28) return 2;
  if (elapsedSeconds < 42) return 3;
  return 4;
}

function renderProgressSteps() {
  elements.progressSteps.innerHTML = "";
  for (const step of LOADING_STEPS) {
    const item = document.createElement("li");
    item.textContent = step.replace(/\.\.\.$/, "");
    elements.progressSteps.appendChild(item);
  }
}

function updateProgressStepStates() {
  [...elements.progressSteps.children].forEach((item, index) => {
    item.classList.toggle("done", index < state.loadingStep);
    item.classList.toggle("active", index === state.loadingStep);
  });
}

function setNotice(text, type = "") {
  state.notice = text || DEFAULT_NOTICE;
  state.noticeType = type;
  elements.notice.textContent = state.notice;
  elements.notice.className = ["notice", type].filter(Boolean).join(" ");
}

async function loadState() {
  const data = await chrome.storage.local.get(PANEL_STORAGE_KEY);
  const saved = data[PANEL_STORAGE_KEY] || {};
  state.activeView = saved.activeView === "saved" ? "saved" : "candidates";
  state.briefText = saved.briefText || "";
  state.minFollowers = saved.minFollowers ?? 0;
  state.platform = normalizePlatform(saved.platform || "x", state.briefText);
  state.country = saved.country || "";
  state.candidates = Array.isArray(saved.candidates) ? saved.candidates : [];
  state.summary = saved.summary || null;
  state.notice = saved.notice || DEFAULT_NOTICE;
  state.noticeType = saved.noticeType || "";
}

async function persistState() {
  await chrome.storage.local.set({
    [PANEL_STORAGE_KEY]: {
      activeView: state.activeView,
      briefText: state.briefText,
      minFollowers: state.minFollowers,
      platform: state.platform,
      country: state.country,
      candidates: state.candidates,
      summary: state.summary,
      notice: state.notice,
      noticeType: state.noticeType,
      updatedAt: Date.now()
    }
  });
}

function buildDiscoveryFilters() {
  return {
    minMatchScore: 50,
    minQualityScore: 55,
    minFollowers: Math.max(0, Number(elements.minFollowers.value || 0) || 0),
    country: elements.countrySelect.value || "",
    maxFakeFollowerRisk: "medium"
  };
}

function getVisibleCreators() {
  return state.activeView === "saved" ? state.saved : state.candidates;
}

function buildMeta(creator) {
  const platform = platformLabel(creator.platform);
  const followers = creator.metrics?.followers ? `${formatNumber(creator.metrics.followers)} 粉丝` : "粉丝未知";
  const email = findContactEmail(creator) ? "有邮箱" : "邮箱未知";
  return [platform, creator.handle, followers, email, riskLabel(creator.quality?.fakeFollowerRisk)].filter(Boolean).join(" · ");
}

function buildBioText(creator) {
  const bio = cleanProfileBio(creator.bio);
  return bio ? `简介：${bio}` : "简介：暂无公开简介";
}

function cleanProfileBio(text) {
  const bio = String(text || "").trim();
  if (!bio || isBoilerplateProfileText(bio)) return "";
  return bio;
}

function buildMatchReasonText(creator) {
  const reasons = Array.isArray(creator.match?.reasons) ? creator.match.reasons.filter(Boolean) : [];
  const matchedKeywords = Array.isArray(creator.match?.matchedKeywords)
    ? creator.match.matchedKeywords.filter(Boolean)
    : [];
  const concerns = Array.isArray(creator.match?.concerns) ? creator.match.concerns.filter(Boolean) : [];
  const parts = [];

  if (reasons.length) {
    parts.push(reasons.slice(0, 3).join("；"));
  } else if (matchedKeywords.length) {
    parts.push(`命中关键词：${matchedKeywords.slice(0, 5).join("、")}`);
  }

  if (concerns.length) {
    parts.push(`注意：${concerns.slice(0, 2).join("；")}`);
  }

  return parts.length ? `匹配理由：${parts.join(" · ")}` : "匹配理由：暂无明确理由";
}

function isBoilerplateProfileText(text) {
  return /Browse your favorite items/i.test(text)
    || /TikTok Shop is now available/i.test(text)
    || /Visit TikTok to discover more trending creators/i.test(text)
    || /Skip to content|For You|Following|LIVE|Log in to follow creators/i.test(text);
}

function buildChips(creator) {
  return [
    creator.match?.score != null ? `关联度 ${creator.match.score}` : "",
    creator.quality?.score ? `质量 ${creator.quality.score}` : "",
    ...(creator.tags || [])
  ].filter(Boolean);
}

function findContactEmail(creator) {
  return creator.contact?.email || extractEmail(`${creator.bio || ""} ${creator.discovery?.evidenceText || ""}`);
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

function formatNumber(value) {
  const number = Number(value || 0);
  if (!number) return "";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

function formatFilteredReasons(reasons = {}) {
  return Object.entries(reasons)
    .map(([reason, count]) => `${reason} ${count}`)
    .join("，");
}

function riskLabel(risk = "") {
  const map = { low: "低风险", medium: "中风险", high: "高风险" };
  return map[risk] || "";
}

function normalizePlatform(value, briefText = "") {
  const explicit = String(value || "").toLowerCase();
  if (explicit === "tiktok" || explicit === "x") return explicit;

  const lower = String(briefText || "").toLowerCase();
  if (/tiktok|tik tok|抖音|短视频|带货视频/.test(lower)) return "tiktok";
  return "x";
}

function platformLabel(platform) {
  return {
    x: "X",
    tiktok: "TikTok"
  }[platform] || platform || "";
}

function getInitials(creator) {
  const raw = creator.handle || creator.name || "K";
  return String(raw).replace(/^@/, "").slice(0, 2).toUpperCase();
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}
