import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE_URL = 'https://hatoove.com';
export const INDEXNOW_KEY = '16a91221eb78411198dbd6254bf9e653';
export const KEY_URL = `${SITE_URL}/${INDEXNOW_KEY}.txt`;
export const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
export const ENDPOINT = 'https://api.indexnow.org/indexnow';
const BATCH_SIZE = 10_000;

const HELP = `Submit public Hatoove pages to IndexNow.

  npm run indexnow                         Submit the live sitemap
  npm run indexnow -- /learn/article       Submit selected paths or full URLs
  npm run indexnow -- --dry-run            List URLs without submitting
  npm run indexnow -- --check              Verify the live key only

Only canonical https://hatoove.com URLs are accepted. Deploy the key file
and its public-route exemption before submitting. A dry run skips key checking.`;

export function normalizeUrls(inputs) {
  return [...new Set(inputs.map((input) => {
    if (!input.startsWith('/') && !input.startsWith(`${SITE_URL}/`) && input !== SITE_URL) {
      throw new Error(`Use a root-relative path or a canonical ${SITE_URL} URL: ${input}`);
    }
    const url = new URL(input, SITE_URL);
    if (url.origin !== SITE_URL || url.username || url.password || url.hash) {
      throw new Error(`URL must use ${SITE_URL}, with no credentials or fragment: ${input}`);
    }
    if (url.href.length > 2048) throw new Error('An IndexNow URL exceeds 2,048 characters.');
    return url.href;
  }))];
}

// The application publishes a flat XML sitemap. Fail closed if its format changes.
export function parseSitemap(xml) {
  const source = xml.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^(?:<\?xml[^?]*\?>\s*)?<urlset(?:\s[^>]*)?>[\s\S]*<\/urlset>$/.test(source)) {
    throw new Error('Expected a flat <urlset> sitemap; HTML and sitemap indexes are not supported.');
  }
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const urls = [...source.matchAll(/<loc\s*>([\s\S]*?)<\/loc>/g)].map((match) => {
    const value = match[1].trim();
    if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) return value.slice(9, -3).trim();
    if (/<|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) {
      throw new Error('Invalid XML in a sitemap URL.');
    }
    return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
      if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
      if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
      return entities[entity];
    });
  });
  if (!urls.length) throw new Error('The live sitemap contains no URLs.');
  return normalizeUrls(urls);
}

async function request(fetchImpl, url, options = {}) {
  try {
    return await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${error.message}. Redirects are not allowed; check that the URL is public.`, { cause: error });
  }
}

export async function verifyKey(fetchImpl = fetch) {
  const response = await request(fetchImpl, KEY_URL);
  if (response.status !== 200 || (await response.text()).trim() !== INDEXNOW_KEY) {
    throw new Error(`Key verification failed at ${KEY_URL} (HTTP ${response.status}). Deploy the exact key file and ensure it is accessible without login.`);
  }
}

export async function runIndexNow(args, { fetchImpl = fetch, log = console.log } = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    log(HELP);
    return;
  }
  const unknown = args.find((arg) => arg.startsWith('-') && !['--dry-run', '--check'].includes(arg));
  if (unknown) throw new Error(`Unknown option: ${unknown}. Use --help.`);
  const dryRun = args.includes('--dry-run');
  const checkOnly = args.includes('--check');
  const paths = args.filter((arg) => !arg.startsWith('--'));
  if (checkOnly) {
    if (dryRun || paths.length) throw new Error('Use --check by itself.');
    await verifyKey(fetchImpl);
    log(`Verified live IndexNow key: ${KEY_URL}`);
    return;
  }

  let urls;
  if (paths.length) {
    urls = normalizeUrls(paths);
  } else {
    const response = await request(fetchImpl, SITEMAP_URL);
    if (response.status !== 200) throw new Error(`Could not load the live sitemap (HTTP ${response.status}).`);
    urls = parseSitemap(await response.text());
  }
  if (dryRun) {
    log(`Dry run: ${urls.length} URL(s); no submission made. Live key verification skipped.`);
    urls.forEach((url) => log(url));
    return;
  }

  await verifyKey(fetchImpl);
  for (let offset = 0; offset < urls.length; offset += BATCH_SIZE) {
    const batch = urls.slice(offset, offset + BATCH_SIZE);
    const response = await request(fetchImpl, ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(SITE_URL).hostname,
        key: INDEXNOW_KEY,
        keyLocation: KEY_URL,
        urlList: batch,
      }),
    });
    if (response.status === 200) {
      log(`HTTP 200: submitted ${batch.length} URL(s).`);
    } else if (response.status === 202) {
      log(`HTTP 202: received ${batch.length} URL(s); key validation is pending.`);
    } else {
      const reasons = {
        400: 'Invalid request format.',
        403: 'The verification key is missing, mismatched, or invalid.',
        422: 'URLs do not match the host or key scope.',
        429: 'Rate limited. Wait before retrying.',
      };
      throw new Error(`IndexNow HTTP ${response.status}: ${reasons[response.status] || 'Submission failed.'} ${offset} URL(s) were accepted in earlier batches.`);
    }
  }
  log('Participating engines share submissions. Acceptance does not guarantee indexing.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runIndexNow(process.argv.slice(2)).catch((error) => {
    console.error(`IndexNow: ${error.message}`);
    process.exitCode = 1;
  });
}
