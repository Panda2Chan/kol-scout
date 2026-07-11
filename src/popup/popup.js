import { downloadCsv, downloadJson } from "../shared/export.js";
import { discoverCreatorsStreamFromBackend } from "../shared/backend-api.js";
import { PLATFORM_LABELS, createKol, createMatchBrief } from "../shared/schema.js";
import {
  getDiscoveryFeedback,
  getMatchBrief,
  getKols,
  recordDiscoveryFeedback,
  removeKol,
  setMatchBrief,
  updateKol,
  upsertKols
} from "../shared/storage.js";

const state = {
  candidates: [],
  saved: [],
  loadingTimer: null,
  loadingStartedAt: 0,
  loadingStep: 0,
  platform: "tiktok",
  country: "",
  theme: "system",
  busy: false,
  busyLabel: ""
};

const THEME_STORAGE_KEY = "kolLite.theme";
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

const DISCOVERY_LOADING_STEPS = [
  "整理搜索条件...",
  "查找公开创作者资料...",
  "补全头像、简介、粉丝量和邮箱...",
  "剔除资料不足和低匹配账号...",
  "按匹配度整理候选..."
];

const elements = {
  saveAllButton: document.querySelector("#saveAllButton"),
  matchButton: document.querySelector("#matchButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  exportJsonButton: document.querySelector("#exportJsonButton"),
  matchBrief: document.querySelector("#matchBrief"),
  minFollowers: document.querySelector("#minFollowers"),
  platformSelect: document.querySelector("#platformSelect"),
  countrySelect: document.querySelector("#countrySelect"),
  themeButton: document.querySelector("#themeButton"),
  themeIcon: document.querySelector("#themeIcon"),
  savedCount: document.querySelector("#savedCount"),
  candidateCount: document.querySelector("#candidateCount"),
  avgScore: document.querySelector("#avgScore"),
  notice: document.querySelector("#notice"),
  progressPanel: document.querySelector("#progressPanel"),
  progressTitle: document.querySelector("#progressTitle"),
  progressMeta: document.querySelector("#progressMeta"),
  progressBar: document.querySelector("#progressBar"),
  progressSteps: document.querySelector("#progressSteps"),
  candidateList: document.querySelector("#candidateList"),
  savedList: document.querySelector("#savedList"),
  template: document.querySelector("#kolCardTemplate")
};

elements.matchButton.addEventListener("click", discoverCreators);
elements.saveAllButton.addEventListener("click", saveAllCandidates);
elements.exportCsvButton.addEventListener("click", exportSavedCsv);
elements.exportJsonButton?.addEventListener("click", exportSavedJson);
elements.platformSelect.addEventListener("change", () => {
  state.platform = normalizePlatform(elements.platformSelect.value, elements.matchBrief.value);
});
elements.countrySelect.addEventListener("change", () => {
  state.country = elements.countrySelect.value;
});
elements.themeButton.addEventListener("click", handleThemeToggle);

await hydrateTheme();
await hydrateBrief();
await refreshSaved();

async function hydrateTheme() {
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

async function matchCandidates() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先写一下你要找哪类创作者。", "error");
    return;
  }

  const target = state.candidates.length ? state.candidates : state.saved;
  if (!target.length) {
    setNotice("当前没有可匹配的候选或已保存线索。", "error");
    return;
  }

  await setMatchBrief(brief);
  setNotice("正在按你的条件重新排序...");
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
  setNotice("已按匹配分排好序。", "success");
}

async function searchCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先写一下你要找哪类创作者。", "error");
    return;
  }

  await setMatchBrief(brief);
  state.platform = normalizePlatform(elements.platformSelect.value, brief.rawText);
  setBusy(true, "搜索中");
  setNotice(`正在生成 ${platformLabel(state.platform)} 全站搜索并跳转...`);

  const response = await chrome.runtime.sendMessage({
    type: "SEARCH_CREATORS",
    payload: { brief, platform: state.platform }
  });

  setBusy(false);

  if (!response?.ok) {
    setNotice(response?.error || "全站搜索失败，请确认后端已启动。", "error");
    return;
  }

  const terms = response.plan?.positiveTerms?.slice(0, 4).join(" / ") || response.plan?.query || "关键词";
  setNotice(`已跳转 ${platformLabel(state.platform)} 用户搜索：${terms}。`, "success");
}

