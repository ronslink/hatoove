# PILOT-01-CSS: verify and fix bounded responsive defects

Status: ready specification, **not an active writing grant**. Coordinator dispatch must supply current base, execution, branch/worktree, occupied slot, lease and issue before edits. Dependencies: PRE-04 reference and USER-01 source review. Independent reviewer: coordinator plus browser evidence.

Allowed source paths for future CSS writer: `public/studio.css`, `public/styles.css`; report/evidence only under `work/implementation/PILOT-01-CSS/`. No JS, markup, backend, board or shared `public/js/exam.js` changes. Preserve palette, typography and desktop composition.

USER-01 / user01-20260930-a returned a read-only report through Ron. It made no changes and released slot 4. Coordinator dispositions:

- D1: source confirms writing text is absent from durable state. Split to PILOT-02-DRAFT below; never patch this into the global legacy progress blob.
- D2: **unverified** tablet overflow hypothesis. The report treats `minmax(0,1.8fr)` as a fixed minimum, and overlooks the existing single-column rule below 1050 px in its 1024 px example. Reproduce at 1024/1180 before changing breakpoints; no automatic 1320 px change that alters the 1280 reference.
- D3: **rejected as stated**. `public/js/app.js` already assigns `sidebar.inert = Boolean(isMobile && !drawerOpen)` and removes `aria-hidden` in the else branch, including desktop. Keep rotation/navigation checks; do not add a redundant fix.
- D4: focus-loss claim is browser-dependent and unverified; existing close control means zero focusables is not demonstrated. Separate shell reproduction task if observed.
- D5: phone nested passage scrolling is source-backed; test page-scroll alternative at <=600 px while retaining desktop caps.
- D6: narrow stat nowrap overflow is plausible; reproduce with realistic synthetic long values, then allow phone text wrapping/min-width correction as needed.
- D7: actual software-keyboard behavior remains unverified; `dvh` is dynamic viewport height, not the large viewport unit (`lvh`). Do not change keyboard viewport metadata from this report alone.
- D8: source overrides outline but already provides border and 3 px box-shadow focus. Test visibility/contrast before describing it as no focus indication. A consistent explicit `:focus-visible` ring is an allowed incremental fix if verified.

Acceptance: isolated source-only checkout with no .env/progress; synthetic fixture server on an explicitly assigned loopback port, no live AI/TTS. Do not run generic legacy browser scripts without inspecting their startup/data hazards. Capture before/after at 320x568, 390x844, 768x1024, 1024x768, 1180x820, 1280x800 and text zoom. Compare desktop reference, scrollWidth/clientWidth, stat overflow, entire passage access and visible keyboard focus. Real iPhone/Android keyboard/audio remains a separate gate. Run the 124 offline checks and staged source guard. Do not merge without independent diff/evidence review.

## PILOT-02-DRAFT — reserved coordinator slice

Status: depends on PRE-05 contracts and F-02/A-01 owned runtime boundary. Future allowed paths must be finalized at dispatch: `public/js/exam.js`, `public/js/store.js`, a dedicated owned API/cache module and focused integration checks. No worker concurrently owns exam.js.

Use server-owned task identity and draft revision, stable local pending-event ID, account-scoped pending text, and visible saving/conflict/offline states. Restore exact prompt/text after navigation/reload and second-device login. Flush/cancel on lifecycle changes without switching ownership. Preserve immutable submission and create a child attempt for revision. Sign-out clears private cache and suppresses late responses. Tests include failed feedback, lost acknowledgement, conflicting devices, tab discard, account switch and delete/replay. Preserve learner appearance and supply desktop/phone evidence.
