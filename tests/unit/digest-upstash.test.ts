// oxlint-disable node/no-process-env
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadCache,
  saveCache,
  upstashConfigured,
  withCacheLock,
} from "#/features/digest/store.server";
import type { DigestCache } from "#/features/digest/types";

const UPSTASH_URL = "https://diverse-panda-12345.upstash.io";
const TOKEN = "test-upstash-token";
const ALT_URL = "https://other-panda-67890.upstash.io";
const ALT_TOKEN = "test-alt-token";

const ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VERCEL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

// The official SDK, faked. It records construction configs and get/set calls.
// Each test defines results or errors.
const sdk = vi.hoisted(() => {
  const state: {
    configs: unknown[];
    getCalls: string[];
    setCalls: [string, unknown][];
    getResult: unknown;
    getError: Error | null;
    setError: Error | null;
  } = {
    configs: [],
    getCalls: [],
    setCalls: [],
    getResult: null,
    getError: null,
    setError: null,
  };
  class FakeRedis {
    constructor(config: unknown) {
      state.configs.push(config);
    }
    async get(key: string): Promise<unknown> {
      state.getCalls.push(key);
      if (state.getError) throw state.getError;
      return state.getResult;
    }
    async set(key: string, value: unknown): Promise<"OK"> {
      state.setCalls.push([key, value]);
      if (state.setError) throw state.setError;
      return "OK";
    }
  }
  return { state, FakeRedis };
});

vi.mock("@upstash/redis", () => ({ Redis: sdk.FakeRedis }));

function cache(overrides: Partial<DigestCache> = {}): DigestCache {
  return {
    fetchedAt: 42,
    articles: [{ url: "https://example.com/a", title: "t", blog: "B", published: 1, blurb: "" }],
    summaries: {},
    feeds: [{ name: "B", ok: true, count: 1 }],
    ...overrides,
  };
}

function emptyCache() {
  return {
    fetchedAt: 0,
    articles: [],
    summaries: {},
    feeds: [],
    lastDaily: undefined,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  sdk.state.configs = [];
  sdk.state.getCalls = [];
  sdk.state.setCalls = [];
  sdk.state.getResult = null;
  sdk.state.getError = null;
  sdk.state.setError = null;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function withKvPair() {
  process.env.KV_REST_API_URL = UPSTASH_URL;
  process.env.KV_REST_API_TOKEN = TOKEN;
}

/** Await a promise that must reject, returning the error for assertions. */
async function rejectsWith(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error("expected the promise to reject");
}

describe("Upstash cache", () => {
  it("constructs the SDK with the configured credentials and deserialization off", async () => {
    withKvPair();
    sdk.state.getResult = JSON.stringify(cache());

    await loadCache();
    expect(sdk.state.configs).toEqual([
      { url: UPSTASH_URL, token: TOKEN, automaticDeserialization: false },
    ]);
  });

  it("reads and validates the blob from key cache", async () => {
    withKvPair();
    const expected = cache();
    sdk.state.getResult = JSON.stringify(expected);

    await expect(loadCache()).resolves.toEqual(expected);
    expect(sdk.state.getCalls).toEqual(["cache"]);
  });

  it("prefers the KV_ pair when both pairs are set", async () => {
    process.env.KV_REST_API_URL = UPSTASH_URL;
    process.env.KV_REST_API_TOKEN = TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = ALT_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = ALT_TOKEN;
    sdk.state.getResult = JSON.stringify(cache());

    await loadCache();
    expect(sdk.state.configs).toEqual([
      { url: UPSTASH_URL, token: TOKEN, automaticDeserialization: false },
    ]);
  });

  it("accepts Upstash's own UPSTASH_ names", async () => {
    process.env.UPSTASH_REDIS_REST_URL = ALT_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = ALT_TOKEN;
    const expected = cache();
    sdk.state.getResult = JSON.stringify(expected);

    await expect(loadCache()).resolves.toEqual(expected);
    expect(sdk.state.configs).toEqual([
      { url: ALT_URL, token: ALT_TOKEN, automaticDeserialization: false },
    ]);
  });

  it("falls back to UPSTASH_ credentials when KV_REST_API_URL is an empty string", async () => {
    process.env.KV_REST_API_URL = "";
    process.env.KV_REST_API_TOKEN = "";
    process.env.UPSTASH_REDIS_REST_URL = ALT_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = ALT_TOKEN;
    const expected = cache();
    sdk.state.getResult = JSON.stringify(expected);

    expect(upstashConfigured()).toBe(true);
    await expect(loadCache()).resolves.toEqual(expected);
    expect(sdk.state.configs).toEqual([
      { url: ALT_URL, token: ALT_TOKEN, automaticDeserialization: false },
    ]);
  });

  it.each([
    ["missing", null],
    ["junk", "{oops"],
    ["non-object", "42"],
  ])("heals a %s blob to an empty cache", async (_label, payload) => {
    withKvPair();
    sdk.state.getResult = payload;

    await expect(loadCache()).resolves.toEqual(emptyCache());
  });

  it("wraps read failures and redacts the token", async () => {
    withKvPair();
    sdk.state.getError = new Error(`401 unauthenticated for token ${TOKEN}`);

    const error = await rejectsWith(loadCache());
    expect(error.message).toMatch(/Upstash read failed/);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(TOKEN);
  });

  it("writes the cache as one blob to key cache", async () => {
    withKvPair();
    const expected = cache();

    await saveCache(expected);
    expect(sdk.state.setCalls).toEqual([["cache", JSON.stringify(expected)]]);
  });

  it("wraps write failures and redacts the token", async () => {
    withKvPair();
    sdk.state.setError = new Error(`write rejected (token ${TOKEN})`);

    const error = await rejectsWith(saveCache(cache()));
    expect(error.message).toMatch(/Upstash write failed/);
    expect(error.message).not.toContain(TOKEN);
  });

  it("runs locked sections as a passthrough", async () => {
    withKvPair();

    await expect(withCacheLock(async () => "ok")).resolves.toBe("ok");
  });
});

describe("Vercel without Upstash", () => {
  it("throws a loud configuration error instead of touching the filesystem", async () => {
    process.env.VERCEL = "1";

    await expect(loadCache()).rejects.toThrow(/Upstash/);
    await expect(saveCache(cache())).rejects.toThrow(/ephemeral on Vercel/);
    await expect(withCacheLock(async () => "ok")).rejects.toThrow(/Upstash/);
    expect(sdk.state.configs).toEqual([]);
    expect(sdk.state.getCalls).toEqual([]);
    expect(sdk.state.setCalls).toEqual([]);
  });
});

describe("local without Upstash", () => {
  it("falls through to the filesystem backend", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "digest-upstash-"));
    const file = path.join(dir, "cache.json");

    try {
      await expect(loadCache(file)).resolves.toEqual(emptyCache());
      const expected = cache();
      await withCacheLock(async () => saveCache(expected, file));
      await expect(loadCache(file)).resolves.toEqual(expected);
      expect(sdk.state.configs).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
