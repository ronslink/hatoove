/**
 * D10 live writing grader adapter — DeepSeek (`deepseek-chat`) with hard daily call cap.
 *
 * Strictly opt-in via server configuration (`HATOVE_GRADER_MODE=live` + `DEEPSEEK_API_KEY` or
 * `DEEPSEEK_API_KEY_FILE`). Default mode is `stub` (no external network call).
 *
 * Enforces a hard UTC daily limit (`HATOVE_GRADER_DAILY_LIMIT`, default 15) against the
 * `provider_attempt` ledger before dispatching any HTTP call. Never leaks API keys or raw
 * provider payloads into errors or logs.
 */
import { readFileSync } from 'node:fs';
import { DTZ_POLICY, DTZ_KIND, DTZ_INSTRUCTIONS, GOETHE_B1_POLICY, GOETHE_B1_KIND, GOETHE_B1_INSTRUCTIONS } from './writing-policy.mjs';
import { firstSentence } from './owned-postgres/worker.mjs';

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
export const DEEPSEEK_PROMPT_VERSION = 'deepseek-writing-v1';
export const DEFAULT_DAILY_USD_LIMIT = 15;
const MAX_DAILY_USD_LIMIT = 10000;
const DEFAULT_TIMEOUT_MS = 30000;
/** Conservative USD per 1M tokens for DeepSeek chat, plus a fallback per unobserved attempt. */
export const DEEPSEEK_USD_RATES = Object.freeze({
  inputPerMillion: 0.28,
  cachedInputPerMillion: 0.028,
  outputPerMillion: 0.42,
  unobservedAttemptUsd: 0.01,
});

const LANGUAGE_NAMES = Object.freeze({
  de: 'German (formal Sie)',
  en: 'English',
  uk: 'Ukrainian',
  ar: 'Arabic',
  tr: 'Turkish',
});

function readSecretFile(filePath) {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });
  return raw;
}

/**
 * Parse opt-in live grader configuration from environment variables.
 * Returns `{ mode: 'stub' }` when `HATOVE_GRADER_MODE` is unset or `'stub'`.
 * Throws `{ code: 'grader_configuration_invalid' }` on invalid mode, missing key, or invalid daily limit.
 */
export function readDeepSeekConfig(env = process.env) {
  const rawMode = (env.HATOVE_GRADER_MODE ?? 'stub').trim().toLowerCase();
  if (rawMode === '' || rawMode === 'stub') return Object.freeze({ mode: 'stub' });
  if (rawMode !== 'live') throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });

  let apiKey = (env.DEEPSEEK_API_KEY ?? '').trim();
  if (!apiKey && env.DEEPSEEK_API_KEY_FILE) apiKey = readSecretFile(env.DEEPSEEK_API_KEY_FILE);
  if (!apiKey || apiKey.length < 8) throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });

  const rawLimit = env.HATOVE_GRADER_DAILY_USD_LIMIT;
  let dailyUsdLimit = DEFAULT_DAILY_USD_LIMIT;
  if (rawLimit !== undefined && String(rawLimit).trim() !== '') {
    const trimmed = String(rawLimit).trim();
    if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });
    dailyUsdLimit = Number(trimmed);
    if (!Number.isFinite(dailyUsdLimit) || dailyUsdLimit <= 0 || dailyUsdLimit > MAX_DAILY_USD_LIMIT) {
      throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });
    }
  }

  const model = (env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL).trim() || DEFAULT_DEEPSEEK_MODEL;
  if (!/^[a-z0-9._-]{1,64}$/i.test(model)) throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });

  const endpoint = (env.DEEPSEEK_ENDPOINT ?? DEEPSEEK_ENDPOINT).trim() || DEEPSEEK_ENDPOINT;
  if (!/^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(endpoint)) {
    throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });
  }

  return Object.freeze({ mode: 'live', apiKey, model, endpoint, dailyUsdLimit });
}

