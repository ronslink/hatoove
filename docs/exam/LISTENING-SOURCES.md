# Fixed listening sources and internal engineering limits

The coordinator rechecked the official pages and DTZ practice set on 3 October 2026 while defining EXAM-S5. These references establish format research; they do not approve Hatoove questions, recordings, translations or reuse of official material.

| Package | Published written structure used by S5 |
|---|---|
| Zertifikat Deutsch / telc Deutsch B1 | Reading and language elements share 90 minutes, followed by listening (approximately 30) and writing (30). Listening has three parts with 5/10/5 items; permitted plays are 1/2/2, retained from the previously verified official model. |
| Deutsch-Test für Zuwanderer, A2–B1 | Listening has four parts with 4/5/8/3 items, approximately 25 minutes, with every recording heard once. Reading has 25 items/45 minutes and writing 30 minutes with an A/B choice. |

Sources: [current telc exam page](https://www.telc.net/sprachpruefungen/deutsch/zertifikat-deutsch-telc-deutsch-b1/), the earlier byte-pinned [telc model verification](TELC-B1-SOURCES.md), [g.a.s.t. DTZ overview](https://www.gast.de/de/forschung-entwicklung/entwicklung/auftraege/deutsch-test-fuer-zuwanderer-dtz/der-dtz-auf-einen-blick), and [official DTZ practice set 2](https://www.gast.de/fileadmin/gast.de/GAST/5_DTZ/PDF/gast_DTZ_UEbungssatz_2.pdf) (answer-sheet numbering on printed page37 was checked in extracted text). No new visual inspection of that answer sheet is claimed here.

Ron's product policy also limits DTZ practice to one play per recording per attempt; a separate mock attempt receives its own allowance. The app is preparation software, not official examination delivery or proctoring. A complete written mock must preserve each target section and its timing. No written-only overall pass prediction is introduced.

`tools/exam-s5-fixture.mjs` generates original deterministic PCM signal tones and German technical test questions. It uses no voice, model, external audio or provider. Its full listening item counts test traversal, marking and playback ownership only. The fixture is written solely into explicitly supplied disposable directories; it is not imported by the default runtime and is not a usable educational listening mock. The UI labels these signals as internal technical material.

Remaining content work is explicit: original spoken scripts and questions matched to each recording, fixed recorded speech with documented provenance and voice/distribution rights, exact duration/hash checks, qualified educational/audio/translation review, and physical iPhone/Android playback/keyboard testing. No agent can convert technical fixture success into these approvals. New approved media must receive immutable versions; existing run identities and playback consumption remain pinned to their original bytes.
