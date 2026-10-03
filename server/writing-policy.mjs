/** Versioned writing policy registry. Imported rubrics cannot introduce executable policy. */
export const DTZ_POLICY = 'dtz-writing-practice-v1';
export const DTZ_KIND = 'dtz-writing-bands';
export const DTZ_KEYS = Object.freeze(['dtz_aufgabe','dtz_kommunikation','dtz_korrektheit','dtz_wortschatz']);
export const DTZ_BANDS = Object.freeze({B1_PLUS:5,B1:4,A2_PLUS:3,A2:2,A1:1,ZERO:0});
export function supportedWritingPolicy(rubric, examId) {
  return rubric?.policy === DTZ_POLICY && examId === 'dtz-a2-b1' && rubric.feedback_kind === DTZ_KIND
    && Array.isArray(rubric.criteria) && rubric.criteria.length === 4
    && DTZ_KEYS.every(key => rubric.criteria.some(c => c.key === key));
}
export const DTZ_INSTRUCTIONS = 'Assess each criterion against its own bound descriptors. No total or overall level. No minimum word count or universal formal address rule. Text with no meaningful relation to the selected prompt receives ZERO in all four criteria.';
