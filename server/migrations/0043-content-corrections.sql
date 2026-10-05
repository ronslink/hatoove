-- CONTENT-CORRECTIONS (MIRROR-B1PREP-01 §7) — the German source defects, corrected in place.
--
-- WHY A NEW MIGRATION AND NOT A REGENERATED SEED. 0012/0013/0014 are applied in production with frozen
-- checksums. This file ships the correction as an UPDATE against the rows those seeds created, so the applied
-- history is untouched and the applied bytes stay the reviewed ones. It never rewrites a seed file.
--
-- WHAT IT CORRECTS (three defects found while translating the library into uk/ar/tr):
--   1. das Familiemitglied -> das Familienmitglied (de, plural, example).
--   2. die Möbel was glossed as a singular "piece of furniture" and its example sentence used "dieses Möbel"
--      as if Möbel were singular. The gloss is now the plural "furniture" and the example uses the singular
--      das Möbelstück, so the sentence is correct German and keeps its meaning.
--   3. The speaking guide taught Teil 1 as a three-minute presentation. The official Part 1 is getting to know
--      the other candidate, which exam-product-review.md:11-18 records as "Getting to know the other
--      candidate" (source: telc's official B1 model examination, printed pages 5, 18, 34-39). The
--      presentation material is removed rather than relabelled.
--
-- NOT CHANGED, DELIBERATELY: no content_version is bumped (a bump would make every stored translation stale at
-- once), no translation row is touched, and content_version.content_sha256 cannot be updated at all — 0006
-- puts a BEFORE UPDATE trigger on that table. See work/implementation/CONTENT-CORRECTIONS.md §5.
--
-- The counts this touches: 2 noun_entry rows, 1 guide_section row. tools/content-corrections-check.mjs asserts
-- exactly that, and asserts the two corrected noun rows and the SP1 section equal data/noun-lexicon.json and
-- data/speaking-guide.json after this migration runs.

-- telc-deutsch-b1.noun.das-familiemitglied
UPDATE "__SCHEMA__".noun_entry SET de = 'das Familienmitglied', plural = 'die Familienmitglieder', example = 'Jedes Familienmitglied bringt etwas zum Buffet mit.'
 WHERE entry_id = 'telc-deutsch-b1.noun.das-familiemitglied';

-- telc-deutsch-b1.noun.die-moebel
UPDATE "__SCHEMA__".noun_entry SET en = 'furniture', example = 'Dieses Möbelstück passt überhaupt nicht in unser Wohnzimmer.'
 WHERE entry_id = 'telc-deutsch-b1.noun.die-moebel';

