// oxlint-disable no-console, node/no-process-env
/** Eval runner for the digest LLM work.
 *
 *   bun evals/run.ts picker --stage screen     # model x reasoning-effort sweep
 *   bun evals/run.ts picker --stage prompts    # prompt variants on chosen configs
 *   bun evals/run.ts summary --stage screen
 *   bun evals/run.ts summary --stage prompts --configs a,b
 *
 * Every call is recorded with wall time, token counts, and OpenRouter cost. Results land in
 * evals/results/<suite>-<stage>-<stamp>.json and a readable .md table beside it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { normalizeSummary, pickKey } from "#/features/digest/pipeline.server";
import {
  chat,
  factCoverage,
  fixed,
  loadPrices,
  mapLimit,
  mean,
  formatMs,
  numberGrounding,
  p95,
  ratio,
  seededShuffle,
  usd,
} from "./lib";
import type { Call } from "./lib";
import { SELECT_VARIANTS, SUMMARY_VARIANTS } from "./prompts";

const ROOT = path.resolve(import.meta.dir, "..");
const DATA = path.join(ROOT, "evals", "data");
const RESULTS = path.join(ROOT, "evals", "results");
const CONCURRENCY = 4;
const PICK_COUNT = 10;

interface PoolCandidate {
  url: string;
  title: string;
  blog: string;
  blurb: string;
  published: number;
  source: string;
}

interface Pool {
  id: string;
  candidates: PoolCandidate[];
}

interface PoolLabel {
  url: string;
  why: string;
}

interface Labels {
  pools: Record<
    string,
    { picks: PoolLabel[]; traps: PoolLabel[]; topics: { id: string; urls: string[] }[] }
  >;
}

interface Fact {
  id: string;
  patterns: string[];
}

interface SummaryCase {
  id: string;
  title: string;
  url: string;
  text: string;
  facts: Fact[];
}

const pools: Pool[] = JSON.parse(readFileSync(path.join(DATA, "pools.json"), "utf8")).pools;
const labels: Labels = JSON.parse(readFileSync(path.join(DATA, "labels.json"), "utf8"));
const cases: SummaryCase[] = JSON.parse(
  readFileSync(path.join(DATA, "summary-cases.json"), "utf8")
).cases;

/** Article bodies are not committed: they are third-party content and large. They are
 * re-fetched with `--extract-texts` and cached under the gitignored data/text/ folder. */
const textCache = new Map<string, string>();

function caseTextOf(item: SummaryCase): string {
  const cached = textCache.get(item.id);
  if (cached !== undefined) return cached;
  const file = path.join(DATA, item.text);
  if (!existsSync(file)) {
    throw new Error(`missing ${item.text}. Run: bun evals/run.ts --extract-texts`);
  }
  const text = readFileSync(file, "utf8");
  textCache.set(item.id, text);
  return text;
}

const PickerResponse = z.object({ picked: z.array(z.string()).optional() });
const JudgeResponse = z.object({
  scores: z
    .array(
      z.object({
        id: z.string(),
        accuracy: z.number().catch(0),
        coverage: z.number().catch(0),
        clarity: z.number().catch(0),
        jargon: z.number().catch(0),
        calibration: z.number().catch(0),
      })
    )
    .default([]),
  ranking: z.array(z.string()).default([]),
});

interface Config {
  id: string;
  model: string;
  effort?: string;
}

function config(model: string, effort?: string): Config {
  return { id: `${model}#${effort ?? "none"}`, model, effort };
}

/** Picker screen: cheap models that could plausibly run the daily job, across reasoning effort. */
const PICKER_SCREEN: Config[] = [
  "meta/muse-spark-1.3-contributor",
  "deepseek/deepseek-v4.1-flash",
  "z-ai/glm-5.3-flash",
  "google/gemini-3.8-flash",
  "openai/gpt-5.6-luna",
  "anthropic/claude-haiku-5.5",
].flatMap(model => ["low", "medium", "high"].map(effort => config(model, effort)));

