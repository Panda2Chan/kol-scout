import { randomUUID } from "node:crypto";

const DISABLED_VALUES = new Set(["0", "false", "off", "silent"]);
const MAX_STRING_LENGTH = 600;
const MAX_ARRAY_LENGTH = 30;

export function createRequestLogger(scope, context = {}) {
  const startedAt = context.startedAt || Date.now();
  const requestId = context.requestId || randomUUID().slice(0, 8);
  return createLogger({ scope, requestId, startedAt, context });
}

function createLogger({ scope, requestId, startedAt, context = {} }) {
  const baseContext = sanitizeLogValue(stripLoggerInternals(context));

  function emit(level, event, fields = {}) {
    if (isLoggingDisabled()) return;

    const payload = sanitizeLogValue({
      ts: new Date().toISOString(),
      level,
      scope,
      requestId,
      event,
      elapsedMs: Date.now() - startedAt,
      ...baseContext,
      ...fields
    });
    const line = `[${scope}] ${JSON.stringify(payload)}`;

    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.info(line);
    }
  }

  return {
    requestId,
    startedAt,
    child(extraContext = {}) {
      return createLogger({
        scope,
        requestId,
        startedAt,
        context: {
          ...baseContext,
          ...extraContext
        }
      });
    },
    info(event, fields) {
      emit("info", event, fields);
    },
    warn(event, fields) {
      emit("warn", event, fields);
    },
    error(event, fields) {
      emit("error", event, fields);
    }
  };
}

function isLoggingDisabled() {
  return DISABLED_VALUES.has(String(process.env.DISCOVERY_DEBUG_LOGS || "").toLowerCase());
}

function stripLoggerInternals(context = {}) {
  const { startedAt, requestId, ...rest } = context;
  return rest;
}

function sanitizeLogValue(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      statusCode: value.statusCode,
      timeoutMs: value.timeoutMs,
      elapsedMs: value.elapsedMs
    };
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeLogValue(item, seen));
  }
  if (value instanceof Set) {
    return sanitizeLogValue([...value], seen);
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, sanitizeLogValue(entryValue, seen)])
    );
  }
  return String(value);
}
