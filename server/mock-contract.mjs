/** EXAM-S2: strict transport and pinned objective-response validation. */
import { objectiveItems } from './package-contract.mjs';
import { Fault } from './owned-api.mjs';
import { requirePreparationId } from './preparation-contract.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/;
const VERSION = /^v[0-9]{1,4}$/;
const fail = (code) => { throw new Fault(422, code); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fields = (v, allowed) => {
  if (!object(v)) fail('invalid_mock_request');
  if (Object.keys(v).some((k) => !allowed.includes(k))) fail('unknown_field');
};
const token = (v, re = TOKEN) => {
  if (typeof v !== 'string' || !re.test(v)) fail('invalid_mock_identity');
  return v;
};
const event = (v) => token(v, UUID).toLowerCase();
const revision = (v) => {
  if (!Number.isSafeInteger(v) || v < 1 || v >= 2147483647) fail('invalid_mock_revision');
  return v;
};

export function validateStartMockRun(body) {
  fields(body, ['preparationId', 'formId', 'formVersion', 'releaseVersion', 'eventId']);
  return { preparationId: requirePreparationId(body.preparationId), formId: token(body.formId),
    formVersion: token(body.formVersion, VERSION), releaseVersion: token(body.releaseVersion, VERSION),
    eventId: event(body.eventId) };
}

export function validateFinaliseMockRun(body) {
  fields(body, ['expectedRevision', 'eventId', 'expectedWritingRevision', 'explanationLanguage']);
  if(body.expectedWritingRevision !== undefined) revision(body.expectedWritingRevision);
  if(body.explanationLanguage !== undefined && !['de','en','uk','ar','tr'].includes(body.explanationLanguage)) fail('invalid_explanation_language');
  return { expectedRevision: revision(body.expectedRevision), eventId: event(body.eventId),
    ...(body.expectedWritingRevision !== undefined ? {expectedWritingRevision:body.expectedWritingRevision}:{}),
    ...(body.explanationLanguage !== undefined ? {explanationLanguage:body.explanationLanguage}:{}) };
}

export function validateWritingChoice(body) {
  fields(body,['expectedRevision','eventId','choiceGroupId','optionId']);
  return {expectedRevision:revision(body.expectedRevision),eventId:event(body.eventId),choiceGroupId:token(body.choiceGroupId),optionId:token(body.optionId)};
}

export function validateSaveMockRun(body) {
  fields(body, ['expectedRevision', 'eventId', 'responses', 'position']);
  if (!Array.isArray(body.responses) || body.responses.length > 500) fail('invalid_mock_responses');
  const seen = new Set();
  const responses = body.responses.map((r) => {
    fields(r, ['setId', 'version', 'itemId', 'answer']);
    const result = { setId: token(r.setId), version: token(r.version, VERSION), itemId: token(r.itemId), answer: r.answer };
    if (r.answer !== null && (typeof r.answer !== 'string' || r.answer.length < 1 || r.answer.length > 160)) fail('invalid_mock_answer');
    const key = JSON.stringify([result.setId, result.version, result.itemId]);
    if (seen.has(key)) fail('duplicate_mock_response');
    seen.add(key);
    return result;
  });
  fields(body.position, ['member', 'item']);
  if (!Number.isSafeInteger(body.position.member) || body.position.member < 0
      || !Number.isSafeInteger(body.position.item) || body.position.item < 0) fail('invalid_mock_position');
  return { expectedRevision: revision(body.expectedRevision), eventId: event(body.eventId), responses,
    position: { member: body.position.member, item: body.position.item } };
}

/** Interaction, not exam/family names, decides the public item and offered-answer shape. */
export function mockMemberItems(member) {
  const p = member.payload;
  if (!object(p)) fail('invalid_mock_form');
  if (['grouped_choice', 'fixed_audio'].includes(member.interaction)) {
    let parsed;
    try { parsed = objectiveItems(p, member.interaction); } catch { fail('invalid_mock_form'); }
    if (parsed.length !== Number(member.item_count)) fail('invalid_mock_form');
    return parsed;
  }
  let items; let shared;
  switch (member.interaction) {
    case 'matching_headlines': items = p.texts; shared = p.headlines?.map((x) => String(x.id)); break;
    case 'matching_ads': items = p.situations; shared = [...(p.ads || []).map((x) => String(x.id)), 'x']; break;
    case 'single_choice': items = p.questions; break;
    case 'gap_choice': items = p.gaps; break;
    case 'gap_bank': items = p.gaps; shared = p.bank?.map((x) => String(x.id)); break;
    default: fail('unsupported_mock_interaction');
  }
  if (!Array.isArray(items) || !items.length || items.length !== Number(member.item_count)) fail('invalid_mock_form');
  const parsed = items.map((item) => ({ id: String(item.id ?? item.n), options: shared ?? Object.keys(item.options || {}) }));
  if (new Set(parsed.map((i) => i.id)).size !== parsed.length || parsed.some((i) => !TOKEN.test(i.id) || !i.options.length)) fail('invalid_mock_form');
  return parsed;
}

export function validatePinnedSnapshot(members, responses, position) {
  const tuples = new Map();
  const items = members.map((member) => {
    const list = mockMemberItems(member);
    for (const item of list) tuples.set(JSON.stringify([member.set_id, member.version, item.id]), item.options);
    return list;
  });
  if (!members.length && responses.length===0 && position.member===0 && position.item===0) return;
  if (!items[position.member] || !items[position.member][position.item]) fail('invalid_mock_position');
  for (const r of responses) {
    const options = tuples.get(JSON.stringify([r.setId, r.version, r.itemId]));
    if (!options) fail('unknown_mock_item');
    if (r.answer !== null && !options.includes(r.answer)) fail('invalid_mock_answer');
  }
}

export const MOCK_METHODS = Object.freeze(['listMockForms', 'listMockRuns', 'startMockRun', 'readMockRun', 'saveMockRun', 'finaliseMockRun']);

/** Windows are immutable; their active identity is always derived from server time. */
export function mockTiming(groups, now) {
  if (!groups?.length) return null;
  const time = new Date(now).getTime();
  const publicGroups = groups.map(g => ({ id: g.group_id, sections: g.sections,
    starts_at: new Date(g.starts_at).toISOString(), deadline_at: new Date(g.deadline_at).toISOString() }));
  return { policy: 'ordered-fixed-v1', active_group_id: publicGroups.find(g =>
    time >= new Date(g.starts_at).getTime() && time < new Date(g.deadline_at).getTime())?.id ?? null, groups: publicGroups };
}

/** Compare presence as well as value: omission of a closed answer is a mutation. */
export function validateGroupResponses(members, before, after, timing) {
  if (!timing) return;
  const active = timing.groups.find(g => g.id === timing.active_group_id)?.sections ?? [];
  const key = r => JSON.stringify([r.setId, r.version, r.itemId]);
  const old = new Map(before.map(r => [key(r), r])), next = new Map(after.map(r => [key(r), r]));
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id), b = next.get(id);
    if (a && b && a.answer === b.answer) continue;
    const r = a ?? b, member = members.find(m => m.set_id === r.setId && m.version === r.version);
    if (!member || !active.includes(member.section)) throw new Fault(409, 'mock_group_inactive');
  }
}
