import { downloadCsv } from "../shared/export.js";
import { discoverCreatorsStreamFromBackend } from "../shared/backend-api.js";
import { createKol, createMatchBrief } from "../shared/schema.js";
import { getDiscoveryFeedback } from "../shared/storage.js";

const PANEL_STORAGE_KEY = "kolLite.sidePanel";
const THEME_STORAGE_KEY = "kolLite.theme";
const DEFAULT_NOTICE = "写一句你要找的人群。结果会先放进候选，确认后再保存。";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色"
};
const THEME_ICONS = {
  system: "◐",
  light: "☀",
  dark: "☾"
};
const LOADING_STEPS = [
  "整理搜索条件...",
  "查找公开创作者资料...",
  "补全头像、简介、粉丝量和邮箱...",
  "剔除资料不足和低匹配账号...",
  "按匹配度整理候选..."
];

const state = {
  activeView: "candidates",
  briefText: "",
  minFollowers: 0,
  platform: "x",
  country: "",
  theme: "system",
  candidates: [],
  saved: [],
  summary: null,
  notice: DEFAULT_NOTICE,
  noticeType: "",
  busy: false,
  busyLabel: "",
  loadingTimer: null,
  loadingStartedAt: 0,
  loadingStep: 0,
  itemNotices: {},
  transientCreators: {},
  review: {
    active: false,
    currentId: ""
  },
  activeContactCreator: null
};

const elements = {
  searchPanel: document.querySelector("#searchPanel"),
  listPanel: document.querySelector("#listPanel"),
  matchBrief: document.querySelector("#matchBrief"),
  minFollowers: document.querySelector("#minFollowers"),
  platformSelect: document.querySelector("#platformSelect"),
  countrySelect: document.querySelector("#countrySelect"),
  themeButton: document.querySelector("#themeButton"),
  themeIcon: document.querySelector("#themeIcon"),
  discoverButton: document.querySelector("#discoverButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  candidateTab: document.querySelector("#candidateTab"),
  savedTab: document.querySelector("#savedTab"),
  saveAllButton: document.querySelector("#saveAllButton"),
  startReviewButton: document.querySelector("#startReviewButton"),
  clearButton: document.querySelector("#clearButton"),
  notice: document.querySelector("#notice"),
  reviewPanel: document.querySelector("#reviewPanel"),
  reviewMeta: document.querySelector("#reviewMeta"),
  reviewLikeButton: document.querySelector("#reviewLikeButton"),
  reviewNoButton: document.querySelector("#reviewNoButton"),
  progressPanel: document.querySelector("#progressPanel"),
  progressTitle: document.querySelector("#progressTitle"),
  progressMeta: document.querySelector("#progressMeta"),
  progressBar: document.querySelector("#progressBar"),
  progressSteps: document.querySelector("#progressSteps"),
  cardList: document.querySelector("#cardList"),
  template: document.querySelector("#cardTemplate"),
  contactDialog: document.querySelector("#contactDialog"),
  contactDialogTitle: document.querySelector("#contactDialogTitle"),
  contactDialogSubtitle: document.querySelector("#contactDialogSubtitle"),
  contactDialogBody: document.querySelector("#contactDialogBody")
};

elements.discoverButton.addEventListener("click", discoverCreators);
elements.exportCsvButton.addEventListener("click", exportSavedCsv);
elements.matchBrief.addEventListener("input", handleFormChange);
elements.minFollowers.addEventListener("input", handleFormChange);
elements.platformSelect.addEventListener("change", handleFormChange);
elements.countrySelect.addEventListener("change", handleFormChange);
elements.themeButton.addEventListener("click", handleThemeToggle);
elements.candidateTab.addEventListener("click", () => switchView("candidates"));
elements.savedTab.addEventListener("click", () => switchView("saved"));
elements.saveAllButton.addEventListener("click", () => saveCandidates(state.candidates));
elements.startReviewButton.addEventListener("click", toggleReviewMode);
elements.reviewLikeButton.addEventListener("click", reviewLikeCurrent);
elements.reviewNoButton.addEventListener("click", reviewNoCurrent);
elements.clearButton.addEventListener("click", clearCurrentView);
elements.cardList.addEventListener("click", handleCardClick);
elements.contactDialog.addEventListener("click", handleContactDialogClick);
document.addEventListener("keydown", handleDocumentKeydown);

await boot();

async function boot() {
  await loadTheme();
  await loadState();
  await refreshSaved({ silent: true });
  render();
}

async function loadTheme() {
  const data = await chrome.storage.local.get(THEME_STORAGE_KEY);
  state.theme = normalizeTheme(data[THEME_STORAGE_KEY]);
  applyTheme(state.theme);
}

async function handleThemeToggle() {
  state.theme = getNextTheme(state.theme);
  applyTheme(state.theme);
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: state.theme });
  render();
}