/** Summary screen starts from the shipped model at each effort plus one alternative. */
const SUMMARY_SCREEN: Config[] = [
  config("meta/muse-spark-1.3-contributor", "low"),
  config("meta/muse-spark-1.3-contributor", "medium"),
  config("meta/muse-spark-1.3-contributor", "high"),
  config("deepseek/deepseek-v4.1-flash", "high"),
  config("google/gemini-3.8-flash", "high"),
];

function parseArgs(argv: string[]): {
  suite: string;
  stage: string;
  configs?: string[];
  repeats: number;
  judge: boolean;
} {
  const [suite = "picker", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    if (inline !== undefined) flags.set(key, inline);
    else if (rest.length > index + 1 && !rest[index + 1].startsWith("--")) {
      flags.set(key, rest[index + 1]);
      index += 1;
    } else flags.set(key, "true");
  }
  return {
    suite,
    stage: flags.get("stage") ?? "screen",
    configs: flags.get("configs")?.split(",").filter(Boolean),
    repeats: Number(flags.get("repeats") ?? 2),
    judge: flags.get("judge") !== "false",
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** Fail fast when a label points at a URL that is not in its pool, or is both pick and trap. */
function assertDataset(): void {
  for (const pool of pools) {
    const urls = new Set(pool.candidates.map(item => item.url));
    if (!Object.hasOwn(labels.pools, pool.id)) throw new Error(`missing labels for ${pool.id}`);
    const label = labels.pools[pool.id];
    const picks = new Set(label.picks.map(item => item.url));
    const traps = new Set(label.traps.map(item => item.url));
    for (const entry of label.picks) {
      if (!urls.has(entry.url))
        throw new Error(`${pool.id}: labeled url not in pool: ${entry.url}`);
      if (traps.has(entry.url))
        throw new Error(`${pool.id}: url is both pick and trap: ${entry.url}`);
    }
    for (const entry of label.traps) {
      if (!urls.has(entry.url))
        throw new Error(`${pool.id}: labeled url not in pool: ${entry.url}`);
    }
    if (picks.size !== label.picks.length) throw new Error(`${pool.id}: duplicate pick labels`);
    if (traps.size !== label.traps.length) throw new Error(`${pool.id}: duplicate trap labels`);
    if (picks.size + traps.size > pool.candidates.length) {
      throw new Error(`${pool.id}: more labels than candidates`);
    }
  }
}

function selectConfigs(requested: string[] | undefined, defaults: Config[]): Config[] {
  if (!requested) return defaults;
  return requested.map(id => {
    const [model, effort] = id.split("#");
    if (!model) throw new Error(`bad config id: ${id}`);
    return config(model, effort === "none" || !effort ? undefined : effort);
  });
}

// ---------------------------------------------------------------- picker suite

interface PickAttempt {
  configId: string;
  promptId: string;
  poolId: string;
  repeat: number;
  call: Call;
  picked: string[];
  final: string[];
  underPicked: number;
  hallucinated: number;
  gold: number;
  trap: number;
  goldTotal: number;
  blogs: number;
  dupTopics: number;
  valid: boolean;
}

function candidateListing(pool: Pool): string {
  return pool.candidates
    .map(item => `- ${item.url} | ${item.blog}: ${item.title} — ${item.blurb.slice(0, 180)}`)
    .join("\n");
}

function scorePicks(
  pool: Pool,
  raw: string[]
): Omit<PickAttempt, "configId" | "promptId" | "poolId" | "repeat" | "call"> {
  const byKey = new Map(pool.candidates.map(item => [pickKey(item.url), item.url]));
  const label = labels.pools[pool.id];
  const gold = new Set(label.picks.map(item => item.url));
  const traps = new Set(label.traps.map(item => item.url));
  // Match the way selectInteresting does, so the eval measures production behaviour.
  const picked = [
    ...new Set(
      raw.map(url => byKey.get(pickKey(url))).filter((url): url is string => url !== undefined)
    ),
  ];
  const hallucinated = raw.filter(url => !byKey.has(pickKey(url))).length;
  const usable = picked.slice(0, PICK_COUNT);
  const underPicked = Math.max(0, PICK_COUNT - usable.length);
  // Production tops a short list up with the newest remaining candidates; score what users see.
  const final = [...usable];
  if (final.length < PICK_COUNT) {
    const seen = new Set(final);
    for (const item of pool.candidates) {
      if (final.length >= PICK_COUNT) break;
      if (!seen.has(item.url)) {
        final.push(item.url);
        seen.add(item.url);
      }
    }
  }
  const topicOf = new Map<string, string>();
  for (const topic of label.topics) for (const url of topic.urls) topicOf.set(url, topic.id);
  const topicCounts = new Map<string, number>();
  for (const url of final) {
    const topic = topicOf.get(url);
    if (topic) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  const dupTopics = [...topicCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0
  );
  const blogOf = new Map(pool.candidates.map(item => [item.url, item.blog]));
  return {
    picked,
    final,
    underPicked,
    hallucinated,
    gold: final.filter(url => gold.has(url)).length,
    trap: final.filter(url => traps.has(url)).length,
    goldTotal: gold.size,
    blogs: new Set(final.map(url => blogOf.get(url))).size,
    dupTopics,
    valid: picked.length > 0 && hallucinated === 0,
  };
}

async function runPicker(
  configs: Config[],
  variants: typeof SELECT_VARIANTS,
  repeats: number
): Promise<PickAttempt[]> {
  const jobs = configs.flatMap(cfg =>
    variants.flatMap(variant =>
      pools.flatMap(pool =>
        Array.from({ length: repeats }, (_, repeat) => ({ cfg, variant, pool, repeat }))
      )
    )
  );
  console.log(
    `picker: ${configs.length} configs x ${variants.length} prompts x ${pools.length} pools x ${repeats} repeats = ${jobs.length} calls`
  );
  let done = 0;
  const results = await mapLimit(jobs, CONCURRENCY, async job => {
    const prompt = job.variant.text.replace("{n}", String(PICK_COUNT));
    let call: Call;
    try {
      call = await chat({
        model: job.cfg.model,
        effort: job.cfg.effort,
        prompt,
        text: candidateListing(job.pool),
        temperature: 0.3,
      });
    } catch (error) {
      call = {
        data: undefined,
        text: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
        ms: 0,
        usage: { input: 0, output: 0, reasoning: 0, cost: 0 },
      };
    }
    done += 1;
    if (done % 20 === 0) console.log(`  ${done}/${jobs.length}`);
    const parsed = PickerResponse.safeParse(call.data);
    const raw = parsed.success ? (parsed.data.picked ?? []) : [];
    return {
      configId: job.cfg.id,
      promptId: job.variant.id,
      poolId: job.pool.id,
      repeat: job.repeat,
      call,
      ...scorePicks(job.pool, raw),
    };
  });
  return results;
}

function pickerTable(rows: PickAttempt[]): string {
  const keys = [...new Set(rows.map(row => `${row.configId} | ${row.promptId}`))];
  const lines = [
    "| config | prompt | utility | precision | recall | trap% | blogs | dup | under | valid | ms p50 | tok out | $/call |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const key of keys) {
    const group = rows.filter(row => `${row.configId} | ${row.promptId}` === key);
    const utility = mean(group.map(row => ratio(row.gold - row.trap, PICK_COUNT)));
    const precision = mean(group.map(row => ratio(row.gold, PICK_COUNT)));
    const recall = mean(group.map(row => ratio(row.gold, Math.min(PICK_COUNT, row.goldTotal))));
    const trap = mean(group.map(row => ratio(row.trap, PICK_COUNT)));
    const blogs = mean(group.map(row => ratio(row.blogs, PICK_COUNT)));
    const dup = mean(group.map(row => row.dupTopics));
    const under = mean(group.map(row => row.underPicked));
    const valid = mean(group.map(row => (row.valid ? 1 : 0)));
    const latency = p95(group.map(row => row.call.ms));
    const out = mean(group.map(row => row.call.usage.output));
    const cost = mean(group.map(row => row.call.usage.cost));
    const [configId, promptId] = key.split(" | ");
    lines.push(
      `| ${configId} | ${promptId} | ${fixed(utility)} | ${fixed(precision)} | ${fixed(recall)} | ${fixed(trap)} | ${fixed(blogs)} | ${fixed(dup)} | ${fixed(under, 1)} | ${fixed(valid)} | ${formatMs(latency)} | ${Math.round(out)} | ${usd(cost)} |`
    );
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- summary suite

interface SummaryAttempt {
  configId: string;
  promptId: string;
  caseId: string;
  repeat: number;
  call: Call;
  valid: boolean;
  summary: {
    tldr: string;
    keyPoints: string[];
    jargon: { term: string; explanation: string }[];
    difficulty: string;
  } | null;
  factsMatched: number;
  factsTotal: number;
  missed: string[];
  grounding: { checked: number; grounded: number };
  jargonGrounded: number;
  jargonTotal: number;
  tldrSentences: number;
  keyPointCount: number;
  metaOpener: boolean;
  judge: Record<string, number> | null;
  judgeRank: number | null;
  judgeId?: string;
}

const SENTENCE_END = /[.!?](?:\s|$)/g;

function countSentences(text: string): number {
  return (text.match(SENTENCE_END) ?? []).length;
}

async function runSummary(
  configs: Config[],
  variants: typeof SUMMARY_VARIANTS,
  repeats: number
): Promise<SummaryAttempt[]> {
  const jobs = configs.flatMap(cfg =>
    variants.flatMap(variant =>
      cases.flatMap(item =>
        Array.from({ length: repeats }, (_, repeat) => ({ cfg, variant, item, repeat }))
      )
    )
  );
  console.log(
    `summary: ${configs.length} configs x ${variants.length} prompts x ${cases.length} cases x ${repeats} repeats = ${jobs.length} calls`
  );
  let done = 0;
  return mapLimit(jobs, CONCURRENCY, async job => {
    const source = caseTextOf(job.item);
    let call: Call;
    try {
      call = await chat({
        model: job.cfg.model,
        effort: job.cfg.effort,
        prompt: job.variant.text,
        text: `Title: ${job.item.title}\n\nTEXT:\n${source}`,
        temperature: 0.3,
      });
    } catch (error) {
      call = {
        data: undefined,
        text: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
        ms: 0,
        usage: { input: 0, output: 0, reasoning: 0, cost: 0 },
      };
    }
    done += 1;
    if (done % 10 === 0) console.log(`  ${done}/${jobs.length}`);
    let summary: SummaryAttempt["summary"] = null;
    try {
      const normalized = normalizeSummary(call.data, job.cfg.model);
      summary = {
        tldr: normalized.tldr,
        keyPoints: normalized.keyPoints,
        jargon: normalized.jargon,
        difficulty: normalized.difficulty,
      };
    } catch {
      summary = null;
    }
    const base = {
      configId: job.cfg.id,
      promptId: job.variant.id,
      caseId: job.item.id,
      repeat: job.repeat,
      call,
      summary,
      judge: null,
      judgeRank: null,
    };
    if (!summary) {
      return {
        ...base,
        valid: false,
        factsMatched: 0,
        factsTotal: job.item.facts.length,
        missed: job.item.facts.map(fact => fact.id),
        grounding: { checked: 0, grounded: 0 },
        jargonGrounded: 0,
        jargonTotal: 0,
        tldrSentences: 0,
        keyPointCount: 0,
        metaOpener: false,
      };
    }
    const body = [summary.tldr, ...summary.keyPoints].join("\n");
    const facts = factCoverage(body, job.item.facts);
    const lowerSource = source.toLowerCase();
    const jargonGrounded = summary.jargon.filter(entry =>
      lowerSource.includes(entry.term.toLowerCase())
    ).length;
    return {
      ...base,
      valid: true,
      factsMatched: facts.matched.length,
      factsTotal: job.item.facts.length,
      missed: facts.missed,
      grounding: numberGrounding(body, source),
      jargonGrounded,
      jargonTotal: summary.jargon.length,
      tldrSentences: countSentences(summary.tldr),
      keyPointCount: summary.keyPoints.length,
      metaOpener: /^(this (post|article|blog|piece)|the (post|article|author|blog))/i.test(
        summary.tldr
      ),
    };
  });
}

const JUDGE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** The catalog lists max/high/low/none for this model; max is its highest effort. */
const JUDGE_EFFORT = "max";

const JUDGE_PROMPT = `You grade summaries of one engineering blog post for a specific reader: a backend-leaning generalist developer who understands the basics but is new to advanced topics. The reader wants to decide whether to read the post and to learn the hard parts from the summary.

You get the article text and several anonymous summaries. Each summary has tldr (2-4 sentences), key_points, jargon (term/explanation pairs), and difficulty.

Score every summary 1-5 on each axis:
- accuracy: claims match the article; no invented facts, numbers, or emphasis the article does not make
- coverage: the most important technical content and the main result are captured
- clarity: plain language a generalist can follow; concrete rather than vague; no filler or meta-commentary
- jargon: only genuinely hard terms, each explained correctly and usefully; empty is fine when the post is easy
- calibration: the difficulty label matches how hard the post actually is for this reader

Then rank the summaries from best to worst and name the best one.

Return ONLY valid JSON:
{"scores":[{"id":"A","accuracy":4,"coverage":3,"clarity":5,"jargon":4,"calibration":5,"note":"<=15 words"}],"ranking":["A","C","B"],"best":"A"}`;

async function judgeSummaries(attempts: SummaryAttempt[]): Promise<void> {
  const groups = new Map<string, SummaryAttempt[]>();
  for (const attempt of attempts) {
    if (!attempt.summary) continue;
    const key = `${attempt.caseId}#${attempt.repeat}`;
    const list = groups.get(key) ?? [];
    list.push(attempt);
    groups.set(key, list);
  }
  const jobs = [...groups.entries()];
  console.log(
    `judge: ${jobs.length} calls over ${attempts.filter(item => item.summary).length} summaries (${JUDGE_MODEL})`
  );
  await mapLimit(jobs, 2, async ([key, group]) => {
    const [caseId] = key.split("#");
    const item = cases.find(entry => entry.id === caseId);
    if (!item) return;
    const seed = key.split("").reduce((sum, char) => sum + char.charCodeAt(0), 17);
    const ordered = seededShuffle(group, seed);
    const blocks = ordered.map((attempt, index) => {
      const id = String.fromCharCode(65 + index);
      attempt.judgeId = id;
      const summary = attempt.summary;
      return `### ${id}\ntldr: ${summary?.tldr}\nkey_points:\n${summary?.keyPoints.map(point => `- ${point}`).join("\n")}\njargon: ${summary?.jargon.map(entry => `${entry.term}: ${entry.explanation}`).join(" | ") || "(none)"}\ndifficulty: ${summary?.difficulty || "(none)"}`;
    });
    const text = `ARTICLE TITLE: ${item.title}\n\nARTICLE TEXT:\n${caseTextOf(item).slice(0, 40_000)}\n\nSUMMARIES:\n${blocks.join("\n\n")}`;
    let call: Call;
    try {
      call = await chat({
        model: JUDGE_MODEL,
        effort: JUDGE_EFFORT,
        prompt: JUDGE_PROMPT,
        text,
        maxTokens: 24_000,
      });
    } catch (error) {
      console.log(
        `  judge failed for ${key}: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    const parsed = JudgeResponse.safeParse(call.data);
    if (!parsed.success) {
      console.log(`  judge returned no usable JSON for ${key}`);
      return;
    }
    const byId = new Map(parsed.data.scores.map(row => [row.id, row]));
    for (const attempt of ordered) {
      const row = byId.get(attempt.judgeId ?? "");
      if (!row) continue;
      attempt.judge = {
        accuracy: row.accuracy,
        coverage: row.coverage,
        clarity: row.clarity,
        jargon: row.jargon,
        calibration: row.calibration,
      };
      const rank = parsed.data.ranking.indexOf(attempt.judgeId ?? "") + 1;
      attempt.judgeRank = rank > 0 ? rank : null;
    }
  });
}

function summaryAxisTable(rows: SummaryAttempt[]): string {
  const keys = [...new Set(rows.map(row => `${row.configId} | ${row.promptId}`))];
  const lines = [
    "| config | prompt | accuracy | coverage | clarity | jargon | calibration |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const key of keys) {
    const judged = rows.filter(row => `${row.configId} | ${row.promptId}` === key && row.judge);
    const axis = (name: string) => mean(judged.map(row => row.judge?.[name] ?? 0));
    const [configId, promptId] = key.split(" | ");
    lines.push(
      `| ${configId} | ${promptId} | ${fixed(axis("accuracy"), 2)} | ${fixed(axis("coverage"), 2)} | ${fixed(axis("clarity"), 2)} | ${fixed(axis("jargon"), 2)} | ${fixed(axis("calibration"), 2)} |`
    );
  }
  return lines.join("\n");
}

function summaryTable(rows: SummaryAttempt[]): string {
  const keys = [...new Set(rows.map(row => `${row.configId} | ${row.promptId}`))];
  const lines = [
    "| config | prompt | valid | facts | grounded | jargon ok | schema | judge | rank | ms p50 | tok out | $/call |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const key of keys) {
    const group = rows.filter(row => `${row.configId} | ${row.promptId}` === key);
    const judged = group.filter(row => row.judge);
    const judgeMean = judged.length
      ? mean(judged.map(row => mean(Object.values(row.judge ?? {}))))
      : 0;
    const rank = judged.length ? mean(judged.map(row => row.judgeRank ?? 0)) : 0;
    const facts = mean(group.map(row => ratio(row.factsMatched, row.factsTotal)));
    const grounding = mean(group.map(row => ratio(row.grounding.grounded, row.grounding.checked)));
    const jargon = mean(group.map(row => ratio(row.jargonGrounded, Math.max(1, row.jargonTotal))));
    const schema = mean(
      group.map(row =>
        row.valid &&
        row.tldrSentences >= 2 &&
        row.tldrSentences <= 4 &&
        row.keyPointCount >= 3 &&
        row.keyPointCount <= 6 &&
        !row.metaOpener
          ? 1
          : 0
      )
    );
    const latency = p95(group.map(row => row.call.ms));
    const out = mean(group.map(row => row.call.usage.output));
    const cost = mean(group.map(row => row.call.usage.cost));
    const [configId, promptId] = key.split(" | ");
    lines.push(
      `| ${configId} | ${promptId} | ${fixed(mean(group.map(row => (row.valid ? 1 : 0))))} | ${fixed(facts)} | ${fixed(grounding)} | ${fixed(jargon)} | ${fixed(schema)} | ${fixed(judgeMean, 2)} | ${fixed(rank, 1)} | ${formatMs(latency)} | ${Math.round(out)} | ${usd(cost)} |`
    );
  }
  return lines.join("\n");
}

function projectionTable(
  rows: PickAttempt[],
  prices: Record<string, { in: number; out: number } | undefined>
): string {
  const keys = [...new Set(rows.map(row => `${row.configId} | ${row.promptId}`))];
  const lines = [
    "| config | prompt | pick ms | pick $ | summary $ x10 | daily run $ |",
    "|---|---|---|---|---|---|",
  ];
  for (const key of keys) {
    const group = rows.filter(row => `${row.configId} | ${row.promptId}` === key);
    const [configId] = key.split(" | ");
    const model = configId.split("#")[0];
    const price = prices[model];
    const pickMs = p95(group.map(row => row.call.ms));
    const pickCost = mean(group.map(row => row.call.usage.cost));
    // A daily run is one picker call plus ten summaries at ~3k in / 700 out tokens.
    const summaryCost = price ? 10 * (3_000 * price.in + 700 * price.out) : 0;
    lines.push(
      `| ${configId} | ${key.split(" | ")[1]} | ${formatMs(pickMs)} | ${usd(pickCost)} | ${usd(summaryCost)} | ${usd(pickCost + summaryCost)} |`
    );
  }
  return lines.join("\n");
}

function writeReport(name: string, body: string, payload: unknown): string {
  mkdirSync(RESULTS, { recursive: true });
  const base = path.join(RESULTS, `${name}-${stamp()}`);
  writeFileSync(`${base}.json`, JSON.stringify(payload, null, 1));
  writeFileSync(`${base}.md`, body);
  return base;
}

async function main(): Promise<void> {
  assertDataset();
  if (process.argv.includes("--extract-texts")) {
    const { extractPageText } = await import("#/features/digest/clients.server");
    for (const item of cases) {
      const file = path.join(DATA, item.text);
      if (existsSync(file) && !process.argv.includes("--force")) {
        console.log(`have ${item.text}`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one paid extract at a time, in order
      const text = await extractPageText(item.url);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`wrote ${item.text} (${text.length} chars)`);
    }
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const prices = await loadPrices();

  if (args.suite === "picker") {
    const defaults = PICKER_SCREEN;
    const configs = selectConfigs(args.configs, defaults);
    const variants = args.stage === "prompts" ? SELECT_VARIANTS : [SELECT_VARIANTS[0]];
    const rows = await runPicker(configs, variants, args.repeats);
    const body = [
      `# Picker eval (${args.stage})`,
      "",
      `Pools: ${pools.length} x ${PICK_COUNT} picks. utility = (gold - trap) / n. recall is normalised by min(n, gold).`,
      "",
      pickerTable(rows),
      "",
      projectionTable(rows, prices),
    ].join("\n");
    console.log(`\n${body}`);
    const base = writeReport(`picker-${args.stage}`, body, { args, rows });
    console.log(`\nwrote ${base}.json`);
    return;
  }

  if (args.suite === "summary") {
    const configs = selectConfigs(args.configs, SUMMARY_SCREEN);
    const variants = args.stage === "prompts" ? SUMMARY_VARIANTS : [SUMMARY_VARIANTS[0]];
    const rows = await runSummary(configs, variants, args.repeats);
    if (args.judge) await judgeSummaries(rows);
    const body = [
      `# Summary eval (${args.stage})`,
      "",
      `Cases: ${cases.length}. facts = must-mention fact coverage. grounded = summary numbers present in the source. judge = mean of 5 axes (1-5) from ${JUDGE_MODEL} at effort ${JUDGE_EFFORT}.`,
      "",
      summaryTable(rows),
      "",
      "## Judge axes",
      "",
      summaryAxisTable(rows),
      "",
      "## Missed facts",
      "",
      ...[...new Set(rows.map(row => row.caseId))].map(caseId => {
        const missed = new Set(
          rows.filter(row => row.caseId === caseId).flatMap(row => row.missed)
        );
        return `- ${caseId}: ${[...missed].join(", ") || "none"}`;
      }),
    ].join("\n");
    console.log(`\n${body}`);
    const base = writeReport(`summary-${args.stage}`, body, { args, rows });
    console.log(`\nwrote ${base}.json`);
    return;
  }

  throw new Error(`unknown suite: ${args.suite}`);
}

await main();