async function discoverCreators() {
  const brief = createMatchBrief(elements.matchBrief.value);
  if (!brief.rawText) {
    setNotice("先写一下你要找哪类创作者。", "error");
    return;
  }

  await setMatchBrief(brief);
  state.platform = normalizePlatform(elements.platformSelect.value, brief.rawText);
  setBusy(true, "匹配中");
  state.candidates = [];
  render();
  startDiscoveryLoading();

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
    setNotice(`${error.message || "没有完成匹配，检查后端或数据源后再试。"}${retainedText}`, "error");
    return;
  } finally {
    setBusy(false);
    stopDiscoveryLoading();
  }

  if (!response?.ok) {
    setNotice(response?.error || "没有完成匹配，检查后端或数据源后再试。", "error");
    return;
  }

  state.candidates = (response.candidates || [])
    .map(createKol)
    .filter((candidate) => !isSavedCreator(candidate));

  render();
  const summary = response.summary || {};
  const searchStatus = summary.aiSearch?.enabled
    ? (summary.aiSearch.cached ? "复用上次搜索策略" : "已生成搜索策略")
    : "使用基础规则";
  if (!state.candidates.length) {
    const reasonText = formatFilteredReasons(summary.filteredReasons);
    const sourceText = summary.totalFetched
      ? `已召回 ${summary.totalFetched} 个，但全部被过滤${reasonText ? `：${reasonText}` : ""}`
      : "真实数据源没有召回账号";
    setNotice(`这次没有合适候选：${searchStatus}，${sourceText}。可以放宽关键词或筛选条件。`, "error");
    return;
  }

  setNotice(
    `已找到 ${state.candidates.length} 个候选：${searchStatus}，过滤 ${summary.filtered || 0} 个低质或低匹配账号。`,
    "success"
  );
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
    country: elements.countrySelect?.value || "",
    maxFakeFollowerRisk: "medium"
  };
}

function startDiscoveryLoading() {
  stopDiscoveryLoading();
  renderProgressSteps();
  state.loadingStartedAt = Date.now();
  state.loadingStep = 0;
  elements.progressPanel.hidden = false;
  updateDiscoveryProgress();
  state.loadingTimer = setInterval(() => {
    updateDiscoveryProgress();
  }, 1_000);
}

function stopDiscoveryLoading() {
  if (state.loadingTimer) {
    clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }
  elements.progressPanel.hidden = true;
  state.loadingStartedAt = 0;
}

function updateDiscoveryProgress() {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - state.loadingStartedAt) / 1000));
  state.loadingStep = calculateLoadingStep(elapsedSeconds);
  const percent = Math.min(96, 8 + state.loadingStep * 18 + (elapsedSeconds % 12) * 1.5);
  const stepText = DISCOVERY_LOADING_STEPS[state.loadingStep];

  elements.progressTitle.textContent = stepText;
  elements.progressMeta.textContent = `${state.loadingStep + 1}/${DISCOVERY_LOADING_STEPS.length} / ${elapsedSeconds} 秒`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressBar.parentElement.setAttribute("aria-valuenow", String(Math.round(percent)));
  elements.progressBar.parentElement.setAttribute("aria-valuetext", `${stepText}，已等待 ${elapsedSeconds} 秒`);
  setNotice(`${stepText} 保持弹窗打开即可，长时间无响应会自动停止。`);
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
  for (const step of DISCOVERY_LOADING_STEPS) {
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

async function saveAllCandidates() {
  if (!state.candidates.length) {
    setNotice("当前没有可保存的候选。", "error");
    return;
  }

  const candidates = [...state.candidates];
  state.saved = await upsertKols(candidates);
  await recordFeedback(candidates, "saved", "candidate");
  state.candidates = [];
  render();
  setNotice(`已保存 ${candidates.length} 个候选。`, "success");
}

function exportSavedCsv() {
  if (!state.saved.length) {
    setNotice("已保存线索为空，先保存候选再导出 CSV。", "error");
    return;
  }

  downloadCsv("kol-lite.csv", state.saved);
  setNotice(`已导出 ${state.saved.length} 条已保存线索。`, "success");
}

function exportSavedJson() {
  if (!state.saved.length) {
    setNotice("已保存线索为空，先保存候选再导出 JSON。", "error");
    return;
  }

  downloadJson(`kol-lite-${new Date().toISOString().slice(0, 10)}.json`, state.saved);
  setNotice(`已导出 ${state.saved.length} 条已保存线索。`, "success");
}

async function refreshSaved() {
  state.saved = await getKols();
  removeCandidatesFromQueue(state.saved);
  render();
}

async function hydrateBrief() {
  const brief = await getMatchBrief();
  if (brief?.rawText) elements.matchBrief.value = brief.rawText;
  state.platform = normalizePlatform(elements.platformSelect.value, elements.matchBrief.value);
  state.country = elements.countrySelect?.value || "";
}

function render() {
  elements.platformSelect.value = state.platform || "tiktok";
  if (elements.countrySelect) elements.countrySelect.value = state.country || "";
  renderThemeControl();
  elements.savedCount.textContent = state.saved.length;
  elements.candidateCount.textContent = state.candidates.length;
  elements.avgScore.textContent = averageScore(state.saved);
  updateControls();

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

  if (isFreshStreamed(kol)) card.classList.add("stream-fresh");
  setTextWithTooltip(fragment.querySelector(".kol-name"), displayCreatorName(kol));
  fragment.querySelector(".score").textContent = `${kol.score || 0} 分`;
  setTextWithTooltip(fragment.querySelector(".meta"), buildMeta(kol));
  setTextWithTooltip(fragment.querySelector(".discovery"), buildDiscovery(kol));
  setTextWithTooltip(fragment.querySelector(".match"), buildMatch(kol));
  setTextWithTooltip(fragment.querySelector(".bio"), buildBioText(kol));
  const matchReasonText = buildMatchReasonText(kol);
  setTextWithTooltip(fragment.querySelector(".match-reasons"), matchReasonText);
  profileLink.href = kol.profileUrl || "#";
  setTextWithTooltip(profileLink, kol.profileUrl ? "跳转主页" : "");
  profileLink.hidden = !kol.profileUrl;
  profileLink.addEventListener("click", async (event) => {
    event.preventDefault();
    await openCreatorProfile(kol.profileUrl, profileLink);
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
      if (edited.status === "ignored") {
        await recordFeedback([edited], "ignored", "candidate");
        removeCandidateFromQueue(edited);
        render();
        setNotice("已忽略当前候选，后续搜索会降低类似结果权重。", "success");
        return;
      }
      state.saved = await upsertKols([edited]);
      await recordFeedback([edited], "saved", "candidate");
      removeCandidateFromQueue(edited);
      render();
      setNotice("已保存当前候选。", "success");
    });
  } else {
    saveButton.textContent = "更新";
    saveButton.addEventListener("click", async () => {
      const edited = readCardEdits(kol, card);
      await updateKol(kol.id, edited);
      await recordFeedback([edited], edited.status === "ignored" ? "ignored" : "saved", "saved");
      await refreshSaved();
      setNotice("线索已更新。", "success");
    });

    deleteButton.addEventListener("click", async () => {
      await recordFeedback([kol], "removed", "saved");
      state.saved = await removeKol(kol.id);
      render();
      setNotice("线索已删除。", "success");
    });
  }

  return fragment;
}

