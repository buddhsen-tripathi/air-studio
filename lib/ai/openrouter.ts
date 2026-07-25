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
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Reasoning effort, sent to models that support it.
 *
 * ── Why this defaults to "minimal" ────────────────────────────────────────
 * Measured against openai/gpt-5-nano on our own chart prompt:
 *
 *   default effort, 4000 tok   57.0s   3968 reasoning tokens   NO CONTENT
 *   effort "low",   4000 tok   16.7s   1536 reasoning tokens   ok
 *   effort "minimal"            5.4s      0 reasoning tokens   ok
 *
 * At default effort the model spent its ENTIRE token budget thinking and
 * returned an empty completion with finish_reason "length" — which is exactly
 * the "model returned an empty response" failure this app kept hitting, and the
 * cause of chart generation timing out.
 *
 * Our prompts do the structural thinking already: the chart prompt asks for a
 * step-string spec that is rhythmically valid by construction, and the layout
 * prompt carries the ergonomic rules explicitly. There is very little left for
 * the model to reason about, so paying 4000 tokens and a minute of latency for
 * it is pure loss. Override with OPENROUTER_REASONING_EFFORT if a future model
 * genuinely benefits.
 *
 * Models without a reasoning mode ignore the field.
 */
const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "minimal";

export function configuredReasoningEffort(): ReasoningEffort | null {
  const raw = process.env.OPENROUTER_REASONING_EFFORT?.trim().toLowerCase();
  if (raw === "off" || raw === "none") return null;
  return (REASONING_EFFORTS as readonly string[]).includes(raw ?? "")
    ? (raw as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

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

/** Shape of the bits of the OpenRouter response we actually read. */
interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    native_finish_reason?: string;
    message?: {
      // Models variously return a string, or content parts, or nothing at all
      // with the text in `reasoning`.
      content?: string | { type?: string; text?: string }[] | null;
      reasoning?: string | null;
    };
  }[];
  error?: { message?: string; code?: number };
  usage?: { completion_tokens?: number };
}

export async function chat(opts: ChatOptions): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set", 503);
  }

  const first = await callOnce(apiKey, opts, opts.json ?? false);
  if (first.text) return first.text;

  // Empty content is almost always one of three things, and they need different
  // fixes — so diagnose rather than reporting a bare "empty response".
  if (first.finishReason === "length") {
    throw new OpenRouterError(
      `Model "${configuredModel()}" hit the token limit before emitting any content ` +
        `(${first.completionTokens ?? 0} completion tokens used, reasoning effort ` +
        `"${configuredReasoningEffort() ?? "off"}"). Its thinking consumed the whole ` +
        `budget — lower OPENROUTER_REASONING_EFFORT or raise maxTokens.`,
      502,
    );
  }

  if (opts.json) {
    // Some models on OpenRouter accept `response_format: json_object` and then
    // return nothing rather than erroring. Retry once without it; the prompts
    // already demand raw JSON, and extractJson tolerates prose or fences.
    const retry = await callOnce(apiKey, opts, false);
    if (retry.text) return retry.text;
    if (retry.finishReason === "length") {
      throw new OpenRouterError(
        `Model "${configuredModel()}" ran out of tokens before producing content.`,
        502,
      );
    }
  }

  const hint = first.hadReasoning
    ? ` The model emitted reasoning but no answer content, which usually means it is a reasoning model that needs a larger token budget.`
    : ` Check that "${configuredModel()}" is a valid OpenRouter slug that supports chat completions.`;

  throw new OpenRouterError(
    `Model "${configuredModel()}" returned an empty response` +
      (first.finishReason ? ` (finish_reason: ${first.finishReason}).` : ".") +
      hint,
    502,
  );
}

interface CallResult {
  text: string | null;
  finishReason?: string;
  hadReasoning: boolean;
  completionTokens?: number;
}

async function callOnce(
  apiKey: string,
  opts: ChatOptions,
  useJsonFormat: boolean,
): Promise<CallResult> {
  // Compose the caller's signal with our own timeout so a hung upstream cannot
  // pin a serverless invocation open indefinitely.
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;

  const effort = configuredReasoningEffort();

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
        ...(effort ? { reasoning: { effort } } : {}),
        ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
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

  const data = (await response.json()) as ChatCompletion;

  if (data.error) {
    throw new OpenRouterError(data.error.message ?? "Unknown model error", 502);
  }

  const choice = data.choices?.[0];
  const message = choice?.message;
  const text = normalizeContent(message?.content);

  return {
    text: text && text.trim() ? text : null,
    finishReason: choice?.finish_reason ?? choice?.native_finish_reason,
    hadReasoning: Boolean(message?.reasoning?.trim()),
    completionTokens: data.usage?.completion_tokens,
  };
}

/** `content` may be a plain string or an array of content parts. */
function normalizeContent(
  content: string | { type?: string; text?: string }[] | null | undefined,
): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return null;
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
