import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENDPOINT, INDEXNOW_KEY, KEY_URL, SITEMAP_URL, normalizeUrls, parseSitemap, runIndexNow } from './indexnow.mjs';
import { assertCaddy } from './production-compose-check.mjs';

const sitemap = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://hatoove.com/</loc></url><url><loc>https://hatoove.com/learn/example</loc></url></urlset>';
const response = (body, status = 200) => new Response(body, { status });

function harness({ key = INDEXNOW_KEY, status = 200, xml = sitemap } = {}) {
  const calls = [];
  const messages = [];
  return {
    calls, messages,
    options: {
      log: (message) => messages.push(message),
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url === KEY_URL) return response(key);
        if (url === SITEMAP_URL) return response(xml);
        if (url === ENDPOINT) return response('', status);
        throw new Error(`Unexpected request: ${url}`);
      },
    },
  };
}

test('the published file matches the configured key', () => {
  assert.equal(readFileSync(new URL(`../public/${INDEXNOW_KEY}.txt`, import.meta.url), 'utf8').trim(), INDEXNOW_KEY);
});

test('Caddy serves only the exact public key and rejects changed response contracts', () => {
  const caddy = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertCaddy(caddy));
  const directive = `respond /${INDEXNOW_KEY}.txt ${INDEXNOW_KEY} 200`;
  for (const replacement of [
    `respond /${INDEXNOW_KEY}.txt* ${INDEXNOW_KEY} 200`,
    `respond /${INDEXNOW_KEY}.txt wrong-key 200`,
    `respond /${INDEXNOW_KEY}.txt ${INDEXNOW_KEY} 202`,
    `respond /* ${INDEXNOW_KEY} 200`,
  ]) assert.throws(() => assertCaddy(caddy.replace(directive, replacement)), /caddy_indexnow_response_changed/);
});

test('canonical paths are normalized and deduplicated', () => {
  assert.deepEqual(normalizeUrls(['/', 'https://hatoove.com', '/learn/example', '/learn/example']), ['https://hatoove.com/', 'https://hatoove.com/learn/example']);
  for (const input of ['https://example.com/', '//example.com', '/\\example.com', '/about#fragment', 'https://hatoove.com@evil.test/', 'http://hatoove.com/', 'https://www.hatoove.com/', 'learn/example', `/${'a'.repeat(2048)}`]) {
    assert.throws(() => normalizeUrls([input]), undefined, input);
  }
});

test('flat sitemap XML decodes entities and CDATA without treating comments as URLs', () => {
  assert.deepEqual(parseSitemap('<?xml version="1.0"?><urlset><!-- <loc>https://evil.test/</loc> --><url><loc>https://hatoove.com/?a=1&amp;b=&#50;</loc></url><url><loc><![CDATA[https://hatoove.com/learn/example]]></loc></url></urlset>'), ['https://hatoove.com/?a=1&b=2', 'https://hatoove.com/learn/example']);
  for (const xml of ['<html>login</html>', '<sitemapindex></sitemapindex>', '<urlset></urlset>', '<urlset><loc>https://evil.test/</loc></urlset>', '<urlset><loc>https://hatoove.com/?a=&oops;</loc></urlset>']) assert.throws(() => parseSitemap(xml));
});

