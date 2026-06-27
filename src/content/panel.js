(() => {
  const existing = window.__KOL_LITE_PANEL__;
  if (existing) {
    existing.toggle();
    return;
  }

  const PANEL_STORAGE_KEY = "kolLite.inlinePanel";
  const DEFAULT_NOTICE = "全站匹配结果会进入候选列表；只有手动点击保存，才会加入已保存 list。";
  const LOADING_STEPS = [
    "正在理解筛选需求，生成 KOL 搜索策略...",
    "正在调用 AI Web Search 检索真实 X OP...",
    "正在读取公开主页简介、粉丝量、邮箱和头像...",
    "正在过滤假粉、低质量和低匹配账号...",
    "正在按匹配度整理候选列表..."
  ];

  const state = {
    activeView: "candidates",
    busy: false,
    loadingTimer: null,
    loadingStep: 0,
    briefText: "",
    minFollowers: 0,
    candidates: [],
    saved: [],
    summary: null,
    notice: DEFAULT_NOTICE,
    noticeType: ""
  };

  let remountTimer = null;

  const root = document.createElement("aside");
  root.id = "kol-lite-panel";
  root.className = "kol-lite-embedded";
  root.setAttribute("aria-label", "KOL Lite");
  root.innerHTML = `
    <div class="kol-panel-shell">
      <header class="kol-panel-header">
        <div class="kol-panel-title">
          <strong>KOL Lite</strong>
          <span>页面内全站匹配</span>
        </div>
        <button class="kol-icon-btn" type="button" data-action="close" title="关闭面板" aria-label="关闭面板">×</button>
      </header>
      <section class="kol-panel-body">
        <div class="kol-panel-controls">
          <label class="kol-field-label">
            关键词与筛选需求
            <textarea data-field="brief" placeholder="例如：女，亚洲，美妆，coser，粉丝 10 万以上，适合新品种草"></textarea>
          </label>
          <div class="kol-filter-row">
            <label class="kol-field-label">
              平台
              <input value="X / Twitter" disabled />
            </label>
            <label class="kol-field-label">
              粉丝数下限
              <input data-field="minFollowers" type="number" min="0" step="1000" placeholder="0" />
            </label>
          </div>
          <div class="kol-actions">
            <button class="kol-btn kol-btn-primary" type="button" data-action="discover">全站匹配</button>
            <button class="kol-btn" type="button" data-action="scan">扫描当前页</button>
            <button class="kol-btn kol-btn-danger" type="button" data-action="clear"></button>
          </div>
          <div class="kol-tabs" role="tablist" aria-label="KOL list views">
            <button class="kol-tab" type="button" data-action="view" data-view="candidates">候选</button>
            <button class="kol-tab" type="button" data-action="view" data-view="saved">已保存</button>
          </div>
          <div class="kol-notice" data-role="notice"></div>
          <div class="kol-stats">
            <div class="kol-stat"><strong data-stat="candidates">0</strong><span>候选 OP</span></div>
            <div class="kol-stat"><strong data-stat="saved">0</strong><span>已保存</span></div>
            <div class="kol-stat"><strong data-stat="source">AI</strong><span>数据源</span></div>
          </div>
        </div>
        <div class="kol-results" data-role="results"></div>
      </section>
    </div>
  `;

  const elements = {
    brief: root.querySelector('[data-field="brief"]'),
    minFollowers: root.querySelector('[data-field="minFollowers"]'),
    notice: root.querySelector('[data-role="notice"]'),
    results: root.querySelector('[data-role="results"]'),
    candidateCount: root.querySelector('[data-stat="candidates"]'),
    savedCount: root.querySelector('[data-stat="saved"]'),
    source: root.querySelector('[data-stat="source"]'),
    discoverButton: root.querySelector('[data-action="discover"]'),
    scanButton: root.querySelector('[data-action="scan"]'),
    clearButton: root.querySelector('[data-action="clear"]'),
    candidateTab: root.querySelector('[data-view="candidates"]'),
    savedTab: root.querySelector('[data-view="saved"]')
  };

  root.addEventListener("click", handleClick);
  elements.brief.addEventListener("input", handleFormChange);
  elements.minFollowers.addEventListener("input", handleFormChange);

  const observer = new MutationObserver(queueMountPanel);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.__KOL_LITE_PANEL__ = {
    toggle() {
      if (root.hidden) openPanel();
      else closePanel();
    },
    open: openPanel,
    close: closePanel
  };

  boot();

  async function boot() {
    await loadPanelState();
    await refreshSaved({ silent: true });
    openPanel();
    render();
  }

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const actionElement = target?.closest("[data-action]");
    const action = actionElement?.dataset.action;
    if (!action) return;

    const card = target?.closest("[data-creator-id]");
    const creator = card ? getVisibleCreators().find((item) => item.id === card.dataset.creatorId) : null;

    if (action === "close") closePanel();
    if (action === "view") await switchView(actionElement.dataset.view || "candidates");
    if (action === "discover") await discoverCreators();
    if (action === "scan") await scanCurrentPage();
    if (action === "clear") await clearCurrentView();
    if (action === "profile" && creator) await openCreatorProfile(creator);
    if (action === "contact" && creator) showContact(creator);
    if (action === "save" && creator) await saveCandidates([creator]);
    if (action === "saveAll") await saveCandidates(state.candidates);
    if (action === "removeSaved" && creator) await removeSavedCreator(creator);
    if (action === "clearSaved") await clearSavedCreators();
  }

  async function handleFormChange() {
    state.briefText = elements.brief.value;
    state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
    await persistPanelState();
  }

  async function switchView(view) {
    state.activeView = view === "saved" ? "saved" : "candidates";
    if (state.activeView === "saved") await refreshSaved({ silent: true });
    await persistPanelState();
    render();
  }

  async function discoverCreators() {
    const brief = buildMatchBrief(elements.brief.value);
    if (!brief.rawText) {
      setNotice("先输入关键词和筛选需求，再进行全站匹配。", "error");
      return;
    }

    state.briefText = brief.rawText;
    state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
    state.activeView = "candidates";
    setBusy(true);
    startLoading();

    const response = await sendMessage({
      type: "DISCOVER_CREATORS",
      payload: {
        brief,
        platform: "x",
        limit: 20,
        filters: buildDiscoveryFilters()
      }
    });

    setBusy(false);
    stopLoading();

    if (!response?.ok) {
      setNotice(response?.error || "全站匹配失败，请确认本地后端已启动。", "error");
      await persistPanelState();
      return;
    }

    state.candidates = response.candidates || [];
    state.summary = response.summary || null;

    const summary = response.summary || {};
    if (!state.candidates.length) {
      const reasonText = formatFilteredReasons(summary.filteredReasons);
      setNotice(
        `全站匹配未得到候选：已召回 ${summary.totalFetched || 0} 个${reasonText ? `，过滤原因：${reasonText}` : ""}。`,
        "error"
      );
    } else {
      setNotice(
        `全站匹配完成：候选 ${state.candidates.length} 个，过滤 ${summary.filtered || 0} 个。确认需要后再手动保存。`,
        "success"
      );
    }

    await persistPanelState();
    render();
  }

  async function scanCurrentPage() {
    setBusy(true);
    state.activeView = "candidates";
    setNotice("正在扫描当前页面...");

    const response = await sendMessage({ type: "SCAN_ACTIVE_TAB" });
    setBusy(false);

    if (!response?.ok) {
      setNotice(response?.error || "扫描失败，请确认当前页面允许插件访问。", "error");
      await persistPanelState();
      return;
    }

    state.candidates = response.scan?.candidates || [];
    state.summary = { dataSource: "page-scan" };
    if (!state.candidates.length) {
      setNotice("当前页面未识别到可见 OP。", "error");
    } else {
      setNotice(`扫描完成，发现 ${state.candidates.length} 个候选。确认需要后再手动保存。`, "success");
    }

    await persistPanelState();
    render();
  }

  async function saveCandidates(candidates) {
    if (!candidates.length) {
      setNotice("当前没有可保存的候选。", "error");
      return;
    }

    const response = await sendMessage({
      type: "SAVE_CANDIDATES",
      payload: { candidates }
    });

    if (!response?.ok) {
      setNotice(response?.error || "保存失败。", "error");
      return;
    }

    state.saved = response.kols || [];
    setNotice(`已保存 ${candidates.length} 个候选。`, "success");
    await persistPanelState();
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
      return;
    }

    state.saved = response.kols || [];
    setNotice("已从保存列表删除。", "success");
    await persistPanelState();
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
    await persistPanelState();
    render();
  }

  async function clearSavedCreators() {
    if (!state.saved.length) {
      setNotice("已保存 list 为空。", "error");
      return;
    }

    const confirmed = window.confirm("确认清空已保存 list？这个操作不可恢复。");
    if (!confirmed) return;

    const response = await sendMessage({ type: "CLEAR_SAVED_KOLS" });
    if (!response?.ok) {
      setNotice(response?.error || "清空已保存 list 失败。", "error");
      return;
    }

    state.saved = [];
    setNotice("已清空保存列表。", "success");
    await persistPanelState();
    render();
  }

  async function openCreatorProfile(creator) {
    if (!creator.profileUrl) {
      setNotice("这个 OP 缺少主页地址。", "error");
      return;
    }

    await persistPanelState();
    const response = await sendMessage({
      type: "OPEN_CREATOR_PROFILE",
      payload: { profileUrl: creator.profileUrl }
    });

    if (!response?.ok) {
      setNotice(response?.error || "主页跳转失败。", "error");
      await persistPanelState();
    }
  }

  function showContact(creator) {
    const email = findContactEmail(creator);
    if (!email) {
      setNotice(`${creator.name || creator.handle || "该 OP"} 暂未获取到公开邮箱。`, "error");
      return;
    }

    setNotice(`${creator.name || creator.handle} 的邮箱：${email}`, "success");
  }

  function render() {
    elements.brief.value = state.briefText || "";
    elements.minFollowers.value = state.minFollowers || "";
    elements.candidateCount.textContent = String(state.candidates.length);
    elements.savedCount.textContent = String(state.saved.length);
    elements.source.textContent = formatSource(state.summary?.dataSource);
    elements.notice.textContent = state.notice || DEFAULT_NOTICE;
    elements.notice.dataset.type = state.noticeType || "";

    elements.discoverButton.disabled = state.busy;
    elements.scanButton.disabled = state.busy;
    elements.clearButton.disabled = state.busy;
    elements.clearButton.textContent = state.activeView === "saved" ? "清空已保存" : "清空候选";
    elements.candidateTab.dataset.active = String(state.activeView === "candidates");
    elements.savedTab.dataset.active = String(state.activeView === "saved");
    elements.candidateTab.textContent = `候选 ${state.candidates.length}`;
    elements.savedTab.textContent = `已保存 ${state.saved.length}`;

    renderResults();
    queueMountPanel();
  }

  function renderResults() {
    elements.results.innerHTML = "";
    const creators = getVisibleCreators();

    if (!creators.length) {
      const empty = document.createElement("div");
      empty.className = "kol-empty";
      empty.textContent = state.activeView === "saved"
        ? "已保存 list 为空。候选 OP 需要手动保存后才会出现在这里。"
        : "还没有候选。你可以直接全站匹配，也可以先扫描当前 X 页面。";
      elements.results.appendChild(empty);
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "kol-list-toolbar";
    if (state.activeView === "candidates") {
      toolbar.appendChild(buildToolbarButton("saveAll", `保存全部 ${state.candidates.length} 个`, state.busy));
    } else {
      toolbar.appendChild(buildToolbarButton("clearSaved", "清空已保存 list", state.busy));
    }
    elements.results.appendChild(toolbar);

    for (const creator of creators) {
      elements.results.appendChild(renderCard(creator));
    }
  }

  function renderCard(creator) {
    const card = document.createElement("article");
    card.className = "kol-card";
    card.dataset.creatorId = creator.id || `${creator.platform}:${creator.handle || creator.profileUrl}`;

    const head = document.createElement("div");
    head.className = "kol-card-head";

    const avatar = document.createElement("div");
    avatar.className = "kol-avatar";
    avatar.textContent = getInitials(creator);
    if (creator.avatarUrl) {
      avatar.style.backgroundImage = `url("${creator.avatarUrl}")`;
      avatar.textContent = "";
    }

    const main = document.createElement("div");
    main.className = "kol-main";
    const name = document.createElement("div");
    name.className = "kol-name";
    name.textContent = creator.name || creator.handle || "Unknown creator";
    const meta = document.createElement("div");
    meta.className = "kol-meta";
    meta.textContent = buildMeta(creator);
    main.append(name, meta);

    const score = document.createElement("div");
    score.className = "kol-score";
    score.textContent = `${creator.score ?? creator.match?.score ?? 0} 分`;
    head.append(avatar, main, score);

    const bio = document.createElement("div");
    bio.className = "kol-bio";
    bio.textContent = buildBioText(creator);

    const matchReasons = document.createElement("div");
    matchReasons.className = "kol-match-reasons";
    matchReasons.textContent = buildMatchReasonText(creator);

    const tags = document.createElement("div");
    tags.className = "kol-tags";
    for (const text of buildChips(creator).slice(0, 5)) {
      const chip = document.createElement("span");
      chip.className = "kol-chip";
      chip.textContent = text;
      tags.appendChild(chip);
    }

    const actions = document.createElement("div");
    actions.className = "kol-card-actions";
    actions.append(
      buildActionButton("profile", "主页", !creator.profileUrl),
      buildActionButton("contact", "联系", false),
      state.activeView === "saved"
        ? buildActionButton("removeSaved", "删除", false)
        : buildActionButton("save", "保存", false)
    );

    card.append(head, bio, matchReasons, tags, actions);
    return card;
  }

  function buildToolbarButton(action, label, disabled) {
    const button = buildActionButton(action, label, disabled);
    button.classList.add(action === "clearSaved" ? "kol-btn-danger" : "kol-btn-primary");
    return button;
  }

  function buildActionButton(action, label, disabled) {
    const button = document.createElement("button");
    button.className = "kol-btn";
    button.type = "button";
    button.dataset.action = action;
    button.disabled = Boolean(disabled || state.busy);
    button.textContent = label;
    return button;
  }

  function setBusy(busy) {
    state.busy = busy;
    render();
  }

  function startLoading() {
    stopLoading();
    state.loadingStep = 0;
    setNotice(LOADING_STEPS[state.loadingStep]);
    state.loadingTimer = window.setInterval(() => {
      state.loadingStep = Math.min(state.loadingStep + 1, LOADING_STEPS.length - 1);
      const suffix = state.loadingStep >= 1 ? "AI 全站搜索通常需要 1-3 分钟，关闭面板后候选结果仍会保留。" : "";
      setNotice([LOADING_STEPS[state.loadingStep], suffix].filter(Boolean).join(" "));
    }, 12_000);
  }

  function stopLoading() {
    if (!state.loadingTimer) return;
    window.clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }

  function setNotice(text, type = "") {
    state.notice = text || DEFAULT_NOTICE;
    state.noticeType = type;
    elements.notice.textContent = state.notice;
    elements.notice.dataset.type = type;
  }

  function openPanel() {
    root.hidden = false;
    mountPanel();
  }

  async function closePanel() {
    root.hidden = true;
    cleanupDockMode();
    await persistPanelState();
  }

  function mountPanel() {
    if (root.hidden) return;

    const host = findEmbeddedHost();
    if (host) {
      if (root.parentElement !== host) host.prepend(root);
      root.classList.remove("kol-lite-docked");
      root.classList.add("kol-lite-embedded");
      cleanupDockMode();
      return;
    }

    if (root.parentElement !== document.body) document.body.appendChild(root);
    root.classList.remove("kol-lite-embedded");
    root.classList.add("kol-lite-docked");
    document.documentElement.classList.add("kol-lite-page-docked");
  }

  function queueMountPanel() {
    if (root.hidden || remountTimer) return;
    remountTimer = window.setTimeout(() => {
      remountTimer = null;
      mountPanel();
    }, 300);
  }

  function findEmbeddedHost() {
    const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
    if (sidebar instanceof HTMLElement) return sidebar;
    return null;
  }

  function cleanupDockMode() {
    document.documentElement.classList.remove("kol-lite-page-docked");
  }

  async function loadPanelState() {
    const data = await chrome.storage.local.get(PANEL_STORAGE_KEY);
    const saved = data[PANEL_STORAGE_KEY] || {};
    state.activeView = saved.activeView === "saved" ? "saved" : "candidates";
    state.briefText = saved.briefText || "";
    state.minFollowers = saved.minFollowers || 0;
    state.candidates = Array.isArray(saved.candidates) ? saved.candidates : [];
    state.summary = saved.summary || null;
    state.notice = saved.notice || DEFAULT_NOTICE;
    state.noticeType = saved.noticeType || "";
  }

  async function persistPanelState() {
    await chrome.storage.local.set({
      [PANEL_STORAGE_KEY]: {
        activeView: state.activeView,
        briefText: state.briefText,
        minFollowers: state.minFollowers,
        candidates: state.candidates,
        summary: state.summary,
        notice: state.notice,
        noticeType: state.noticeType,
        updatedAt: Date.now()
      }
    });
  }

  function getVisibleCreators() {
    return state.activeView === "saved" ? state.saved : state.candidates;
  }

  function buildMatchBrief(rawText) {
    const normalized = String(rawText || "").trim();
    return {
      id: `brief:${hashText(normalized)}`,
      rawText: normalized,
      updatedAt: Date.now()
    };
  }

  function buildDiscoveryFilters() {
    return {
      minMatchScore: 50,
      minQualityScore: 55,
      minFollowers: Math.max(0, Number(elements.minFollowers.value || 0) || 0),
      maxFakeFollowerRisk: "medium"
    };
  }

  function buildMeta(creator) {
    const followers = creator.metrics?.followers ? `${formatNumber(creator.metrics.followers)} 粉丝` : "粉丝未知";
    const email = findContactEmail(creator) ? "有邮箱" : "邮箱未知";
    return [creator.handle, followers, email, riskLabel(creator.quality?.fakeFollowerRisk)].filter(Boolean).join(" · ");
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

  function formatSource(source = "") {
    if (!source) return "AI";
    if (source.includes("ai-web-search")) return "AI";
    if (source.includes("yahoo")) return "Web";
    if (source.includes("page")) return "页面";
    return "API";
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

  function getInitials(creator) {
    const raw = creator.handle || creator.name || "K";
    return String(raw).replace(/^@/, "").slice(0, 2).toUpperCase();
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  function hashText(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }
})();
