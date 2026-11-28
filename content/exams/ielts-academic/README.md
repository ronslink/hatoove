# IELTS Academic written practice package

Version 1 is internal and unreviewed. It contains original preparation content, not reproduced official IELTS questions. AI-assisted authoring and Google Cloud Text-to-Speech provenance are recorded in the sources and manifest. Qualified human content, rubric and audio review remains required.

- Reading: three passages, 2,323 words, 40 questions and explanations; 60 minutes.
- Listening: four sections, 40 questions and explanations, four real PCM WAVs; once per recording in an exam run. The computer-style window is 32 minutes, including final answer checking. Recorded speech and question-reading pauses total 27.04 minutes.
- Writing: a 150-word visual report and a 250-word discussion essay; both required within 60 minutes. Each has its own saved draft, submission and task-specific formative rubric. Feedback categories are not official IELTS bands.

Speaking is not included, and this package does not issue an overall IELTS score. Interface and explanation language are independent of English exam content. Dataset figures and named scenarios are original teaching material; they are not claims about real institutions or learner records.

Format references checked 28 November 2026: [IELTS Academic reading](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading), [IELTS Academic writing](https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing), and [British Council listening format](https://takeielts.britishcouncil.org/what-is-ielts/how-it-works/test-format/listening).

Run `node tools/ielts-package-build.mjs` to rebuild the manifest without provider calls, and `node tools/ielts-package-check.mjs` to validate content shape and every WAV byte/hash/duration. Audio synthesis and live grading are separate explicit commands; neither runs as setup or an offline gate.