function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized === "system" ? "light dark" : normalized;
}

function normalizeTheme(value) {
  return ["light", "dark", "system"].includes(value) ? value : "system";
}

function getNextTheme(value) {
  const current = normalizeTheme(value);
  const index = THEME_ORDER.indexOf(current);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

function renderThemeControl() {
  const theme = normalizeTheme(state.theme);
  const label = THEME_LABELS[theme];
  elements.themeIcon.textContent = THEME_ICONS[theme];
  elements.themeButton.dataset.theme = theme;
  elements.themeButton.title = `主题：${label}`;
  elements.themeButton.setAttribute("aria-label", `切换主题，当前${label}`);
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
  if (state.activeView !== "candidates") resetReviewState();
  if (state.activeView === "saved") await refreshSaved({ silent: true });
  await persistState();
  render();
}

async function discoverCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先写一下你要找哪类创作者。", "error");
    render();
    return;
  }

  state.briefText = brief.rawText;
  state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
  state.platform = normalizePlatform(elements.platformSelect.value, brief.rawText);
  state.country = elements.countrySelect.value;
  state.activeView = "candidates";
  setBusy(true, "discover");
  state.candidates = [];
  state.summary = null;
  state.itemNotices = {};
  state.transientCreators = {};
  resetReviewState();
  startLoading();
  render();

  let response;
  try {
    const feedback = await getDiscoveryFeedback({ platform: state.platform });
    response = await discoverCreatorsStreamFromBackend({
      brief,
      platform: state.platform,
      limit: 20,
      filters: buildDiscoveryFilters(),
      feedback
    }, {
      onEvent: handleDiscoveryStreamEvent
    });
  } catch (error) {
    const retainedText = state.candidates.length ? `已保留 ${state.candidates.length} 个已返回候选。` : "";
    setNotice(`${error.message || "没有完成匹配，检查后端服务后再试。"}${retainedText}`, "error");
    await persistState();
    render();
    return;
  } finally {
    setBusy(false);
    stopLoading();
  }

  if (!response?.ok) {
    setNotice(response?.error || "没有完成匹配，检查后端服务后再试。", "error");
    await persistState();
    render();
    return;
  }

  state.candidates = (response.candidates || []).filter((candidate) => !isSavedCreator(candidate));
  state.summary = response.summary || null;

  const summary = response.summary || {};
  if (!state.candidates.length) {
    const reasonText = formatFilteredReasons(summary.filteredReasons);
    setNotice(
      `这次没有合适候选：已看过 ${summary.totalFetched || 0} 个${reasonText ? `，主要原因：${reasonText}` : ""}。`,
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

function handleDiscoveryStreamEvent(event) {
  if (event.event !== "candidate" || !event.candidate) return;

  const candidate = createKol(event.candidate);
  candidate._streamedAt = Date.now();
  mergeStreamingCandidate(candidate);
  render();

  const progress = event.progress || {};
  const progressText = progress.total
    ? `（已补全 ${progress.completed || 0}/${progress.total}，已展示 ${progress.shown || state.candidates.length}）`
    : "";
  setNotice(`已展示 ${state.candidates.length} 个通过资料校验的候选${progressText}，仍在继续补全...`);
}

function mergeStreamingCandidate(candidate) {
  if (isSavedCreator(candidate)) return;

  const key = getCandidateKey(candidate);
  const index = state.candidates.findIndex((item) => getCandidateKey(item) === key);
  if (index >= 0) {
    state.candidates[index] = {
      ...state.candidates[index],
      ...candidate
    };
    sortCandidatesByScore(state.candidates);
    return;
  }

  state.candidates.push(candidate);
  sortCandidatesByScore(state.candidates);
}

function getCandidateKey(candidate) {
  return (candidate.id || `${candidate.platform || ""}:${candidate.handle || candidate.profileUrl || ""}`).toLowerCase();
}

function sortCandidatesByScore(candidates) {
  candidates.sort((left, right) => {
    const scoreDiff = getCreatorScore(right) - getCreatorScore(left);
    if (scoreDiff) return scoreDiff;
    const followerDiff = Number(right.metrics?.followers || 0) - Number(left.metrics?.followers || 0);
    if (followerDiff) return followerDiff;
    return String(left.handle || left.name || "").localeCompare(String(right.handle || right.name || ""));
  });
}

function getCreatorScore(creator) {
  return Number(creator.score ?? creator.match?.score ?? 0);
}

async function handleCardClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;

  const card = event.target.closest("[data-id]");
  const creator = card ? getRenderableCreators().find((item) => getCreatorCardId(item) === card.dataset.id) : null;
  if (!creator) return;

  if (button.dataset.action === "profile") await openCreatorProfile(creator, button);
  if (button.dataset.action === "contact") showContact(creator);
  if (button.dataset.action === "save") await saveCandidates([creator], { sourceCreator: creator });
  if (button.dataset.action === "ignore") await ignoreCandidate(creator);
  if (button.dataset.action === "removeSaved") await removeSavedCreator(creator);
}

async function saveCandidates(candidates, options = {}) {
  const sourceCreator = options.sourceCreator || (candidates.length === 1 ? candidates[0] : null);
  if (!candidates.length) {
    setNotice("当前没有可保存的候选。", "error");
    render();
    return;
  }

  const response = await sendMessage({
    type: "SAVE_CANDIDATES",
    payload: {
      candidates,
      context: buildFeedbackContext("candidate")
    }
  });

  if (!response?.ok) {
    showActionFeedback(sourceCreator, response?.error || "保存失败。", "error");
    return;
  }

  const savedCount = candidates.length;
  removeCandidatesFromQueue(candidates);
  state.saved = response.kols || [];
  if (sourceCreator) {
    setNotice("已保存到已保存 list。", "success");
  } else {
    setNotice(`已保存 ${savedCount} 个候选。`, "success");
  }
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
  removeCandidatesFromQueue(state.saved);
}

async function removeSavedCreator(creator) {
  const response = await sendMessage({
    type: "REMOVE_SAVED_KOL",
    payload: {
      id: creator.id,
      creator,
      context: buildFeedbackContext("saved")
    }
  });
  if (!response?.ok) {
    setItemNotice(creator, response?.error || "删除失败。", "error");
    return;
  }

  const creatorId = getCreatorCardId(creator);
  state.saved = response.kols || [];
  state.transientCreators = {
    ...state.transientCreators,
    [creatorId]: { creator, view: state.activeView }
  };
  setItemNotice(creator, "已从保存列表删除。", "success");
  await persistState();
  render();
  scheduleTransientCreatorRemoval(creatorId);
}

async function clearCurrentView() {
  if (state.activeView === "saved") {
    await clearSavedCreators();
    return;
  }

  if (!state.candidates.length) {
    setNotice("候选列表为空，无需清空。", "error");
    render();
    return;
  }

  state.candidates = [];
  state.summary = null;
  state.itemNotices = {};
  state.transientCreators = {};
  resetReviewState();
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

  const response = await sendMessage({
    type: "CLEAR_SAVED_KOLS",
    payload: { context: buildFeedbackContext("saved") }
  });
  if (!response?.ok) {
    setNotice(response?.error || "清空已保存 list 失败。", "error");
    render();
    return;
  }

  state.saved = [];
  state.itemNotices = {};
  state.transientCreators = {};
  setNotice("已清空保存列表。", "success");
  await persistState();
  render();
}

async function openCreatorProfile(creator, triggerButton) {
  if (!creator.profileUrl) {
    setItemNotice(creator, "这个 OP 缺少主页地址。", "error");
    return;
  }

  const restoreButton = setButtonPending(triggerButton, "打开中");
  let response;
  try {
    response = await sendMessage({
      type: "OPEN_CREATOR_PROFILE",
      payload: { profileUrl: creator.profileUrl }
    });
  } finally {
    window.setTimeout(restoreButton, 420);
  }

  if (!response?.ok) {
    setItemNotice(creator, response?.error || "主页跳转失败。", "error");
    return;
  }
}

function setButtonPending(button, pendingText) {
  if (!button) return () => {};
  const originalText = button.textContent;
  const wasDisabled = button.disabled;
  button.textContent = pendingText;
  button.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  return () => {
    button.textContent = originalText;
    button.disabled = wasDisabled;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  };
}

function setTextWithTooltip(node, value) {
  if (!node) return;
  const text = String(value ?? "");
  node.textContent = text;
  if (text) {
    node.title = text;
  } else {
    node.removeAttribute("title");
  }
}

function showContact(creator) {
  openContactDialog(creator);
}

function render() {
  normalizeReviewState();
  elements.matchBrief.value = state.briefText || "";
  elements.minFollowers.value = state.minFollowers || "";
  elements.platformSelect.value = state.platform || "x";
  elements.countrySelect.value = state.country || "";
  renderThemeControl();
  elements.discoverButton.disabled = state.busy;
  elements.exportCsvButton.disabled = state.busy || !state.saved.length;
  elements.matchBrief.disabled = state.busy;
  elements.minFollowers.disabled = state.busy;
  elements.platformSelect.disabled = state.busy;
  elements.countrySelect.disabled = state.busy;
  elements.discoverButton.textContent = state.busy && state.busyLabel === "discover" ? "匹配中..." : "全站匹配";
  elements.exportCsvButton.textContent = state.saved.length ? `CSV ${state.saved.length}` : "CSV";
  elements.exportCsvButton.title = state.saved.length
    ? `导出 ${state.saved.length} 个已保存创作者`
    : "没有已保存创作者可导出";

  elements.candidateTab.classList.toggle("active", state.activeView === "candidates");
  elements.savedTab.classList.toggle("active", state.activeView === "saved");
  elements.candidateTab.textContent = `候选 ${state.candidates.length}`;
  elements.savedTab.textContent = `已保存 ${state.saved.length}`;
  elements.saveAllButton.hidden = state.activeView !== "candidates";
  elements.saveAllButton.disabled = state.busy || state.review.active || !state.candidates.length;
  elements.startReviewButton.hidden = state.activeView !== "candidates";
  elements.startReviewButton.disabled = state.busy || !state.candidates.length;
  elements.startReviewButton.textContent = state.review.active ? "结束审阅" : "开始审阅";
  elements.clearButton.disabled = state.busy || !getVisibleCreators().length;
  elements.clearButton.textContent = state.activeView === "saved" ? "清空已保存" : "清空候选";
  renderReviewPanel();
  elements.notice.textContent = state.notice || DEFAULT_NOTICE;
  elements.notice.className = ["notice", state.noticeType].filter(Boolean).join(" ");

  renderCards();
}

async function toggleReviewMode() {
  if (state.review.active) {
    resetReviewState();
    setNotice("已结束审阅模式。");
    await persistState();
    render();
    return;
  }

  await startReviewMode();
}

async function startReviewMode() {
  if (!state.candidates.length) {
    setNotice("候选列表为空，先完成匹配后再开始审阅。", "error");
    render();
    return;
  }

  state.activeView = "candidates";
  state.review.active = true;
  state.review.currentId = getCreatorCardId(state.candidates[0]);
  setNotice("只看当前 OP。Like 保存，No 忽略。", "success");
  await persistState();
  render();
  await openReviewCurrentProfile();
}

async function reviewLikeCurrent() {
  const creator = getCurrentReviewCreator();
  if (!creator) {
    await finishReviewMode();
    return;
  }

  const response = await sendMessage({
    type: "SAVE_CANDIDATES",
    payload: {
      candidates: [creator],
      context: buildFeedbackContext("candidate")
    }
  });

  if (!response?.ok) {
    setItemNotice(creator, response?.error || "保存失败，请稍后重试。", "error");
    return;
  }

  state.saved = response.kols || [];
  await completeReviewAction(creator, "已保存到已保存 list。", "success");
}

async function reviewNoCurrent() {
  const creator = getCurrentReviewCreator();
  if (!creator) {
    await finishReviewMode();
    return;
  }

  await recordFeedback([creator], "ignored", "candidate");
  await completeReviewAction(creator, "已忽略该 OP。", "success");
}

async function completeReviewAction(creator, message, type) {
  const creatorId = getCreatorCardId(creator);
  const nextCreator = getNextReviewCandidate(creator);
  state.candidates = state.candidates.filter((item) => getCreatorCardId(item) !== creatorId);
  setNotice(message, type);

  if (nextCreator) {
    state.review.currentId = getCreatorCardId(nextCreator);
  } else {
    resetReviewState();
    setNotice("审阅完成，候选列表已处理完。", "success");
  }

  await persistState();
  render();

  if (nextCreator) await openReviewCurrentProfile();
}

async function finishReviewMode() {
  resetReviewState();
  setNotice("审阅完成，候选列表已处理完。", "success");
  await persistState();
  render();
}

async function openReviewCurrentProfile() {
  const creator = getCurrentReviewCreator();
  if (!creator) {
    await finishReviewMode();
    return;
  }

  scrollCreatorCardIntoView(getCreatorCardId(creator));
  await openCreatorProfile(creator);
  scrollCreatorCardIntoView(getCreatorCardId(creator));
}

function normalizeReviewState() {
  if (state.activeView !== "candidates" || !state.candidates.length) {
    resetReviewState();
    return;
  }

  if (!state.review.active) return;
  if (!getCurrentReviewCreator()) {
    state.review.currentId = getCreatorCardId(state.candidates[0]);
  }
}

function resetReviewState() {
  state.review = {
    active: false,
    currentId: ""
  };
}

function renderReviewPanel() {
  const active = state.activeView === "candidates" && state.review.active;
  const creator = active ? getCurrentReviewCreator() : null;
  elements.reviewPanel.hidden = !active;
  elements.reviewLikeButton.disabled = state.busy || !creator;
  elements.reviewNoButton.disabled = state.busy || !creator;

  if (!active) {
    setTextWithTooltip(elements.reviewMeta, "");
    return;
  }

  if (!creator) {
    setTextWithTooltip(elements.reviewMeta, "没有待审 OP");
    return;
  }

  const index = state.candidates.findIndex((item) => getCreatorCardId(item) === state.review.currentId);
  const position = index >= 0 ? index + 1 : 1;
  setTextWithTooltip(elements.reviewMeta, `第 ${position}/${state.candidates.length} 个 / ${displayCreatorName(creator)}`);
}

function getCurrentReviewCreator() {
  if (!state.review.active || !state.review.currentId) return null;
  return state.candidates.find((item) => getCreatorCardId(item) === state.review.currentId) || null;
}

function getNextReviewCandidate(creator) {
  const creatorId = getCreatorCardId(creator);
  const currentIndex = state.candidates.findIndex((item) => getCreatorCardId(item) === creatorId);
  const remaining = state.candidates.filter((item) => getCreatorCardId(item) !== creatorId);
  if (!remaining.length) return null;
  if (currentIndex < 0) return remaining[0];
  return remaining[Math.min(currentIndex, remaining.length - 1)] || remaining[0];
}

function removeCandidatesFromQueue(creators) {
  const removeIds = new Set(creators.map(getCreatorCardId));
  if (!removeIds.size) return 0;

  const before = state.candidates.length;
  state.candidates = state.candidates.filter((item) => !removeIds.has(getCreatorCardId(item)));

  if (state.review.active && removeIds.has(state.review.currentId)) {
    const nextCreator = state.candidates[0];
    if (nextCreator) {
      state.review.currentId = getCreatorCardId(nextCreator);
    } else {
      resetReviewState();
    }
  }

  return before - state.candidates.length;
}

function isSavedCreator(creator) {
  const creatorId = getCreatorCardId(creator);
  return state.saved.some((item) => getCreatorCardId(item) === creatorId);
}

function scrollCreatorCardIntoView(creatorId) {
  const card = [...elements.cardList.querySelectorAll("[data-id]")]
    .find((item) => item.dataset.id === creatorId);
  card?.scrollIntoView({ block: "nearest" });
}

function renderCards() {
  elements.cardList.innerHTML = "";
  const isReviewingCandidates = state.activeView === "candidates" && state.review.active;
  const currentReviewCreator = isReviewingCandidates ? getCurrentReviewCreator() : null;
  const creators = isReviewingCandidates
    ? (currentReviewCreator ? [currentReviewCreator] : [])
    : getRenderableCreators();
  if (!creators.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.activeView === "saved"
      ? "已保存 list 为空。候选 OP 需要手动保存后才会出现在这里。"
      : state.review.active
        ? "没有待审 OP。"
        : "暂无候选。写好筛选条件后，点全站匹配。";
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
  const ignoreButton = fragment.querySelector('[data-action="ignore"]');
  const itemNotice = fragment.querySelector(".item-notice");
  const creatorId = getCreatorCardId(creator);
  const isTransient = state.transientCreators[creatorId]?.view === state.activeView;
  const isReviewCurrent = state.review.active && state.review.currentId === creatorId;

  card.dataset.id = creatorId;
  card.dataset.view = state.activeView;
  if (isTransient) card.classList.add("muted");
  if (isReviewCurrent) card.classList.add("review-current");
  if (isFreshStreamed(creator)) card.classList.add("stream-fresh");
  avatar.textContent = getInitials(creator);
  if (creator.avatarUrl) {
    avatar.style.backgroundImage = `url("${creator.avatarUrl}")`;
    avatar.textContent = "";
  }

  setTextWithTooltip(fragment.querySelector(".name"), displayCreatorName(creator));
  setTextWithTooltip(fragment.querySelector(".meta"), buildMeta(creator));
  fragment.querySelector(".score").textContent = `${creator.score ?? creator.match?.score ?? 0} 分`;
  setTextWithTooltip(fragment.querySelector(".bio"), buildBioText(creator));
  const matchReasonText = buildMatchReasonText(creator);
  setTextWithTooltip(fragment.querySelector(".match-reasons"), matchReasonText);

  const chips = fragment.querySelector(".chips");
  for (const text of buildChips(creator).slice(0, 5)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    setTextWithTooltip(chip, text);
    chips.appendChild(chip);
  }

  if (state.activeView === "saved") {
    ignoreButton.remove();
    saveButton.dataset.action = "removeSaved";
    saveButton.textContent = "删除";
  } else if (isReviewCurrent) {
    ignoreButton.remove();
    saveButton.remove();
  }

  if (isTransient) {
    for (const button of fragment.querySelectorAll("[data-action]")) {
      button.disabled = true;
    }
  }

  const notice = getItemNotice(creator);
  if (notice?.text) {
    itemNotice.hidden = false;
    itemNotice.textContent = notice.text;
    itemNotice.className = ["item-notice", notice.type].filter(Boolean).join(" ");
    itemNotice.setAttribute("role", notice.type === "error" ? "alert" : "status");
    itemNotice.setAttribute("aria-live", "polite");
  }

  return fragment;
}

function getCreatorCardId(creator) {
  return String(creator.id || `${creator.platform || "unknown"}:${creator.handle || creator.profileUrl || creator.name || ""}`);
}

function getItemNotice(creator) {
  return state.itemNotices[getCreatorCardId(creator)] || null;
}

function setItemNotice(creator, text, type = "", options = {}) {
  const id = getCreatorCardId(creator);
  if (!id) return;
  state.itemNotices = {
    ...state.itemNotices,
    [id]: { text, type }
  };
  if (options.render !== false) render();
}

function clearItemNotice(creatorId) {
  const next = { ...state.itemNotices };
  delete next[creatorId];
  state.itemNotices = next;
}

function scheduleTransientCreatorRemoval(creatorId) {
  window.setTimeout(() => {
    const nextTransientCreators = { ...state.transientCreators };
    delete nextTransientCreators[creatorId];
    state.transientCreators = nextTransientCreators;
    clearItemNotice(creatorId);
    render();
  }, 1_200);
}

function showActionFeedback(creator, text, type = "") {
  if (creator) {
    setItemNotice(creator, text, type);
    return;
  }
  setNotice(text, type);
  render();
}

function handleContactDialogClick(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const action = target?.closest("[data-dialog-action]")?.dataset.dialogAction;
  if (!action) return;

  if (action === "closeContact") closeContactDialog();
  if (action === "sendEmail") {
    const email = findContactEmail(state.activeContactCreator || {});
    if (email) openMailClient(state.activeContactCreator, email);
  }
}

function handleDocumentKeydown(event) {
  if (event.key === "Escape" && !elements.contactDialog.hidden) {
    closeContactDialog();
  }
}

function openContactDialog(creator) {
  state.activeContactCreator = creator;
  elements.contactDialogTitle.textContent = displayCreatorName(creator);
  elements.contactDialogSubtitle.textContent = [platformLabel(creator.platform), creator.handle].filter(Boolean).join(" / ");
  elements.contactDialogBody.replaceChildren(...buildContactDialogContent(creator));
  elements.contactDialog.hidden = false;
  elements.contactDialog.querySelector(".dialog-close")?.focus();
}

function closeContactDialog() {
  state.activeContactCreator = null;
  elements.contactDialog.hidden = true;
  elements.contactDialogBody.replaceChildren();
}

function buildContactDialogContent(creator) {
  const email = findContactEmail(creator);
  const content = [];

  content.push(createContactSummary(creator));
  content.push(createEmailDetailRow(creator, email));
  content.push(createDetailRow("主页", creator.profileUrl || "暂无主页地址", {
    href: creator.profileUrl || ""
  }));
  content.push(createDetailRow("粉丝", creator.metrics?.followers ? `${formatNumber(creator.metrics.followers)} 粉丝` : "粉丝未知"));
  content.push(createDetailRow("风险", riskLabel(creator.quality?.fakeFollowerRisk) || "暂无风险判断"));
  content.push(createDetailRow("简介", cleanProfileBio(creator.bio) || "暂无公开简介", { multiline: true }));
  content.push(createDetailRow("匹配", buildMatchReasonText(creator).replace(/^匹配理由：/, ""), { multiline: true }));

  const tags = buildChips(creator).slice(0, 6);
  if (tags.length) content.push(createTagRow(tags));
  return content;
}

function createContactSummary(creator) {
  const summary = document.createElement("div");
  summary.className = "contact-summary";

  const avatar = document.createElement("div");
  avatar.className = "contact-avatar";
  avatar.textContent = getInitials(creator);
  if (creator.avatarUrl) {
    avatar.style.backgroundImage = `url("${creator.avatarUrl}")`;
    avatar.textContent = "";
  }

  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = displayCreatorName(creator);
  const meta = document.createElement("span");
  meta.textContent = buildMeta(creator);
  text.append(title, meta);
  summary.append(avatar, text);
  return summary;
}

function createEmailDetailRow(creator, email) {
  const row = createDetailRow("邮箱", "");
  const value = row.querySelector(".contact-detail-value");
  value.classList.add("email-value");
  value.replaceChildren();

  const emailText = document.createElement("span");
  emailText.textContent = email || "暂无";
  value.appendChild(emailText);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "mail-button";
  button.dataset.dialogAction = "sendEmail";
  button.disabled = !email;
  button.hidden = !email;
  button.textContent = "发送邮件";
  button.title = email ? `发送邮件给 ${displayCreatorName(creator)}` : "";
  value.appendChild(button);
  return row;
}

function createDetailRow(label, value, options = {}) {
  const row = document.createElement("div");
  row.className = "contact-detail-row";

  const labelNode = document.createElement("span");
  labelNode.className = "contact-detail-label";
  labelNode.textContent = label;

  const valueNode = document.createElement("div");
  valueNode.className = "contact-detail-value";
  if (options.multiline) valueNode.classList.add("multiline");

  if (options.href) {
    const link = document.createElement("a");
    link.href = options.href;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = value;
    valueNode.appendChild(link);
  } else {
    valueNode.textContent = value || "暂无";
  }

  row.append(labelNode, valueNode);
  return row;
}

function createTagRow(tags) {
  const row = document.createElement("div");
  row.className = "contact-detail-row";

  const labelNode = document.createElement("span");
  labelNode.className = "contact-detail-label";
  labelNode.textContent = "标签";

  const valueNode = document.createElement("div");
  valueNode.className = "contact-detail-value contact-tags";
  for (const tag of tags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = tag;
    valueNode.appendChild(chip);
  }

  row.append(labelNode, valueNode);
  return row;
}

function openMailClient(creator, email) {
  const name = displayCreatorName(creator);
  const subject = `合作沟通：${name}`;
  const body = [
    `${name}，`,
    "",
    "我们想和你沟通一次合作机会，方便的话请回复这封邮件。",
    creator.profileUrl ? `主页：${creator.profileUrl}` : ""
  ].filter((line, index) => line || index < 2).join("\n");
  window.location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function isFreshStreamed(creator) {
  return creator._streamedAt && Date.now() - creator._streamedAt < 2_800;
}

function exportSavedCsv() {
  if (!state.saved.length) {
    setNotice("已保存 list 为空，先保存候选再导出。", "error");
    render();
    return;
  }

  downloadCsv("kol-lite.csv", state.saved);
  setNotice(`已导出 ${state.saved.length} 条已保存线索。`, "success");
  render();
}

function setBusy(busy, label = "") {
  state.busy = busy;
  state.busyLabel = busy ? label : "";
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
  elements.progressMeta.textContent = `第 ${state.loadingStep + 1}/${LOADING_STEPS.length} 步 / 已等待 ${elapsedSeconds} 秒`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressBar.parentElement.setAttribute("aria-valuenow", String(Math.round(percent)));
  elements.progressBar.parentElement.setAttribute("aria-valuetext", `${stepText}，已等待 ${elapsedSeconds} 秒`);
  setNotice(`${stepText} 保持面板打开即可，长时间无响应会自动停止。`);
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
  elements.notice.setAttribute("role", type === "error" ? "alert" : "status");
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

async function ignoreCandidate(creator) {
  const creatorId = getCreatorCardId(creator);
  state.candidates = state.candidates.filter((item) => getCreatorCardId(item) !== creatorId);
  state.transientCreators = {
    ...state.transientCreators,
    [creatorId]: { creator, view: state.activeView }
  };
  await recordFeedback([creator], "ignored", "candidate");
  setItemNotice(creator, "已忽略该候选，后续搜索会降低类似结果权重。", "success");
  await persistState();
  render();
  scheduleTransientCreatorRemoval(creatorId);
}

async function recordFeedback(creators, action, scope) {
  const list = Array.isArray(creators) ? creators : [creators];
  if (!list.length) return;
  await sendMessage({
    type: "RECORD_DISCOVERY_FEEDBACK",
    payload: {
      creators: list,
      action,
      context: buildFeedbackContext(scope)
    }
  }).catch(() => {});
}

function buildFeedbackContext(scope) {
  return {
    source: "sidepanel",
    scope,
    briefText: state.briefText || elements.matchBrief.value || "",
    platform: state.platform,
    country: state.country,
    minFollowers: state.minFollowers
  };
}

function getVisibleCreators() {
  return state.activeView === "saved" ? state.saved : state.candidates;
}

function getRenderableCreators() {
  const creators = getVisibleCreators();
  const visibleIds = new Set(creators.map(getCreatorCardId));
  const transientCreators = Object.entries(state.transientCreators)
    .filter(([creatorId, entry]) => entry.view === state.activeView && !visibleIds.has(creatorId))
    .map(([, entry]) => entry.creator);
  return [...creators, ...transientCreators];
}

function buildMeta(creator) {
  const platform = platformLabel(creator.platform);
  const followers = creator.metrics?.followers ? `${formatNumber(creator.metrics.followers)} 粉丝` : "粉丝未知";
  const email = findContactEmail(creator) ? "有邮箱" : "暂无邮箱";
  return [platform, creator.handle, followers, email, riskLabel(creator.quality?.fakeFollowerRisk)].filter(Boolean).join(" / ");
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

  return parts.length ? `匹配理由：${parts.join(" / ")}` : "匹配理由：暂无明确理由";
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
  return normalizeContactEmail(creator.contact?.email)
    || extractEmail(`${creator.bio || ""} ${creator.discovery?.evidenceText || ""}`);
}

function displayCreatorName(creator) {
  const rawName = String(creator.name || "").trim();
  if (rawName && !isPlaceholderCreatorName(rawName)) return rawName;
  return creator.handle || "未命名 OP";
}

function isPlaceholderCreatorName(name) {
  return /^(unknown creator|unknown|n\/a|null|undefined)$/i.test(String(name || "").trim());
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return normalizeContactEmail(match?.[0]);
}

function normalizeContactEmail(email) {
  const normalized = String(email || "").trim();
  if (!normalized || isPlaceholderEmail(normalized)) return "";
  return normalized;
}

function isPlaceholderEmail(email) {
  return /(^|@)(example|example\.com)$/i.test(email)
    || /@(example|example\.(?:com|org|net)|test|invalid)\b/i.test(email);
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