test('sitemap submission verifies the key and sends one correct shared-engine payload', async () => {
  const h = harness();
  await runIndexNow([], h.options);
  assert.deepEqual(h.calls.map((call) => call.url), [SITEMAP_URL, KEY_URL, ENDPOINT]);
  const post = h.calls[2].options;
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(post.body), { host: 'hatoove.com', key: INDEXNOW_KEY, keyLocation: KEY_URL, urlList: ['https://hatoove.com/', 'https://hatoove.com/learn/example'] });
  assert.ok(h.calls.every((call) => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
});

test('targeted submissions do not fetch the sitemap and report pending validation honestly', async () => {
  const h = harness({ status: 202 });
  await runIndexNow(['/learn/example', '/learn/example'], h.options);
  assert.deepEqual(h.calls.map((call) => call.url), [KEY_URL, ENDPOINT]);
  assert.deepEqual(JSON.parse(h.calls[1].options.body).urlList, ['https://hatoove.com/learn/example']);
  assert.ok(h.messages.some((message) => /validation is pending/.test(message)));
});

test('dry runs and check-only mode never submit', async () => {
  const h = harness();
  await runIndexNow(['--dry-run'], h.options);
  assert.deepEqual(h.calls.map((call) => call.url), [SITEMAP_URL]);
  const check = harness();
  await runIndexNow(['--check'], check.options);
  assert.deepEqual(check.calls.map((call) => call.url), [KEY_URL]);
});

test('HTML, incorrect keys, redirects and unavailable key files block submission', async () => {
  for (const key of ['<html>Sign in</html>', 'wrong-key']) {
    const h = harness({ key });
    await assert.rejects(runIndexNow(['/'], h.options), /Key verification failed/);
    assert.equal(h.calls.length, 1);
  }
  for (const status of [307, 404, 503]) {
    await assert.rejects(runIndexNow(['/'], { fetchImpl: async () => response(INDEXNOW_KEY, status) }), /Key verification failed/);
  }
  await assert.rejects(runIndexNow(['/'], { fetchImpl: async () => { throw new Error('redirect'); } }), /Redirects are not allowed/);
});

test('invalid input and failed sitemap fetches never reach submission', async () => {
  const h = harness();
  for (const args of [['--unknown'], ['--check', '/'], ['--check', '--dry-run'], ['https://evil.test/']]) await assert.rejects(runIndexNow(args, h.options));
  assert.equal(h.calls.length, 0);
  await assert.rejects(runIndexNow([], { fetchImpl: async () => response('', 503) }), /sitemap \(HTTP 503\)/);
});

test('IndexNow error responses fail with actionable status messages', async () => {
  for (const status of [400, 403, 422, 429, 500]) {
    const h = harness({ status });
    await assert.rejects(runIndexNow(['/'], h.options), new RegExp(`HTTP ${status}`));
  }
});

test('submissions respect the 10,000 URL limit', async () => {
  const h = harness();
  await runIndexNow(Array.from({ length: 10_001 }, (_, i) => `/learn/page-${i}`), h.options);
  assert.deepEqual(h.calls.filter((call) => call.url === ENDPOINT).map((call) => JSON.parse(call.options.body).urlList.length), [10_000, 1]);
});

const withoutComments = (source) => source.replace(/^[ \t]*#.*$/gm, '');

test('the deployment gate verifies the live key body after the deploy step', () => {
  const workflow = withoutComments(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
  // A deployment that loses the ownership file currently looks green if only status
  // codes are checked; both the exact body and a text/plain response must be asserted.
  for (const required of [
    'INDEXNOW_KEY: 16a91221eb78411198dbd6254bf9e653',
    'https://hatoove.com/${INDEXNOW_KEY}.txt',
    'test "$key_status" = "200"',
    'test "${key_type%%;*}" = "text/plain"',
    'tr -d \'\\r\\n\' < /tmp/indexnow-key.txt',
    '= "$INDEXNOW_KEY"',
  ]) assert.ok(workflow.includes(required), `deploy.yml is missing: ${required}`);
  const deploy = workflow.indexOf('- name: Package verified git archive and deploy to droplet');
  const verify = workflow.indexOf('- name: Verify public production routes after deployment');
  assert.ok(deploy > -1 && verify > deploy, 'the key verification must run after the deploy step');
});

test('the ingress activation script gates on the loaded Caddyfile and only restarts ingress', () => {
  const script = withoutComments(readFileSync(new URL('../deploy/activate-ingress.sh', import.meta.url), 'utf8'));
  for (const required of [
    '--check',
    '--apply',
    'hostname -s',
    '.reviewed-commit',
    'flock -n 9',
    'sha256sum "$config"',
    'grep -Fq "respond /$key.txt $key 200"',
    'loaded_config=$(loaded_config_hash)',
    '[[ "$loaded_config" == "$expected_config" ]]',
    'restart --no-deps ingress',
    'RECOVERY REQUIRED',
    '/api/ready',
  ]) assert.ok(script.includes(required), `activate-ingress.sh is missing: ${required}`);
  const loaded = script.indexOf('loaded_config=$(loaded_config_hash)');
  const restarts = [...script.matchAll(/restart --no-deps ingress/g)].map((match) => match.index);
  assert.equal(restarts.length, 2, 'only the rollback and the apply path may restart ingress');
  assert.ok(restarts.every((index) => index > loaded), 'every restart must follow the loaded-config inspection');
  assert.ok(script.indexOf('exit 0') > loaded, 'no success exit may precede the loaded-config inspection');
  // The activation step must not become an application deployment or touch data.
  for (const forbidden of [
    /\bdocker compose\b[^\n]*\b(?:up|down|stop|build|run)\b/,
    /\$\{compose\[@\]\}[^\n]*\b(?:up|down|stop|build|run)\b/,
    /--force-recreate/,
    /\bdocker\s+(?:volume|rm|system)\b/,
    /\bmigrate\b/,
    /restart --no-deps (?:app|worker|db)\b/,
  ]) assert.ok(!forbidden.test(script), `activate-ingress.sh must not match ${forbidden}`);
});
