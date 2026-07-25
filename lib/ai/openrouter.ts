import "server-only";

/**
 * Thin OpenRouter client.
 *
 * Key and model both come from the environment so neither is baked into the
 * build and the model can be swapped without a code change:
 *
 *   OPENROUTER_API_KEY=sk-or-v1-...
 *   OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
 *
 * This module is server-only. The key must never reach the browser, which is
 * the main reason the AI features live behind route handlers.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const DEFAULT_TIMEOUT_MS = 45_000;

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export function isConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export function configuredModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the model to emit a single JSON object. */
  json?: boolean;
  signal?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set", 503);
  }

  // Compose the caller's signal with our own timeout so a hung upstream cannot
  // pin a serverless invocation open indefinitely.
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional OpenRouter attribution headers.
        "HTTP-Referer":
          process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_SITE_NAME || "Air Studio",
      },
      body: JSON.stringify({
        model: configuredModel(),
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2000,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new OpenRouterError("Model request timed out", 504);
    }
    throw new OpenRouterError(
      `Could not reach OpenRouter: ${(err as Error).message}`,
      502,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new OpenRouterError(
      `OpenRouter returned ${response.status}: ${truncate(detail, 300)}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error) {
    throw new OpenRouterError(data.error.message ?? "Unknown model error", 502);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new OpenRouterError("Model returned an empty response", 502);
  }
  return content;
}

/**
 * Pull a JSON object out of a model response.
 *
 * Even with response_format set, models on OpenRouter vary: some wrap the
 * object in ```json fences, some prepend a sentence. Rather than trusting the
 * format flag, we locate the outermost balanced object and parse that.
 */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();

  const direct = tryParse<T>(trimmed);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    const parsed = tryParse<T>(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const start = trimmed.indexOf("{");
  if (start !== -1) {
    // Walk forward tracking depth, ignoring braces inside string literals.
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const parsed = tryParse<T>(trimmed.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }

  throw new OpenRouterError("Model did not return parseable JSON", 502);
}

function tryParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
