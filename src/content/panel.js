(() => {
  const existing = window.__KOL_LITE_PANEL__;
  if (existing) {
    existing.toggle();
    return;
  }

  const PANEL_STORAGE_KEY = "kolLite.inlinePanel";
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
    busy: false,
    loadingTimer: null,
    loadingStep: 0,
    briefText: "",
    minFollowers: 0,
    theme: "system",
    candidates: [],
    saved: [],
    summary: null,
    notice: DEFAULT_NOTICE,
    noticeType: "",
    busyLabel: "",
    itemNotices: {},
    recentlyRemovedCreators: {},
    contactDialog: null
  };

  let remountTimer = null;

  const root = document.createElement("aside");
  root.id = "kol-lite-panel";
  root.className = "kol-lite-embedded";
  root.dataset.theme = "system";
  root.setAttribute("aria-label", "KOL Scout");
  root.innerHTML = `
    <div class="kol-panel-shell">
      <header class="kol-panel-header">
        <div class="kol-panel-title">
          <strong>KOL Scout</strong>
          <span>帮出海团队快速找到海外 KOL</span>
        </div>
        <button class="kol-theme-button" type="button" data-action="theme" aria-label="切换主题" title="主题：跟随系统">
          <span data-role="themeIcon" aria-hidden="true">◐</span>
        </button>
        <button class="kol-icon-btn" type="button" data-action="close" title="关闭面板" aria-label="关闭面板">×</button>
      </header>
      <section class="kol-panel-body">
        <div class="kol-panel-controls">
          <label class="kol-field-label">
            找哪类创作者
            <textarea data-field="brief" placeholder="例如：亚洲美妆创作者，粉丝 10 万以上，适合新品种草"></textarea>
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
            <button class="kol-btn kol-btn-danger" type="button" data-action="clear"></button>
          </div>
          <div class="kol-tabs" role="tablist" aria-label="KOL list views">
            <button class="kol-tab" type="button" data-action="view" data-view="candidates">候选</button>
            <button class="kol-tab" type="button" data-action="view" data-view="saved">已保存</button>
          </div>
          <div class="kol-notice" data-role="notice" role="status" aria-live="polite"></div>
          <div class="kol-stats">
            <div class="kol-stat"><strong data-stat="candidates">0</strong><span>候选 OP</span></div>
            <div class="kol-stat"><strong data-stat="saved">0</strong><span>已保存</span></div>
            <div class="kol-stat"><strong data-stat="source">Web</strong><span>数据源</span></div>
          </div>
        </div>
        <div class="kol-results" data-role="results"></div>
      </section>
    </div>
    <div class="kol-contact-overlay" data-role="contactOverlay" hidden>
      <div class="kol-contact-dialog" data-role="contactDialog" role="dialog" aria-modal="true" aria-labelledby="kol-contact-title" tabindex="-1">
        <header class="kol-contact-header">
          <div>
            <span>联系 OP</span>
            <strong id="kol-contact-title" data-role="contactName"></strong>
          </div>
          <button class="kol-icon-btn" type="button" data-action="closeContact" title="关闭弹窗" aria-label="关闭弹窗">×</button>
        </header>
        <div class="kol-contact-body">
          <div class="kol-contact-identity">
            <div class="kol-contact-avatar" data-role="contactAvatar"></div>
            <div class="kol-contact-summary">
              <div class="kol-contact-meta" data-role="contactMeta"></div>
              <a class="kol-contact-profile" data-role="contactProfile" target="_blank" rel="noreferrer"></a>
            </div>
          </div>
          <section class="kol-contact-section">
            <span>公开邮箱</span>
            <div class="kol-contact-email-row">
              <strong data-role="contactEmail"></strong>
              <button class="kol-btn kol-btn-primary" type="button" data-action="sendEmail">发送邮件</button>
            </div>
          </section>
          <section class="kol-contact-section">
            <span>简介</span>
            <p data-role="contactBio"></p>
          </section>
        </div>
      </div>
    </div>
  `;

  const elements = {
    brief: root.querySelector('[data-field="brief"]'),
    minFollowers: root.querySelector('[data-field="minFollowers"]'),
    themeButton: root.querySelector('[data-action="theme"]'),
    themeIcon: root.querySelector('[data-role="themeIcon"]'),
    notice: root.querySelector('[data-role="notice"]'),
    results: root.querySelector('[data-role="results"]'),
    candidateCount: root.querySelector('[data-stat="candidates"]'),
    savedCount: root.querySelector('[data-stat="saved"]'),
    source: root.querySelector('[data-stat="source"]'),
    discoverButton: root.querySelector('[data-action="discover"]'),
    clearButton: root.querySelector('[data-action="clear"]'),
    candidateTab: root.querySelector('[data-view="candidates"]'),
    savedTab: root.querySelector('[data-view="saved"]'),
    contactOverlay: root.querySelector('[data-role="contactOverlay"]'),
    contactDialog: root.querySelector('[data-role="contactDialog"]'),
    contactName: root.querySelector('[data-role="contactName"]'),
    contactAvatar: root.querySelector('[data-role="contactAvatar"]'),
    contactMeta: root.querySelector('[data-role="contactMeta"]'),
    contactProfile: root.querySelector('[data-role="contactProfile"]'),
    contactEmail: root.querySelector('[data-role="contactEmail"]'),
    contactSendButton: root.querySelector('[data-action="sendEmail"]'),
    contactBio: root.querySelector('[data-role="contactBio"]')
  };

  root.addEventListener("click", handleClick);
  elements.contactOverlay.addEventListener("click", handleContactOverlayClick);
  document.addEventListener("keydown", handleKeyDown);
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
    await loadTheme();
    await loadPanelState();
    await refreshSaved({ silent: true });
    openPanel();
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
    root.dataset.theme = normalized;
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

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const actionElement = target?.closest("[data-action]");
    const action = actionElement?.dataset.action;
    if (!action) return;

    const card = target?.closest("[data-creator-id]");
    const creator = card ? getRenderableCreators().find((item) => getCreatorKey(item) === card.dataset.creatorId) : null;

    if (action === "close") closePanel();
    if (action === "closeContact") closeContactDialog();
    if (action === "sendEmail") openContactEmail();
    if (action === "view") await switchView(actionElement.dataset.view || "candidates");
    if (action === "theme") await handleThemeToggle();
    if (action === "discover") await discoverCreators();
    if (action === "clear") await clearCurrentView();
    if (action === "profile" && creator) await openCreatorProfile(creator, actionElement);
    if (action === "contact" && creator) showContact(creator);
    if (action === "save" && creator) await saveCandidates([creator], { itemNoticeCreator: creator });
    if (action === "saveAll") await saveCandidates(state.candidates);
    if (action === "removeSaved" && creator) await removeSavedCreator(creator);
    if (action === "clearSaved") await clearSavedCreators();
  }

  function handleContactOverlayClick(event) {
    if (event.target === elements.contactOverlay) closeContactDialog();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && !elements.contactOverlay.hidden) closeContactDialog();
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
      setNotice("先写一下你要找哪类创作者。", "error");
      return;
    }

    state.briefText = brief.rawText;
    state.minFollowers = Math.max(0, Number(elements.minFollowers.value || 0) || 0);
    state.activeView = "candidates";
    setBusy(true, "discover");
    startLoading();

    let response;
    try {
      response = await sendMessage({
        type: "DISCOVER_CREATORS",
        payload: {
          brief,
          platform: "x",
          limit: 20,
          filters: buildDiscoveryFilters()
        }
      });
    } catch (error) {
      response = { ok: false, error: error.message };
    } finally {
      setBusy(false);
      stopLoading();
    }

    if (!response?.ok) {
      setNotice(response?.error || "没有完成匹配，检查后端服务后再试。", "error");
      await persistPanelState();
      return;
    }

    state.candidates = (response.candidates || []).filter((candidate) => !isSavedCreator(candidate));
    state.summary = response.summary || null;
    state.itemNotices = {};
    state.recentlyRemovedCreators = {};

    const summary = response.summary || {};
    if (!state.candidates.length) {
      const reasonText = formatFilteredReasons(summary.filteredReasons);
      setNotice(
        `这次没有合适候选：已看过 ${summary.totalFetched || 0} 个${reasonText ? `，主要原因：${reasonText}` : ""}。`,
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

  async function saveCandidates(candidates, options = {}) {
    const itemNoticeCreator = options.itemNoticeCreator || null;

    if (!candidates.length) {
      if (itemNoticeCreator) {
        setItemNotice(itemNoticeCreator, "当前没有可保存的候选。", "error");
        render();
      } else {
        setNotice("当前没有可保存的候选。", "error");
      }
      return;
    }

    const response = await sendMessage({
      type: "SAVE_CANDIDATES",
      payload: { candidates }
    });

    if (!response?.ok) {
      if (itemNoticeCreator) {
        setItemNotice(itemNoticeCreator, response?.error || "保存失败。", "error");
        render();
      } else {
        setNotice(response?.error || "保存失败。", "error");
      }
      return;
    }

    const savedCount = candidates.length;
    removeCandidatesFromQueue(candidates);
    state.saved = response.kols || [];
    if (itemNoticeCreator) {
      setNotice("已保存到已保存 list。", "success");
    } else {
      setNotice(`已保存 ${savedCount} 个候选。`, "success");
    }
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
    removeCandidatesFromQueue(state.saved);
  }

  async function removeSavedCreator(creator) {
    const response = await sendMessage({
      type: "REMOVE_SAVED_KOL",
      payload: { id: creator.id }
    });

    if (!response?.ok) {
      setItemNotice(creator, response?.error || "删除失败。", "error");
      render();
      return;
    }

    const creatorKey = getCreatorKey(creator);
    state.saved = response.kols || [];
    state.recentlyRemovedCreators[creatorKey] = creator;
    setItemNotice(creator, "已从保存列表删除。", "success");
    await persistPanelState();
    render();
    window.setTimeout(() => {
      delete state.recentlyRemovedCreators[creatorKey];
      clearItemNoticeByKey(creatorKey);
      render();
    }, 1200);
  }

  async function clearCurrentView() {
    if (state.activeView === "saved") {
      await clearSavedCreators();
      return;
    }

    if (!state.candidates.length) {
      setNotice("候选列表为空，无需清空。", "error");
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
    state.recentlyRemovedCreators = {};
    setNotice("已清空保存列表。", "success");
    await persistPanelState();
    render();
  }

  async function openCreatorProfile(creator, triggerButton) {
    if (!creator.profileUrl) {
      setItemNotice(creator, "这个 OP 缺少主页地址。", "error");
      render();
      return;
    }

    await persistPanelState();
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
      await persistPanelState();
      render();
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

  function showContact(creator) {
    const email = findContactEmail(creator);

    state.contactDialog = { creator, email };
    renderContactDialog(creator, email);
    elements.contactOverlay.hidden = false;
    elements.contactDialog.focus();
  }

  function render() {
    elements.brief.value = state.briefText || "";
    elements.minFollowers.value = state.minFollowers || "";
    renderThemeControl();
    elements.candidateCount.textContent = String(state.candidates.length);
    elements.savedCount.textContent = String(state.saved.length);
    elements.source.textContent = formatSource(state.summary?.dataSource);
    elements.notice.textContent = state.notice || DEFAULT_NOTICE;
    elements.notice.dataset.type = state.noticeType || "";
    elements.notice.setAttribute("role", state.noticeType === "error" ? "alert" : "status");

    elements.brief.disabled = state.busy;
    elements.minFollowers.disabled = state.busy;
    elements.discoverButton.disabled = state.busy;
    elements.clearButton.disabled = state.busy || !getVisibleCreators().length;
    elements.discoverButton.textContent = state.busy && state.busyLabel === "discover" ? "匹配中..." : "全站匹配";
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
    const creators = getRenderableCreators();

    if (!creators.length) {
      const empty = document.createElement("div");
      empty.className = "kol-empty";
      empty.textContent = state.activeView === "saved"
        ? "已保存 list 为空。候选 OP 需要手动保存后才会出现在这里。"
        : "还没有候选。写好筛选条件后，点全站匹配。";
      elements.results.appendChild(empty);
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = "kol-list-toolbar";
    if (state.activeView === "candidates") {
      toolbar.appendChild(buildToolbarButton("saveAll", `保存全部 ${state.candidates.length} 个`, state.busy));
    } else {
      toolbar.appendChild(buildToolbarButton("clearSaved", "清空已保存 list", state.busy || !state.saved.length));
    }
    elements.results.appendChild(toolbar);

    for (const creator of creators) {
      elements.results.appendChild(renderCard(creator, {
        removed: Boolean(state.recentlyRemovedCreators[getCreatorKey(creator)])
      }));
    }
  }

  function renderCard(creator, options = {}) {
    const creatorKey = getCreatorKey(creator);
    const card = document.createElement("article");
    card.className = "kol-card";
    card.dataset.creatorId = creatorKey;
    if (options.removed) card.classList.add("kol-card-muted");

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
    setTextWithTooltip(name, displayCreatorName(creator));
    const meta = document.createElement("div");
    meta.className = "kol-meta";
    setTextWithTooltip(meta, buildMeta(creator));
    main.append(name, meta);

    const score = document.createElement("div");
    score.className = "kol-score";
    score.textContent = `${creator.score ?? creator.match?.score ?? 0} 分`;
    head.append(avatar, main, score);

    const bio = document.createElement("div");
    bio.className = "kol-bio";
    setTextWithTooltip(bio, buildBioText(creator));

    const matchReasons = document.createElement("div");
    matchReasons.className = "kol-match-reasons";
    const matchReasonText = buildMatchReasonText(creator);
    setTextWithTooltip(matchReasons, matchReasonText);

    const tags = document.createElement("div");
    tags.className = "kol-tags";
    for (const text of buildChips(creator).slice(0, 5)) {
      const chip = document.createElement("span");
      chip.className = "kol-chip";
      setTextWithTooltip(chip, text);
      tags.appendChild(chip);
    }

    const actions = document.createElement("div");
    actions.className = "kol-card-actions";
    actions.append(
      buildActionButton("profile", "主页", !creator.profileUrl || options.removed),
      buildActionButton("contact", "联系", options.removed),
      state.activeView === "saved"
        ? buildActionButton("removeSaved", "删除", options.removed)
        : buildActionButton("save", "保存", options.removed)
    );

    const itemNotice = document.createElement("div");
    itemNotice.className = "kol-item-notice";
    const notice = state.itemNotices[creatorKey];
    if (notice?.text) {
      itemNotice.textContent = notice.text;
      itemNotice.dataset.type = notice.type || "";
      itemNotice.setAttribute("role", notice.type === "error" ? "alert" : "status");
      itemNotice.setAttribute("aria-live", "polite");
    } else {
      itemNotice.hidden = true;
    }

    card.append(head, bio, matchReasons, tags, actions, itemNotice);
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

  function setBusy(busy, label = "") {
    state.busy = busy;
    state.busyLabel = busy ? label : "";
    render();
  }

  function startLoading() {
    stopLoading();
    state.loadingStep = 0;
    setNotice(LOADING_STEPS[state.loadingStep]);
    state.loadingTimer = window.setInterval(() => {
      state.loadingStep = Math.min(state.loadingStep + 1, LOADING_STEPS.length - 1);
      const suffix = state.loadingStep >= 1 ? "通常需要 1-3 分钟，关闭面板也会保留已返回候选。" : "";
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
    elements.notice.setAttribute("role", type === "error" ? "alert" : "status");
  }

  function setItemNotice(creator, text, type = "") {
    state.itemNotices[getCreatorKey(creator)] = { text, type };
  }

  function clearItemNoticeByKey(creatorKey) {
    delete state.itemNotices[creatorKey];
  }

  function openPanel() {
    root.hidden = false;
    mountPanel();
  }

  async function closePanel() {
    closeContactDialog();
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

  function getRenderableCreators() {
    const creators = getVisibleCreators();
    if (state.activeView !== "saved") return creators;

    const visibleKeys = new Set(creators.map(getCreatorKey));
    const removedCreators = Object.entries(state.recentlyRemovedCreators)
      .filter(([creatorKey]) => !visibleKeys.has(creatorKey))
      .map(([, creator]) => creator);
    return [...creators, ...removedCreators];
  }

  function removeCandidatesFromQueue(creators) {
    const removeKeys = new Set(creators.map(getCreatorKey));
    if (!removeKeys.size) return 0;

    const before = state.candidates.length;
    state.candidates = state.candidates.filter((item) => !removeKeys.has(getCreatorKey(item)));
    return before - state.candidates.length;
  }

  function isSavedCreator(creator) {
    const creatorKey = getCreatorKey(creator);
    return state.saved.some((item) => getCreatorKey(item) === creatorKey);
  }

  function getCreatorKey(creator) {
    const fallback = [
      creator.platform || "x",
      creator.handle || creator.profileUrl || creator.name || hashText(`${creator.bio || ""}${creator.discovery?.evidenceText || ""}`)
    ].join(":");
    return String(creator.id || fallback);
  }

  function renderContactDialog(creator, email) {
    const name = displayCreatorName(creator);
    setTextWithTooltip(elements.contactName, name);
    elements.contactAvatar.textContent = getInitials(creator);
    elements.contactAvatar.style.backgroundImage = "";
    if (creator.avatarUrl) {
      elements.contactAvatar.style.backgroundImage = `url("${creator.avatarUrl}")`;
      elements.contactAvatar.textContent = "";
    }
    setTextWithTooltip(elements.contactMeta, buildMeta(creator));
    setTextWithTooltip(elements.contactEmail, email || "暂无");
    elements.contactSendButton.hidden = !email;
    elements.contactSendButton.disabled = !email;
    setTextWithTooltip(elements.contactBio, buildBioText(creator).replace(/^简介：/, "") || "暂无公开简介");

    elements.contactProfile.href = creator.profileUrl || "#";
    setTextWithTooltip(elements.contactProfile, creator.profileUrl ? "查看主页" : "");
    elements.contactProfile.hidden = !creator.profileUrl;
  }

  function closeContactDialog() {
    elements.contactOverlay.hidden = true;
    state.contactDialog = null;
  }

  function openContactEmail() {
    const contact = state.contactDialog;
    if (!contact?.email) return;

    const email = String(contact.email).trim();
    if (!email) return;

    const subject = encodeURIComponent(`合作邀约：${displayCreatorName(contact.creator)}`);
    const body = encodeURIComponent(buildContactEmailBody(contact.creator));
    window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
  }

  function buildContactEmailBody(creator) {
    const name = displayCreatorName(creator);
    return [
      `${name}，你好：`,
      "",
      "我们在筛选合作 OP 时关注到了你的内容，想进一步沟通潜在合作机会。",
      ...(creator.profileUrl ? [`主页：${creator.profileUrl}`] : []),
      "",
      "期待你的回复。"
    ].join("\n");
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
    const email = findContactEmail(creator) ? "有邮箱" : "暂无邮箱";
    return [creator.handle, followers, email, riskLabel(creator.quality?.fakeFollowerRisk)].filter(Boolean).join(" / ");
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

  function formatSource(source = "") {
    if (!source) return "Web";
    if (source.includes("ai-web-search")) return "Web";
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
