// oxlint-disable node/no-process-env
import {
  DEFAULT_MODEL,
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  MAX_CHARS,
  OPENROUTER_URL,
  TAVILY_EXTRACT_URL,
  TAVILY_TIMEOUT_MS,
} from "#/features/digest/config";

/** 401/403 from an upstream provider. Retrying the rest of the run cannot help. */
export class UpstreamAuthError extends Error {}

function throwForStatus(what: string, status: number): never {
  if (status === 401 || status === 403) {
    throw new UpstreamAuthError(`${what} rejected the API key (status ${status})`);
  }
  throw new Error(`${what} failed with status ${status}`);
}

/** Models sometimes wrap JSON in fences or prose. Take the outermost object. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the outermost-braces scan below.
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Report the friendly error below, not the slice's SyntaxError.
    }
  }
  throw new Error("model did not return JSON");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  action: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`${action} failed: ${messageOf(error)}`, { cause: error });
  }
  if (!response.ok) throwForStatus(action, response.status);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${action} failed: invalid json response (${messageOf(error)})`, {
      cause: error,
    });
  }
}

export type ChatCompletion = (prompt: string, text: string) => Promise<unknown>;

/** OpenAI-compatible chat call. It resolves to parsed JSON. */
export async function completeJson(prompt: string, text: string): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const model = process.env.DIGEST_MODEL?.trim() || DEFAULT_MODEL;
  const data = await postJson(
    OPENROUTER_URL,
    apiKey,
    {
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text.slice(0, MAX_CHARS) },
      ],
      temperature: 0.3,
      max_tokens: LLM_MAX_TOKENS,
      response_format: { type: "json_object" },
      // muse-spark is a reasoning model. Capping effort keeps the reasoning spend low
      // without hurting summary quality. Measurements show 500 or more reasoning tokens even for trivia.
      reasoning: { effort: "low" },
    },
    LLM_TIMEOUT_MS,
    "LLM request"
  );
  const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content = typeof message.content === "string" ? message.content : "";
  if (!content) {
    throw new Error("LLM returned no content");
  }
  return extractJson(content);
}

/** Page text through Tavily extract. It throws a readable Error when the text is missing. */
export async function extractPageText(url: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY is not set");
  const data = await postJson(
    TAVILY_EXTRACT_URL,
    apiKey,
    { urls: [url] },
    TAVILY_TIMEOUT_MS,
    `extract for ${url}`
  );
  const results = isRecord(data) && Array.isArray(data.results) ? data.results : [];
  const first = isRecord(results[0]) ? results[0] : {};
  const raw = typeof first.raw_content === "string" ? first.raw_content : "";
  if (!raw) {
    throw new Error(`could not extract article text from ${url}`);
  }
  return raw;
}
