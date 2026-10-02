-- PILOT-06 / D4-R11 — THE WRITING RUBRIC IS telc DEUTSCH B1's OWN STRUCTURE.
    --
    -- Ron, 2 October 2026: *"i would lean to sticking with what is actually tested and how its graded"* —
    -- so the writing feedback follows the exam's marking structure: three criteria
    -- (Aufgabenbewältigung, Kommunikative Gestaltung, Formale Richtigkeit), each marked with a BAND
    -- A/B/C/D = 5/3/1/0 points, x3, so each criterion is
    -- out of 15 and the written paper is out of 45.
    --
    -- WHY NEW ROWS AND NOT AN EDIT. The catalogue is immutable: `content_immutable` and
    -- `rubric_version_immutable` refuse UPDATE and DELETE outright, which is what makes an attempt's
    -- `task_version`/`rubric_version` a durable claim about exactly what it answered. So the six prompts
    -- are RE-BOUND at task version `v2` — the prompt text is unchanged — and every row
    -- already bound to the retired four-criterion rubric `writing.formative@v1` stays
    -- where it is, rendering as the contract it was graded under. THE TWO ARE NEVER RENORMALISED OR
    -- RELABELLED INTO EACH OTHER.
    --
    -- PROVISIONAL. Every row carries `unreviewed` and the descriptors in the criteria JSON are marked
    -- `provisional`: the structure can be built, but calling it ACCURATE cannot happen until E-01 — a
    -- qualified reviewer confirming the criteria and band values against telc's current model exam. The
    -- descriptors are WRITTEN FOR THIS PRODUCT; telc's published descriptor text is not copied.
    --
    -- Generated from `server/owned-postgres/content-seed.mjs` so the digests, the criteria JSON and the
    -- task bindings cannot drift from the seed or from what the validator checks.

    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
    ('writing.telc-b1@v1', 'rubric', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'f24dcaed37d906feef9511d79f09bc0268533874cc6187d6a02c676d188965aa', 'telc-deutsch-b1'),
    ('writing.du.besuch-einer-freundin@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'c91613ed573921b93b59e30660273a30954f385eb3ce929cf2313e2397163583', 'telc-deutsch-b1'),
    ('writing.du.geburtstag-eines-freundes@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', '2956f3d666a1ea8ef43eb756c78f860c54d2ddf08cdebd496e27e87d0793c9e8', 'telc-deutsch-b1'),
    ('writing.du.umzug-und-hilfe@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', '5a9c7e41290dfdd691d0e4b4ffe4a3efe316c01b68dbd11df170124c899facff', 'telc-deutsch-b1'),
    ('writing.sie.sprachkurs@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'b6523e266672042543e709f4f2facf7235297d315948701c73f36f59cd97b2f2', 'telc-deutsch-b1'),
    ('writing.sie.termin-mit-dem-vermieter@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'eb7bc859a8b90684cc5dc0b0165cac79847d990e08a4532633e12905559ccaf4', 'telc-deutsch-b1'),
    ('writing.sie.ausflug-mit-dem-sportverein@v2', 'task', 'writing', 'public/js/ai.js#OFFLINE_WRITING_TASKS', 'unreviewed', 'unknown', 'da4a182be86408713e199f16f9211cd25515986170fbec096808f761389cb933', 'telc-deutsch-b1')
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".rubric_version
      (rubric_id, version, family, criteria, max_total, content_version_id, exam_id)
    VALUES
    ('writing.telc-b1', 'v1', 'writing', '[{"key":"aufgabe","label":"Aufgabenbewältigung","max":15,"factor":3,"bands":{"A":5,"B":3,"C":1,"D":0},"descriptors":{"A":"Alle Leitpunkte behandelt, mit klarer Absicht und passendem Umfang.","B":"Die Leitpunkte überwiegend behandelt; einzelne Punkte knapp oder ungenau.","C":"Mehrere Leitpunkte fehlen oder sind nur angedeutet.","D":"Die Aufgabenstellung wird nicht erkennbar bearbeitet."}},{"key":"kommunikation","label":"Kommunikative Gestaltung","max":15,"factor":3,"bands":{"A":5,"B":3,"C":1,"D":0},"descriptors":{"A":"Textsorte, Anrede und Register durchgehend passend und flüssig verbunden.","B":"Textsorte und Register überwiegend passend; Verbindungen teils einfach.","C":"Textsorte oder Register nur teilweise getroffen; wenig verbunden.","D":"Keine erkennbare Textsorte oder durchgehend unpassendes Register."}},{"key":"richtigkeit","label":"Formale Richtigkeit","max":15,"factor":3,"bands":{"A":5,"B":3,"C":1,"D":0},"descriptors":{"A":"Kaum Fehler; was falsch ist, behindert das Verständnis nicht.","B":"Einzelne Fehler, die das Verständnis nicht wesentlich stören.","C":"Häufige Fehler, die das Verständnis an einzelnen Stellen stören.","D":"Fehler prägen den Text; das Verständnis ist über weite Strecken erschwert."}}]'::jsonb, 45, 'writing.telc-b1@v1', 'telc-deutsch-b1')
    ON CONFLICT (rubric_id, version) DO NOTHING;

    INSERT INTO "__SCHEMA__".task_version
      (task_id, version, family, register, topic, situation, adressat, leitpunkte,
       rubric_id, rubric_version, content_version_id, exam_id)
    VALUES
    ('writing.du.besuch-einer-freundin', 'v2', 'writing', 'du', 'Besuch einer Freundin', 'Ihre Freundin Anna möchte Sie im nächsten Monat besuchen. Sie fragt, wann sie kommen kann und was Sie gemeinsam unternehmen können. Antworten Sie ihr per E-Mail.', 'Ihre Freundin Anna (du)', '["Schlagen Sie einen Termin für den Besuch vor.","Erklären Sie, wie Anna am besten zu Ihnen kommt.","Beschreiben Sie, wo Anna übernachten kann.","Schlagen Sie gemeinsame Aktivitäten vor."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.du.besuch-einer-freundin@v2', 'telc-deutsch-b1'),
    ('writing.du.geburtstag-eines-freundes', 'v2', 'writing', 'du', 'Geburtstag eines Freundes', 'Ihr Freund Max hat Sie zu seiner Geburtstagsfeier eingeladen. Sie möchten kommen, können aber erst später da sein. Antworten Sie auf seine Einladung.', 'Ihr Freund Max (du)', '["Bedanken Sie sich für die Einladung und sagen Sie zu.","Erklären Sie, warum Sie später kommen.","Sagen Sie, wann Sie ungefähr ankommen.","Fragen Sie, was Sie für die Feier mitbringen können."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.du.geburtstag-eines-freundes@v2', 'telc-deutsch-b1'),
    ('writing.du.umzug-und-hilfe', 'v2', 'writing', 'du', 'Umzug und Hilfe', 'Sie ziehen bald in eine neue Wohnung. Ihre Freundin Julia hat Ihnen Hilfe angeboten und möchte wissen, was noch zu tun ist. Schreiben Sie ihr eine E-Mail.', 'Ihre Freundin Julia (du)', '["Bedanken Sie sich für das Hilfsangebot.","Beschreiben Sie Ihre neue Wohnung.","Nennen Sie den Termin und den Treffpunkt für den Umzug.","Erklären Sie, wobei Julia Ihnen helfen kann."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.du.umzug-und-hilfe@v2', 'telc-deutsch-b1'),
    ('writing.sie.sprachkurs', 'v2', 'writing', 'Sie', 'Sprachkurs', 'Sie haben einen Deutschkurs besucht und möchten sich bei Ihrer Kursleiterin bedanken. Leider konnten Sie an den letzten zwei Terminen nicht teilnehmen.', 'Ihre Kursleiterin Frau Berger (Sie)', '["Bedanken Sie sich für den Kurs.","Erklären Sie, warum Sie zweimal gefehlt haben.","Fragen Sie, ob Sie die Unterlagen noch bekommen können.","Fragen Sie nach einem passenden Folgekurs."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.sie.sprachkurs@v2', 'telc-deutsch-b1'),
    ('writing.sie.termin-mit-dem-vermieter', 'v2', 'writing', 'Sie', 'Termin mit dem Vermieter', 'Ihr Vermieter Herr Weber möchte sich am Freitag die defekte Heizung in Ihrer Wohnung ansehen. Zu diesem Termin können Sie nicht zu Hause sein. Schreiben Sie ihm eine E-Mail.', 'Ihr Vermieter Herr Weber (Sie)', '["Bedanken Sie sich für seine Nachricht.","Beschreiben Sie das Problem mit der Heizung.","Erklären Sie, warum Sie am Freitag keine Zeit haben.","Schlagen Sie einen neuen Termin vor."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.sie.termin-mit-dem-vermieter@v2', 'telc-deutsch-b1'),
    ('writing.sie.ausflug-mit-dem-sportverein', 'v2', 'writing', 'Sie', 'Ausflug mit dem Sportverein', 'Ihre Trainerin Frau Neumann organisiert einen Ausflug mit dem Sportverein. Sie möchten teilnehmen und brauchen noch einige Informationen. Schreiben Sie ihr eine E-Mail.', 'Ihre Trainerin Frau Neumann (Sie)', '["Sagen Sie, dass Sie am Ausflug teilnehmen möchten.","Fragen Sie nach dem Treffpunkt und der Abfahrtszeit.","Fragen Sie nach den Kosten.","Bieten Sie Hilfe bei der Vorbereitung an."]'::jsonb, 'writing.telc-b1', 'v1', 'writing.sie.ausflug-mit-dem-sportverein@v2', 'telc-deutsch-b1')
    ON CONFLICT (task_id, version) DO NOTHING;

