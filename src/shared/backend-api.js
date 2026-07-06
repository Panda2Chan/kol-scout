import { buildBackendHeaders, getBackendApiBaseUrl } from "./backend-config.js";
import { formatBackendErrorMessage } from "./backend-errors.js";

const API_BASE_URL = getBackendApiBaseUrl();
const DISCOVERY_CLIENT_TIMEOUT_MS = 10 * 60 * 1000 + 15_000;

export async function discoverCreatorsFromBackend({
  brief,
  platform,
  limit = 20,
  filters = {},
  feedback = {},
  locale = "zh-CN"
}) {
  return postBackendJson("/api/discover/creators", {
    brief,
    platform,
    limit,
    filters,
    feedback,
    locale
  }, {
    timeoutMs: DISCOVERY_CLIENT_TIMEOUT_MS,
    timeoutMessage: "前端等待全站匹配结果超过 10 分钟，请查看后端日志或缩小筛选条件后重试。"
  });
}

export async function discoverCreatorsStreamFromBackend({
  brief,
  platform,
  limit = 20,
  filters = {},
  feedback = {},
  locale = "zh-CN"
}, handlers = {}) {
  return postBackendJsonStream("/api/discover/creators/stream", {
    brief,
    platform,
    limit,
    filters,
    feedback,
    locale
  }, {
    timeoutMs: DISCOVERY_CLIENT_TIMEOUT_MS,
    timeoutMessage: "前端等待全站匹配结果超过 10 分钟，请查看后端日志或缩小筛选条件后重试。",
    ...handlers
  });
}

export async function postBackendJson(path, payload, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 120_000));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: buildBackendHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    const data = parseJsonResponse(text);

    if (!response.ok || data?.ok === false) {
      throw buildBackendError(response, data);
    }

    return data;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(options.timeoutMessage || `后端请求超过 ${formatDuration(timeoutMs)} 未返回。`);
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(error?.message || "")) {
      throw new Error(`无法连接 KOL Scout API，请确认后端已启动在 ${API_BASE_URL}。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function postBackendJsonStream(path, payload, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 120_000));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let finalResult = null;

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      headers: buildBackendHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text();
      throw buildBackendError(response, parseJsonResponse(text));
    }
    if (!response.body?.getReader) {
      return postBackendJson(path.replace(/\/stream$/, ""), payload, options);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const event = parseStreamEvent(line);
        if (!event) continue;
        if (event.event === "error") throw buildStreamError(event);
        if (event.event === "complete") finalResult = event;
        options.onEvent?.(event);
      }

      if (done) break;
    }

    const tailEvent = parseStreamEvent(buffer);
    if (tailEvent) {
      if (tailEvent.event === "error") throw buildStreamError(tailEvent);
      if (tailEvent.event === "complete") finalResult = tailEvent;
      options.onEvent?.(tailEvent);
    }

    if (!finalResult) throw new Error("后端流式响应未返回完成事件，请检查服务日志。");
    return finalResult;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(options.timeoutMessage || `后端请求超过 ${formatDuration(timeoutMs)} 未返回。`);
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(error?.message || "")) {
      throw new Error(`无法连接 KOL Scout API，请确认后端已启动在 ${API_BASE_URL}。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseJsonResponse(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("后端返回了非 JSON 内容，请检查本地服务日志。");
  }
}

function buildBackendError(response, data = {}) {
  const error = new Error(formatBackendErrorMessage(data, `后端请求失败：${response.status}`));
  error.statusCode = response.status;
  error.code = data.code || "";
  error.requestId = data.requestId || "";
  return error;
}

function parseStreamEvent(line) {
  const text = String(line || "").trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("后端流式响应包含非法 JSON 行，请检查服务日志。");
  }
}

function buildStreamError(event = {}) {
  const error = new Error(event.error || "全站匹配流式请求失败。");
  error.statusCode = event.statusCode || 500;
  error.code = event.code || "";
  error.requestId = event.requestId || "";
  return error;
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}
