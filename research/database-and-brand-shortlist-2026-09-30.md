# DigitalOcean database reuse and product name shortlist

Prepared 30 September 2026. The owner has an existing DigitalOcean PostgreSQL cluster serving another production application. Reuse is the preferred pilot option if location, permissions and spare capacity are suitable. **Wortstufe** was the initial German-focused name recommendation, with **Nivopra** as an alternative. The current direction is a global, standalone exam-preparation product: German B1 first, possible English exam packages later, with native-language explanations. The learner needs no school or teacher account. The current pilot covers listening and written sections; speaking is deferred. No brand has been selected or purchased. The updated international shortlist below supersedes the earlier German-focused recommendation.

## Database recommendation

Create a separate logical database, provisionally `b1prep`, within the existing cluster. A separate schema can work with carefully restricted permissions, but a separate database makes migrations and logical exports easier to keep independent. Both approaches share the cluster's resources and availability. Adding a logical database does not require another paid cluster; extra load may eventually require an upgrade or a dedicated cluster.

Use dedicated runtime and migration credentials, a small connection pool and capped worker concurrency. Verify inherited permissions because PostgreSQL roles exist across the cluster. Protect the other production application's permissions and trusted sources. Keep fixed, reviewed listening audio in object storage, with content references and written assessment records in PostgreSQL. The pilot needs no learner audio upload or transcription pipeline. Prefer application hosting in the same EU region and VPC as the database, after confirming the actual cluster location.

The [pilot build plan](../PILOT_BUILD_PLAN.md) now describes this conditional architecture, recovery boundaries and the required inspection. No database, user, firewall or other cloud resource was created or changed.

