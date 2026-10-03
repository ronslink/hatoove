/** Explicit context for synthetic browser callers. Never imported by the application. */
import assert from 'node:assert/strict';
export function fixturePreparation(list) {
  const rows=list?.preparations?.filter(p=>p.exam_id==='telc-deutsch-b1' && p.state==='active');
  assert.equal(rows?.length,1,'synthetic account must have exactly one active initial preparation');
  assert.match(rows[0].id,/^[0-9a-f-]{36}$/i);
  return rows[0].id;
}
export function scopedFixtureRoute(route, preparationId) {
  const url=new URL(route,'http://fixture.invalid');
  if (/^\/api\/v1\/(tasks|objective-sets(?:\/[^/]+)?|practice\/(?:next|progress|mistakes)|attempts)$/.test(url.pathname)) {
    assert.match(preparationId,/^[0-9a-f-]{36}$/i,'scoped synthetic request needs its own preparation');
    assert.ok(!url.searchParams.has('preparationId') || url.searchParams.get('preparationId')===preparationId);
    url.searchParams.set('preparationId',preparationId);
  }
  return url.pathname+url.search;
}
