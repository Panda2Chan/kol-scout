const BACKEND_ERROR_MESSAGES = {
  AUTH_TOKEN_MISSING: "缺少访问 token，请检查插件配置。",
  AUTH_TOKEN_INVALID: "访问 token 无效，请重新配置。",
  RATE_LIMITED: "请求太频繁，稍后再试。",
  DAILY_QUOTA_EXCEEDED: "今天的全站匹配额度已用完。",
  USER_CONCURRENCY_LIMITED: "已有全站匹配任务在运行，稍后再试。",
  DISCOVERY_QUEUE_FULL: "全站匹配排队已满，稍后再试。",
  DISCOVERY_QUEUE_TIMEOUT: "全站匹配排队超时，稍后再试。",
  DISCOVERY_QUEUE_CANCELLED: "全站匹配已取消。"
};

export function formatBackendErrorMessage(data = {}, fallback = "后端请求失败") {
  return BACKEND_ERROR_MESSAGES[data.code] || data.error || fallback;
}
