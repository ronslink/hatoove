# B1 Prep: exam preparation and product priorities

Reviewed 23 September 2026 from the existing `D:\B1_Prep` implementation. The D: application and learner progress were read only. This is a product review, not a completed content audit.

The strongest proposition is **know what to practise next, understand mistakes, and prove readiness under exam conditions**. Keep the current adaptive practice, error notebook, dated plan, reference library and local progress protection. A commercial interface should organise them around that learning loop.

## Resolve exam fidelity before launch

The current application identifies itself as preparation for **Zertifikat Deutsch / telc Deutsch B1**. Its writing and speaking blueprints contain material mismatches with that exam.

| Area | Current implementation | Official reference |
|---|---|---|
| Writing task | Three required content points; generated and offline tasks and writing guide repeat this | Four content points |
| Speaking part 1 | Three-minute presentation on a topic | Getting to know the other candidate |
| Speaking points | 25 / 25 / 25; README says the split is not published | 15 / 30 / 30 |
| Writing rubric | Four categories, weighted 15 / 10 / 12 / 8 | Three categories: task fulfilment, communicative design and formal accuracy; each uses 5 / 3 / 1 / 0, with the sum multiplied by three |

Source: telc's [official B1 model examination](https://shop.telc.net/media/catalog/product/file/telc_deutsch_b1_zd_uebungstest_1.pdf), printed pages 5, 18, 34–39. The [current exam page](https://www.telc.net/sprachpruefungen/deutsch/zertifikat-deutsch-telc-deutsch-b1/) also confirms that oral assessment focuses on direct interaction between candidates. Sources checked 23 September 2026.

Implementation locations: `public/js/blueprint.js` (task definitions and points), `public/js/ai.js` (writing criteria around line 696, writing generation around 704, speaking around 844), `public/js/exam.js` (feedback and mock instructions), `data/writing-guide.json`, `data/speaking-guide.json`, associated core phrases and README. Correct these together and audit the remaining seed content against the same versioned blueprint. Updating labels alone would leave practice teaching the wrong task. Preserve historical scores with their original rubric version.

## Give readiness a defensible meaning

The current readiness forecast is a useful coaching signal, but is not an empirically validated pass probability. `engine.js` assigns fixed part difficulties, converts estimated ability into points, and `store.js:404` defines confidence as attempt count divided by attempt count plus a prior. That measures accumulated evidence, not prediction accuracy. A polished dashboard should label it **practice estimate** and show which exam areas still lack evidence.

Additional implementation findings:

- Speaking results in `exam.js:1117` are converted into separate binary criterion attempts. The predicted oral result therefore does not directly preserve the returned rubric score. A transcript also does not evidence pronunciation or actual partner interaction.
- `engine.js:targetDifficulty` selects ability plus eight and claims roughly 70% success. With the implementation's logistic formula and scale 18, that produces about 26% expected success before clamping. The comment and targeting policy disagree. Calibrate the target and verify observed success before promising a personalised optimal challenge.
- `engine.js:studyPlan` caps the horizon at 14 days and always treats the last planned day as tapering. A distant exam therefore still produces a near-exam pattern. Its mock day also prescribes 175 minutes regardless of the daily time budget. Longer preparation needs weekly cycles and an explicit slot for a full rehearsal.
- Plan completion checks can mark a task complete after a single recorded item. Distinguish starting a task from completing the planned session or full exam part.

Recommended readiness model: separate guided practice, first attempts at unseen questions, and full timed mocks. Show the latest comparable mock, coverage, recent trend and remaining weak areas. Count repeated exposure separately. Only introduce a numeric pass probability after validating it against external outcomes.

## Immediate design direction

Use a quiet, mature study workspace with a distinctive brand, restrained colour and excellent reading typography. The learner's work should occupy the largest area.

1. **Home:** today's recommended session first, with its time and reason; separate written and oral evidence; one clear continue button; detailed analytics below.
2. **Practice:** a stable task header, readable paper, prominent answer controls, visible saving state and predictable back navigation. Keep reference material close but secondary.
3. **Feedback:** explain the error, show the rule in context, offer a short retry, and schedule later recall. A score alone does not tell a learner how to improve.
4. **Mocks:** a recognisably different exam mode with timing, navigation and no instructional hints until submission. Keep exact scoring and feedback after the attempt.
5. **Mobile and accessibility:** comfortable touch targets, strong contrast, keyboard focus, usable tables and no colour-only status. Reading exercises must remain readable on small screens.

Avoid adding shop, subscription and language-selection navigation to the learning workspace before those features exist. Keep the current product identity provisional until the wider brand is chosen.

## Sequence the commercial work

| Stage | Deliverable | Evidence needed to move on |
|---|---|---|
| Current redesign | Cohesive application shell, dashboard, practice and feedback layouts; reliable resume and mobile use | Existing learning flows still work and progress is preserved |
| Exam-quality beta | Correct blueprint and rubric, reviewed question bank, authentic listening conditions, partner-interaction practice, clearer readiness evidence | Experienced exam educators review tasks and grading; unseen timed mocks give consistent results |
| First paid product | One thoroughly supported German exam; onboarding, accounts, durable sync and recovery, entitlements, support, content versioning, usage-cost controls | Real learners complete preparation and can explain why the product helped |
| Exam platform | Reusable course shell plus separate provider/level/version packages, then additional German exams | A second exam can be added without hard-coded assumptions or copying the entire application |
| Additional languages | Native educational review and exam-specific content, audio, tasks and scoring | The new examination package meets the same quality checks as the first |

Track learning outcomes alongside product activity: improvement on unseen timed material, retention of previously missed skills, writing revision quality, oral task completion, and voluntarily reported exam outcomes. Minutes studied and streaks are supporting measures.

For monetisation, test a fixed-duration exam-preparation package alongside a subscription. This is a product hypothesis rather than researched demand. A one-time purchase can suit a bounded offline course; ongoing hosted AI feedback and speech services need explicit usage economics. Decide from actual learner behaviour and delivery costs before building billing complexity.

Architecture should separate **language**, **exam provider**, **qualification**, **level**, **blueprint version**, **rubric**, **content item** and **attempt**. Translation alone cannot turn one exam course into another certification course. Keep learner evidence tied to the content and rubric version that produced it.