-- telc-deutsch-b1.speaking-guide.sp1 — Teil 1 was taught as a three-minute presentation; the official
-- task for Part 1 is getting to know the other candidate (exam-product-review.md:11-18). The presentation
-- material is removed, not relabelled (the defect is that it teaches the wrong task).
UPDATE "__SCHEMA__".guide_section
   SET title = 'Teil 1 – Sich kennenlernen', title_en = 'Part 1 – Getting to know each other',
       summary = 'In Teil 1 halten Sie keinen Vortrag: Die Kandidaten lernen sich kennen und beantworten einfache Fragen zur eigenen Person. Die Prüfer achten auf die direkte Interaktion zwischen den Kandidaten.', summary_en = 'In Part 1 you do not give a presentation: the candidates get to know each other and answer simple questions about themselves. The examiners focus on direct interaction between the candidates.',
       payload = '{"minutes":null,"approach":[{"step":"Auf die Fragen zur eigenen Person antworten","detail":"Antworten Sie in ein bis zwei Sätzen. Name, Wohnort, Beruf oder Ausbildung und ein Hobby genügen.","seconds":null,"stepEn":"Answer the questions about yourself","detailEn":"Answer in one or two sentences. Your name, where you live, your job or training and one hobby are enough."},{"step":"Selbst einfache Fragen stellen","detail":"Stellen Sie dem Partner ein oder zwei kurze Fragen, zum Beispiel nach dem Wohnort, der Arbeit, den Sprachen oder der Freizeit.","seconds":null,"stepEn":"Ask simple questions yourself","detailEn":"Ask your partner one or two short questions, for example about where they live, their work, languages or free time."},{"step":"Auf die Antworten reagieren","detail":"Reagieren Sie kurz auf das, was der Partner sagt, und fragen Sie einmal nach. So entsteht ein Gespräch und kein Monolog.","seconds":null,"stepEn":"React to the answers","detailEn":"React briefly to what your partner says and ask one follow-up question. That keeps it a conversation instead of a monologue."}],"phrases":[{"group":"Über sich selbst sprechen","groupEn":"Talking about yourself","hint":"Mit diesen Sätzen beantworten Sie die Fragen zur eigenen Person kurz und klar.","hintEn":"With these sentences you answer the questions about yourself briefly and clearly.","items":[{"de":"Ich heiße … und komme aus …","en":"My name is … and I come from …","example":"Ich heiße Olena und komme aus Lwiw."},{"de":"Ich wohne seit … in …","en":"I have been living in … since …","example":"Ich wohne seit zwei Jahren in Hamburg."},{"de":"Ich arbeite als … / Ich lerne noch.","en":"I work as … / I am still studying.","example":"Ich arbeite als Krankenschwester."},{"de":"In meiner Freizeit … ich gern.","en":"In my free time I like …","example":"In meiner Freizeit schwimme ich gern."}]},{"group":"Fragen an den Partner","groupEn":"Questions for your partner","hint":"Stellen Sie diese Fragen selbst, damit ein Gespräch entsteht.","hintEn":"Ask these questions yourself so that a conversation develops.","items":[{"de":"Woher kommen Sie?","en":"Where are you from?","example":"Woher kommen Sie, Herr Yilmaz?"},{"de":"Was machen Sie beruflich?","en":"What do you do for a living?","example":"Was machen Sie beruflich?"},{"de":"Wie lange lernen Sie schon Deutsch?","en":"How long have you been learning German?","example":"Wie lange lernen Sie schon Deutsch?"},{"de":"Was machen Sie gern in Ihrer Freizeit?","en":"What do you like doing in your free time?","example":"Was machen Sie gern in Ihrer Freizeit?"}]},{"group":"Reagieren und nachfragen","groupEn":"Reacting and asking again","hint":"Kurze Reaktionen zeigen, dass Sie zuhören und wirklich sprechen.","hintEn":"Short reactions show that you are listening and really speaking.","items":[{"de":"Interessant — und wie ist das bei Ihnen?","en":"Interesting — and what is it like for you?","example":"Interessant — und wie ist das bei Ihnen?"},{"de":"Das ist schön. Erzählen Sie bitte mehr.","en":"That is nice. Please tell me more.","example":"Das ist schön. Erzählen Sie bitte mehr."},{"de":"Und Sie? Was denken Sie?","en":"And you? What do you think?","example":"Und Sie? Was denken Sie?"}]}],"examples":[{"topic":"Ein kurzes Kennenlernen","topicEn":"A short getting-to-know exchange","text":"A: Guten Tag, ich heiße Sara und komme aus Valencia. Und Sie? B: Guten Tag, ich bin Mehmet und wohne seit drei Jahren in Köln. A: Was machen Sie beruflich? B: Ich arbeite als Elektriker. Und was machen Sie gern in Ihrer Freizeit? A: Ich lese viel und spiele Volleyball."}],"watchOut":["In Teil 1 halten Sie keinen Vortrag und arbeiten nicht mit Stichwörtern auf einer Aufgabenkarte.","Ein bis zwei Sätze pro Frage genügen; lange Antworten lassen keine Zeit für den Partner.","Reagieren Sie auf den Partner: Die Prüfer achten auf die direkte Interaktion, nicht auf einen Monolog."],"watchOutEn":["In Part 1 you do not give a presentation and you do not work from keywords on a task card.","One or two sentences per question are enough; long answers leave no time for your partner.","React to your partner: the examiners focus on direct interaction, not on a monologue."]}'::jsonb
 WHERE guide_id = 'speaking-guide' AND section_id = 'telc-deutsch-b1.speaking-guide.sp1';
