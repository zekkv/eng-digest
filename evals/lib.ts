// oxlint-disable no-await-in-loop, no-console, node/no-process-env
/** Shared eval plumbing: OpenRouter calls with usage accounting, pricing, and scoring helpers.
 * The retry backoff and the bounded worker pool are sequential on purpose. */

import { LLM_MAX_TOKENS, MAX_CHARS, OPENROUTER_URL } from "#/features/digest/config";

export interface Usage {
  input: number;
  output: number;
  reasoning: number;
  cost: number;
}

export interface Call {
  data: unknown;
  text: string;
  ms: number;
  usage: Usage;
}

export interface ModelPrice {
  in: number;
  out: number;
}

export interface ChatOptions {
  model: string;
  prompt: string;
  text: string;
  effort?: string;
  temperature?: number;
  maxTokens?: number;
}

const sleep = (delay: number) => new Promise(resolve => setTimeout(resolve, delay));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One chat completion. Retries 429/5xx and transport errors; records wall time and usage. */
export async function chat(options: ChatOptions): Promise<Call> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: "system", content: options.prompt },
      { role: "user", content: options.text.slice(0, MAX_CHARS) },
    ],
    max_tokens: options.maxTokens ?? LLM_MAX_TOKENS,
    response_format: { type: "json_object" },
    usage: { include: true },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.effort !== undefined) body.reasoning = { effort: options.effort };

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(1_500 * attempt);
    const started = performance.now();
    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`status ${response.status}`);
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Some providers reject `temperature`; drop it and retry rather than fail the cell.
      if (
        response.status === 400 &&
        body.temperature !== undefined &&
        /temperature/i.test(detail)
      ) {
        delete body.temperature;
        lastError = new Error(`${options.model} rejected temperature`);
        continue;
      }
      throw new Error(
        `${options.model} failed with status ${response.status}: ${detail.slice(0, 300)}`
      );
    }
    const payload: unknown = await response.json();
    const elapsed = Math.round(performance.now() - started);
    const choices = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const content = typeof message.content === "string" ? message.content : "";
    const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};
    const details = isRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : {};
    const recorded: Usage = {
      input: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      reasoning: typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0,
      cost: typeof usage.cost === "number" ? usage.cost : 0,
    };
    if (!content) {
      lastError = new Error(
        `${options.model} returned no content (finish=${String(choice.finish_reason)} out=${recorded.output})`
      );
      continue;
    }
    let data: unknown;
    try {
      data = extractJson(content);
    } catch {
      // A malformed body is a quality result, not a transport failure: keep the raw text.
      data = undefined;
    }
    return { data, text: content, ms: elapsed, usage: recorded };
  }
  throw lastError instanceof Error ? lastError : new Error("request failed");
}

/** Take the outermost JSON object; models sometimes wrap it in prose or fences. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the brace scan.
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error("model did not return JSON");
}

/** Per-token USD prices from the OpenRouter catalog. */
export async function loadPrices(): Promise<Record<string, ModelPrice>> {
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
  });
  if (!response.ok) throw new Error(`model catalog failed with status ${response.status}`);
  const payload: unknown = await response.json();
  const rows = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const prices: Record<string, ModelPrice> = {};
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== "string" || !isRecord(row.pricing)) continue;
    const input = Number(row.pricing.prompt);
    const output = Number(row.pricing.completion);
    if (Number.isFinite(input) && Number.isFinite(output))
      prices[row.id] = { in: input, out: output };
  }
  return prices;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Numbers in a summary that also appear in the source. Catches invented figures cheaply. */
export function numberGrounding(
  summary: string,
  source: string
): { checked: number; grounded: number } {
  const sourceNumbers = new Set(
    (source.match(/\d[\d,.]*/g) ?? []).map(token => token.replace(/[.,]+$/, "").replace(/,/g, ""))
  );
  const summaryNumbers = (summary.match(/\d[\d,.]*(?:\s?%)?/g) ?? [])
    .map(token =>
      token
        .replace(/[.,]+$/, "")
        .replace(/,/g, "")
        .trim()
    )
    .filter(token => {
      const digits = token.replace(/\D/g, "");
      return digits.length >= 2 || token.endsWith("%");
    });
  const grounded = summaryNumbers.filter(token =>
    sourceNumbers.has(token.replace(/\s?%$/, ""))
  ).length;
  return { checked: summaryNumbers.length, grounded };
}

/** A fact matches when any of its regexes hits the summary text. */
export function factCoverage(
  summary: string,
  facts: ReadonlyArray<{ id: string; patterns: string[] }>
): { matched: string[]; missed: string[] } {
  const matched: string[] = [];
  const missed: string[] = [];
  for (const fact of facts) {
    if (fact.patterns.some(pattern => new RegExp(pattern, "i").test(summary)))
      matched.push(fact.id);
    else missed.push(fact.id);
  }
  return { matched, missed };
}

/** Deterministic PRNG so judge ordering is reproducible. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}

export function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

export function fixed(value: number, digits = 2): string {
  return value.toFixed(digits);
}