/** Build structured system + user messages for telc Deutsch B1 or DTZ A2–B1 writing assessment. */
export function buildWritingPrompt({ text, rubric, policy, explanationLanguage = 'de', task = null }) {
  const isDtz = policy === DTZ_POLICY;
  const isGoethe = policy === GOETHE_B1_POLICY;
  const lang = LANGUAGE_NAMES[String(explanationLanguage || 'de').slice(0, 2)] || LANGUAGE_NAMES.de;
  const criteriaSpec = (rubric?.criteria || []).map((c) => {
    const allowedBands = Array.isArray(c.bands) ? c.bands : Object.keys(c.bands || {});
    return `- key: "${c.key}" (${c.label}), allowed bands: [${allowedBands.join(', ')}]`;
  }).join('\n');

  const system = [
    isDtz
      ? `You are a strict, supportive German DTZ (A2-B1) writing examiner. ${DTZ_INSTRUCTIONS}`
      : isGoethe
      ? `You are a strict, supportive German Goethe-Zertifikat B1 writing examiner. ${GOETHE_B1_INSTRUCTIONS}`
      : 'You are a strict, supportive German telc Deutsch B1 writing examiner. Assess each criterion against its own band (A, B, C, or D).',
    `Write every criterion "comment" in ${lang}. Write "corrections" as short, concrete German improvement examples (max 8 items).`,
    'Rules:',
    '- Return ONLY a valid JSON object with exact top-level keys: {"criteria": [...], "corrections": [...]}.',
    '- Include EVERY criterion key listed below exactly once, each with keys {"key", "band", "evidence", "comment"}.',
    '- "evidence" MUST be an exact, verbatim substring copied character-for-character from the learner text.',
    '- NEVER include numeric scores, totals, percentages, or pass/fail predictions anywhere in the JSON.',
    'Criteria:',
    criteriaSpec,
  ].join('\n');

  const taskBlock = task
    ? [
        task.topic ? `Topic: ${task.topic}` : null,
        task.situation ? `Situation: ${task.situation}` : null,
        Array.isArray(task.leitpunkte) && task.leitpunkte.length
          ? `Leitpunkte:\n${task.leitpunkte.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
          : null,
      ].filter(Boolean).join('\n')
    : null;

  const user = [
    taskBlock ? `Task:\n${taskBlock}\n` : '',
    'Learner text:',
    '"""',
    String(text || ''),
    '"""',
  ].join('\n');

  return { system, user };
}

/** Parse and normalize DeepSeek JSON output into Hatoove's strict band-assessment contract. */
export function parseDeepSeekAssessment(rawContent, { text, rubric, policy, model = DEFAULT_DEEPSEEK_MODEL }) {
  let parsed;
  try {
    const cleaned = String(rawContent || '').trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw Object.assign(new Error('grader_error'), { code: 'grader_error' });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.criteria)) {
    throw Object.assign(new Error('grader_error'), { code: 'grader_error' });
  }

  const body = String(text || '');
  const fallbackQuote = firstSentence(body).slice(0, 500) || body.slice(0, 60);
  const byKey = new Map();
  for (const row of parsed.criteria) {
    if (row && typeof row === 'object' && typeof row.key === 'string') byKey.set(row.key, row);
  }

  const criteria = (rubric?.criteria || []).map((c) => {
    const row = byKey.get(c.key);
    if (!row || typeof row.band !== 'string' || typeof row.comment !== 'string' || !row.comment.trim()) {
      throw Object.assign(new Error('grader_error'), { code: 'grader_error' });
    }
    const rawEvidence = typeof row.evidence === 'string' ? row.evidence.trim() : '';
    const evidence = rawEvidence && body.includes(rawEvidence) ? rawEvidence.slice(0, 500) : fallbackQuote;
    return {
      key: c.key,
      band: row.band.trim(),
      evidence,
      comment: row.comment.trim().slice(0, 4000),
    };
  });

  const corrections = Array.isArray(parsed.corrections)
    ? parsed.corrections
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 10)
        .map((item) => item.trim().slice(0, 1000))
    : [];

  return {
    feedback: {
      kind: policy === DTZ_POLICY ? DTZ_KIND : policy === GOETHE_B1_POLICY ? GOETHE_B1_KIND : 'telc-b1-bands',
      criteria,
      corrections,
    },
    modelVersion: model,
    promptVersion: DEEPSEEK_PROMPT_VERSION,
  };
}

/** Estimate non-stub USD spend recorded today (UTC) from `provider_attempt` + latest observation. */
export async function estimateLiveSpendUsdToday(pool) {
  const { rows } = await pool.query(
    `SELECT
        coalesce(sum(CASE WHEN o.input_tokens IS NOT NULL OR o.output_tokens IS NOT NULL
          THEN greatest(coalesce(o.input_tokens, 0) - coalesce(o.cached_input_tokens, 0), 0) ELSE 0 END), 0)::bigint AS uncached_in,
        coalesce(sum(CASE WHEN o.input_tokens IS NOT NULL OR o.output_tokens IS NOT NULL
          THEN coalesce(o.cached_input_tokens, 0) ELSE 0 END), 0)::bigint AS cached_in,
        coalesce(sum(CASE WHEN o.input_tokens IS NOT NULL OR o.output_tokens IS NOT NULL
          THEN coalesce(o.output_tokens, 0) ELSE 0 END), 0)::bigint AS out_tokens,
        count(*) FILTER (WHERE o.input_tokens IS NULL AND o.output_tokens IS NULL)::int AS unobserved
       FROM provider_attempt a
       LEFT JOIN LATERAL (
         SELECT input_tokens, cached_input_tokens, output_tokens
           FROM provider_attempt_observation o
          WHERE o.attempt_id = a.attempt_id
          ORDER BY o.revision DESC LIMIT 1
       ) o ON true
      WHERE a.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        AND a.transport_mode <> 'local_stub'`
  );
  const r = rows[0] || {};
  const uncachedIn = Number(r.uncached_in ?? 0);
  const cachedIn = Number(r.cached_in ?? 0);
  const outTokens = Number(r.out_tokens ?? 0);
  // Exclude the current in-flight claim's own newly-inserted unobserved intent row.
  const otherUnobserved = Math.max(0, Number(r.unobserved ?? 0) - 1);
  return (
    (uncachedIn / 1_000_000) * DEEPSEEK_USD_RATES.inputPerMillion
    + (cachedIn / 1_000_000) * DEEPSEEK_USD_RATES.cachedInputPerMillion
    + (outTokens / 1_000_000) * DEEPSEEK_USD_RATES.outputPerMillion
    + otherUnobserved * DEEPSEEK_USD_RATES.unobservedAttemptUsd
  );
}

/**
 * Create the DeepSeek live writing grader function compatible with `createWorker({ pool, grade })`.
 */
export function createDeepSeekGrader({
  pool,
  apiKey,
  model = DEFAULT_DEEPSEEK_MODEL,
  endpoint = DEEPSEEK_ENDPOINT,
  dailyUsdLimit = DEFAULT_DAILY_USD_LIMIT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  estimateSpendUsdToday = () => estimateLiveSpendUsdToday(pool),
} = {}) {
  if (!apiKey) throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('grader_configuration_invalid'), { code: 'grader_configuration_invalid' });

  return async function gradeWithDeepSeek(input, ctx) {
    // Hard daily USD spend cap checked BEFORE any outbound HTTP request.
    const spentUsdToday = await estimateSpendUsdToday();
    if (!Number.isFinite(spentUsdToday) || spentUsdToday >= dailyUsdLimit) {
      throw Object.assign(new Error('grader_budget_exceeded'), { code: 'grader_budget_exceeded' });
    }

    const { system, user } = buildWritingPrompt(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let payload;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      payload = await response.json().catch(() => null);
    } catch {
      throw Object.assign(new Error('grader_error'), { code: 'grader_error' });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok || !payload?.choices?.[0]?.message?.content) {
      throw Object.assign(new Error('grader_error'), { code: 'grader_error' });
    }

    if (ctx && typeof ctx.captureUsage === 'function' && payload.usage && typeof payload.usage === 'object') {
      const inputTokens = Number.isSafeInteger(payload.usage.prompt_tokens) ? payload.usage.prompt_tokens : null;
      const outputTokens = Number.isSafeInteger(payload.usage.completion_tokens) ? payload.usage.completion_tokens : null;
      const cachedInputTokens = Number.isSafeInteger(payload.usage.prompt_cache_hit_tokens) ? payload.usage.prompt_cache_hit_tokens : null;
      if (inputTokens !== null || outputTokens !== null) {
        ctx.captureUsage({
          usageBasis: 'reported',
          modelReported: null,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningOutputTokens: null,
        });
      }
    }

    return parseDeepSeekAssessment(payload.choices[0].message.content, {
      text: input.text,
      rubric: input.rubric,
      policy: input.policy,
      model,
    });
  };
}