Sources: [DigitalOcean database management](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-users-and-databases/), [PostgreSQL database and schema boundaries](https://www.postgresql.org/docs/current/ddl-schemas.html), [DigitalOcean pricing](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/).

## Actual inspection status

The existing `doctl` configuration contains one context, `default`. Its saved login returned **401 Unauthorized** when requesting the database list. The accessible browser also reached DigitalOcean's login page. Cluster name, region, tier, utilisation and permissions remain unverified.

No existing executable was found in the searched installation locations. An official `doctl` 1.175.0 Windows binary was downloaded to the temporary directory and verified against the release's SHA-256 checksum. It can use the existing configuration after the owner refreshes authentication locally:

```powershell
& "$env:TEMP\b1prep-doctl-1.175.0\doctl.exe" --config "$env:APPDATA\doctl\config.yaml" auth init --context default
```

Enter credentials only into the local CLI. The inspection needs no production mutations.

## Earlier German-focused names and domains

Keep the brand independent of exam provider and language level. Use a descriptor such as **Deutschprüfung üben** and offer telc B1, DTZ and Goethe B1 as distinct product tracks when their content is ready.

| Name | Rationale | `.de` status | `.com` status |
|---|---|---|---|
| **Wortstufe** | German language-learning identity; permits later B2 expansion | Available in DENIC check | Available in Vercel registrar check |
| **Nivopra** | Short coined name; broader international identity, needs an explanatory descriptor | Available in DENIC check | Available in Vercel registrar check |
| **Lernsteg** | Broad, approachable learning name | Already registered | Available in Vercel registrar check |

DENIC checks at 11:14 CEST on 30 September 2026 returned HTTP 404 for `wortstufe.de` and `nivopra.de`, and HTTP 200 for `lernsteg.de`. These were HEAD requests to `https://rdap.denic.de/domain/<domain>`. [DENIC defines 404 as free and 200 as registered](https://www.denic.de/services/whois-service/rdap-service/).

Vercel's live domain-search API quoted **USD 11.25 for one-year registration and USD 11.25 for renewal** for each listed `.com`, with no premium flag. Tax treatment was not established. Availability and prices can change before checkout. Vercel does not support `.de`; its initial false availability responses for that TLD must not be interpreted as registration status. No `.de` retail price was verified.

A basic exact-name web search found no obvious education-brand collision for Wortstufe or Nivopra. Searches inside the trademark registers and similarity clearance remain outstanding. Domain availability does not establish trademark rights; see [DPMA's research guidance](https://www.dpma.de/marken/markenrecherche/index.html).

## International name for standalone exam preparation

The brand should address the individual who already has a language foundation and is preparing for a specific examination. Keep the name independent of German, B1, a particular exam provider and any school structure. Use the descriptor **Focused exam practice** or **Exam prep, clearly explained**. Avoid Academy in the proposed public identity because it suggests a broader teaching institution. The existing Certa Academy design label has not been renamed in code.

**Earlier international candidate: Nivopora.** This is the eight-letter form, distinct from the earlier seven-letter Nivopra. Its proposed pronunciation is nee-voh-POH-rah; the extra vowel breaks up the compressed ending. It is a coined parent brand, with no claimed translation or universal cross-language meaning. Its main weakness is that it needs a descriptor to communicate exam preparation. Initial searches found fewer relevant near-name concerns than the other finalists; this is a limited search observation, not proof of global uniqueness. The owner subsequently requested a Swahili-based direction, explored below; no name has been selected.

| Candidate | Fit and tradeoff | Exact `.com` registrar result |
|---|---|---|
| **Nivopora** | Neutral across exam languages and levels; four syllables; needs the exam-prep descriptor and a spelling/recall test | Available; USD 11.25 registration and USD 11.25 renewal for one year; non-premium |
| **Exavela** | Shorter, with a possible exam association; pronunciation may vary; nearby Exavel operates in software and AI | Available; USD 11.25 registration and USD 11.25 renewal for one year; non-premium |
| **Prepolia** | Prep makes the purpose easier to recognise; pronunciation needs testing; similar Prepoli has existing uses, including education references | Available; USD 11.25 registration and USD 11.25 renewal for one year; non-premium |

Vercel's live domain-search API returned these results at approximately **12:11 CEST on 30 September 2026**. Taxes were not established and availability can change before checkout. Nothing was purchased or reserved. Registrar choice is independent of where the application is hosted.

The screen used exact-name and selected spelling-variant web searches, plus live registrar queries. No exact education/app brand was identified for the three finalists in those results. Nearby uses matter: [Exavel Technologies](https://www.exaveltech.com/blog/prototype-to-production-engineering-playbook) operates in software/AI; [Prepoli](https://www.prepoli.com/) is an insulation business, and a [Peruvian school competition's published results](https://www.pitagorasjauja.com/upldba/archvs/1/fot_773.pdf) identify a school named Prepoli Sigma. These findings do not establish trademark rights or decide whether the proposed names conflict.

Several superficially attractive alternatives were rejected. **Examiko** had an available `.com`, but is too close to the existing [Examico](https://examico.ai/) exam product and [Examigo](https://www.examigo.in/terms-and-conditions). **Examora** is already used by [exam-preparation products](https://www.examoraapp.com/). **Certivo** is used by a [certification service](https://certivo.org/). **Prepovia** had an available `.com`, but a [creator's own profile](https://ng.linkedin.com/in/segunogunsunlade) lists a WAEC/JAMB preparation project with that exact name. A domain being available was therefore not sufficient to recommend a name.

Proposed brand structure, if Nivopora is selected:

- **Nivopora — Focused exam practice** as the parent identity.
- **German B1: preparation for telc Deutsch B1** as the first package, explicitly covering listening and written sections.
- Separate DTZ, Goethe or English examination packages only when their own content is ready.
- Localised descriptions and instruction languages under the same parent name; regional prices are independent of that language choice.

Before treating any candidate as final, check trademark registers and similar marks in intended markets, and test pronunciation, spelling and unintended associations with native speakers in the first launch languages. Chinese characters or another local-script name need their own linguistic and name checks. This research did not perform register-level clearance, social-handle checks or native-speaker validation. No claim is made that a Latin-letter name alone is validated for China or every other market.

## Swahili-based direction

The owner requested this direction while clarifying that the product should prepare individuals for precise exam requirements. Readiness, progress and practice are relevant roots; a name need not suggest a school or a general language course.

| Root | Sourced meaning | Naming finding |
|---|---|---|
| **Hatua** | Step; progress or advancement | Strong brand story for targeted steps toward an exam. Exact `.com` unavailable; existing education uses include Hatua Network and InspireHatua |
| **Tayari** | Ready or prepared | Closest meaning to exam preparation, but existing Tayari exam-prep products make the unmodified name a poor choice |
| **Zoezi** | Exercise; practice | Relevant to the product activity; exact `.com` unavailable |

Meaning sources: [TUKI entry for hatua](https://swahili-dictionary.com/swahili-english/hatua_hatua), [tayari dictionary entry](https://en.wiktionary.org/wiki/tayari), [University of Georgia Kiswahili exercise material](https://africa.uga.edu/Kiswahili/doe/unit_01/section_A/exercise01.html), [zoezi dictionary entry](https://en.wiktionary.org/wiki/zoezi). Existing uses include [Hatua Network's curriculum](https://curriculum.hatuanetwork.org/local/pages/?id=2), [InspireHatua](https://play.google.com/store/apps/details?id=tz.co.hatua.inspire), [myTayari](https://www.mytayari.com/) and [Tayari by Target](https://tayari.in/faqs).

**Initial Swahili-inspired candidate: Hatuvi**, proposed pronunciation **ha-TOO-vee**. It is a coined brand inspired by *hatua*, not a dictionary Swahili word and not a translation of "pass the exam". Six letters, three proposed syllables, no accents or consonant clusters, and no language or proficiency-level restriction make it worth testing internationally. These are design judgments, not native-speaker validation. Suggested presentation: **Hatuvi — Focused exam practice**. Product pages can then identify the exact examination and supported sections. The owner's subsequent Hatoove proposal is recorded below.

**Tayarika** is a second candidate if a form more closely connected to the original language is preferred. The cited *tayari* entry lists *-tayarika* as its stative derivation. Confirm the natural standalone sense with a native speaker before assigning it an English brand meaning. Its proximity to the crowded Tayari exam-preparation name is a drawback even though the exact domain is available.

On 30 September 2026, Vercel's live registrar API returned **hatuvi.com** and **tayarika.com** as available, non-premium, each **USD 11.25 for one-year registration and USD 11.25 for renewal**. Taxes were not established; no purchase or reservation occurred. Exact-name searches did not identify an obvious app or education brand for either, but root-name uses remain relevant. Trademark similarity checks and native-speaker pronunciation/association checks remain unperformed. Neither candidate has been adopted in the application.

## Owner's Hatoove proposal

The owner suggested **Hatoove** as a name with a better ring. It is a strong candidate for the independent exam-preparation product and remains a proposal, not a selected or registered brand. The spelling suggests **ha-TOOV**, rhyming with *move*, to an English reader; it does not reliably communicate Hatuvi's three-syllable ha-TOO-vee. The double o supports the long vowel, while the final e creates a possible hearing-to-spelling error, Hatoov. Test that distinction with intended users rather than assuming identical pronunciation globally.

Hatoove retains room for multiple examinations and target languages. Describe it as a coined brand inspired by the earlier Swahili-root naming discussion, not a Swahili word with a literal translation. A suitable presentation is **Hatoove — Know the exam. Practise what matters.**

At approximately **13:12 CEST on 30 September 2026**, Vercel's live domain-search API returned **hatoove.com available**, non-premium, at **USD 11.25 for one-year registration and USD 11.25 renewal**. Taxes were not established; availability can change. Exact-name web searches found no obvious indexed education, app or company brand; returned incidental text/OCR matches were not evidence of such a brand. This was not a trademark-register or comprehensive phonetic-similarity search. No purchase, reservation, application rename or native-speaker validation has occurred.
