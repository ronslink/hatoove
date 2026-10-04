/** Trusted deployment configuration only; request headers never enter this policy. */
function invalidOrigin() {
  const error = new Error('invalid_public_origin_configuration');
  error.code = 'invalid_public_origin_configuration';
  return error;
}

/** Canonical HTTP(S) origin, optionally ending in one slash; absent/blank is local/unconfigured. */
export function parsePublicOrigin(value, { requireHttps = false } = {}) {
  if (typeof requireHttps !== 'boolean') throw invalidOrigin();
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (requireHttps) throw invalidOrigin();
    return null;
  }
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f\\]/u.test(value)) throw invalidOrigin();
  let url;
  try { url = new URL(value); } catch { throw invalidOrigin(); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || url.pathname !== '/'
      || (value !== url.origin && value !== `${url.origin}/`)
      || (requireHttps && url.protocol !== 'https:')) throw invalidOrigin();
  return url.origin;
}

/** Read the strict environment flag without coercion or exposing a rejected value. */
export function readPublicOriginConfig(env = process.env) {
  const flag = env.B1PREP_REQUIRE_HTTPS;
  if (flag !== undefined && flag !== '0' && flag !== '1') throw invalidOrigin();
  const requireHttps = flag === '1';
  const publicOrigin = parsePublicOrigin(env.B1PREP_PUBLIC_ORIGIN, { requireHttps });
  return Object.freeze({ publicOrigin, requireHttps, secureCookies: publicOrigin?.startsWith('https:') === true });
}
