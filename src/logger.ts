/**
 * Minimal structured logger writing to stderr.
 *
 * Why stderr: the MCP stdio transport owns stdout for the JSON-RPC protocol
 * (§12). Anything we print to stdout would corrupt the protocol stream, so
 * all human/diagnostic output must go to stderr.
 *
 * The logger also redacts anything that looks like a Metabase API key so a
 * stray log line can never leak a secret (§10: "API keys are never logged").
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const activeLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ?? "info";

/** Redact obvious secret-shaped strings from log payloads. */
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    // Metabase API keys look like `mb_....`; also redact anything assigned to a key-ish field.
    return value.replace(/mb_[A-Za-z0-9+/=_-]{8,}/g, "mb_***REDACTED***");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/api[_-]?key|secret|token|password/i.test(k)) {
        out[k] = "***REDACTED***";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel]) return;
  const line: Record<string, unknown> = {
    level,
    msg: message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
};