function isFreshStreamed(kol) {
  return kol._streamedAt && Date.now() - kol._streamedAt < 2_800;
}

function removeCandidateFromQueue(kol) {
  const key = getCandidateKey(kol);
  state.candidates = state.candidates.filter((item) => getCandidateKey(item) !== key);
}

function removeCandidatesFromQueue(kols) {
  const keys = new Set(kols.map(getCandidateKey));
  state.candidates = state.candidates.filter((item) => !keys.has(getCandidateKey(item)));
}

function isSavedCreator(kol) {
  const key = getCandidateKey(kol);
  return state.saved.some((item) => getCandidateKey(item) === key);
}

async function openCreatorProfile(profileUrl, triggerLink) {
  if (!profileUrl) {
    setNotice("这个候选缺少主页地址。", "error");
    return;
  }

  const restoreLink = setLinkPending(triggerLink, "打开中");
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "OPEN_CREATOR_PROFILE",
      payload: { profileUrl }
    });
  } finally {
    setTimeout(restoreLink, 420);
  }

  if (!response?.ok) {
    setNotice(response?.error || "主页跳转失败。", "error");
    return;
  }
}

function setLinkPending(link, pendingText) {
  if (!link) return () => {};
  const originalText = link.textContent;
  const originalAriaDisabled = link.getAttribute("aria-disabled");
  link.textContent = pendingText;
  link.classList.add("is-loading");
  link.setAttribute("aria-busy", "true");
  link.setAttribute("aria-disabled", "true");
  return () => {
    link.textContent = originalText;
    link.classList.remove("is-loading");
    link.removeAttribute("aria-busy");
    if (originalAriaDisabled === null) {
      link.removeAttribute("aria-disabled");
    } else {
      link.setAttribute("aria-disabled", originalAriaDisabled);
    }
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

function showContact(kol) {
  const email = findContactEmail(kol);
  if (!email) {
    setNotice(`${displayCreatorName(kol)} 暂无公开邮箱。`);
    return;
  }

  setNotice(`${displayCreatorName(kol)} 的邮箱：${email}`, "success");
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

async function recordFeedback(creators, action, scope) {
  const list = Array.isArray(creators) ? creators : [creators];
  if (!list.length) return;
  await recordDiscoveryFeedback(list, action, buildFeedbackContext(scope)).catch(() => {});
}

function buildFeedbackContext(scope) {
  return {
    source: "popup",
    scope,
    briefText: elements.matchBrief.value || "",
    platform: state.platform,
    country: state.country,
    minFollowers: Math.max(0, Number(elements.minFollowers?.value || 0) || 0)
  };
}

function buildMeta(kol) {
  const platform = PLATFORM_LABELS[kol.platform] || kol.platform || "未知";
  const followers = kol.metrics?.followers ? `${formatNumber(kol.metrics.followers)} 粉丝` : "粉丝未知";
  const email = findContactEmail(kol) ? "有邮箱" : "暂无邮箱";
  return [platform, kol.handle, followers, email].filter(Boolean).join(" / ");
}

function buildBioText(kol) {
  const bio = cleanProfileBio(kol.bio);
  return bio ? `简介：${bio}` : "简介：暂无公开简介";
}

function cleanProfileBio(text) {
  const bio = String(text || "").trim();
  if (!bio || isBoilerplateProfileText(bio)) return "";
  return bio;
}

function buildMatchReasonText(kol) {
  const reasons = Array.isArray(kol.match?.reasons) ? kol.match.reasons.filter(Boolean) : [];
  const matchedKeywords = Array.isArray(kol.match?.matchedKeywords)
    ? kol.match.matchedKeywords.filter(Boolean)
    : [];
  const concerns = Array.isArray(kol.match?.concerns) ? kol.match.concerns.filter(Boolean) : [];
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

function findContactEmail(kol) {
  return normalizeContactEmail(kol.contact?.email)
    || extractEmail(`${kol.bio || ""} ${kol.discovery?.evidenceText || ""}`);
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at\]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)| dot )\s*/gi, ".")
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

function displayCreatorName(kol) {
  const rawName = String(kol.name || "").trim();
  if (rawName && !isPlaceholderCreatorName(rawName)) return rawName;
  return kol.handle || "未命名 OP";
}

function isPlaceholderCreatorName(name) {
  return /^(unknown creator|unknown|n\/a|null|undefined)$/i.test(String(name || "").trim());
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
  return [kind, status, kol.discovery?.summary].filter(Boolean).join(" / ");
}

function buildMatch(kol) {
  if (kol.match?.score == null) return "";

  const levelMap = {
    high: "高匹配",
    medium: "中匹配",
    low: "低匹配"
  };
  const quality = kol.quality?.score ? `质量 ${kol.quality.score}` : "";
  const fakeRisk = kol.quality?.fakeFollowerRisk ? `假粉风险 ${riskLabel(kol.quality.fakeFollowerRisk)}` : "";
  return [`关联度 ${kol.match.score}`, quality, fakeRisk, levelMap[kol.match.level] || ""]
    .filter(Boolean)
    .join(" / ");
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
  elements.notice.setAttribute("role", type === "error" ? "alert" : "status");
}

function setBusy(isBusy, label = "扫描中") {
  state.busy = isBusy;
  state.busyLabel = isBusy ? label : "";
  updateControls();
}

function updateControls() {
  const hasCandidates = state.candidates.length > 0;
  const hasSaved = state.saved.length > 0;
  elements.matchButton.disabled = state.busy;
  elements.saveAllButton.disabled = state.busy || !hasCandidates;
  elements.exportCsvButton.disabled = state.busy || !hasSaved;
  elements.matchBrief.disabled = state.busy;
  elements.minFollowers.disabled = state.busy;
  elements.platformSelect.disabled = state.busy;
  if (elements.countrySelect) elements.countrySelect.disabled = state.busy;
  if (elements.exportJsonButton) elements.exportJsonButton.disabled = state.busy || !hasSaved;
  elements.matchButton.textContent = state.busy && state.busyLabel !== "扫描中" ? state.busyLabel : "全站匹配";
  elements.saveAllButton.textContent = hasCandidates ? `保存全部 ${state.candidates.length}` : "保存全部";
  elements.exportCsvButton.title = hasSaved ? "导出已保存线索 CSV" : "没有已保存线索可导出";
  if (elements.exportJsonButton) {
    elements.exportJsonButton.title = hasSaved ? "导出已保存线索 JSON" : "没有已保存线索可导出";
  }
}

function riskLabel(value) {
  return {
    low: "低",
    medium: "中",
    high: "高"
  }[value] || value;
}

function normalizePlatform(value, briefText = "") {
  const explicit = String(value || "").toLowerCase().replace(/\s+/g, "");
  if (explicit === "tiktok" || explicit === "x" || explicit === "youtube") return explicit;
  if (explicit === "twitter") return "x";
  if (explicit === "yt" || explicit === "youtu.be") return "youtube";

  const lower = String(briefText || "").toLowerCase();
  if (/youtube|you\s*tube|\byt\b|youtu\.be|油管|频道|頻道|订阅|訂閱|channel/.test(lower)) return "youtube";
  if (/tiktok|tik tok|抖音|短视频|带货视频/.test(lower)) return "tiktok";
  return "tiktok";
}

function platformLabel(platform) {
  return {
    x: "X",
    youtube: "YouTube",
    tiktok: "TikTok"
  }[platform] || platform || "目标平台";
}
