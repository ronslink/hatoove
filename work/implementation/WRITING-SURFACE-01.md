# WRITING-SURFACE-01 — the plan to wire the draft service into the writing surface

| | |
|---|---|
| Why this exists | the objective's item (3), *"wire `draft-session.js` into the exam writing surface"*, is the oldest unstarted item on the list. This is the **plan**, written so the slice can start without re-deriving anything |
| Status | **plan only — no code changed.** `public/js/exam.js` is untouched |
| Read from | `origin/codex/session-boundary-01` @ `521e383`, which is where the prerequisites now exist |
| Blocked on nobody | deliberately **not** started in the same session as the session boundary, because both would touch the same wiring and one would have to be reviewed on a moving target |

## What already exists, so this is not a from-scratch slice

The session boundary provides exactly the two things the writing surface needs, and they are the reason this is now
tractable at all:

| Provided | Where | What it does |
|---|---|---|
| `session().openDraft(taskId)` | `public/js/account.js:297`, exposed at `:317` | opens the account's draft for a task through the boundary |
| `session().saveSettings` / the client behind it | `public/js/account.js:343-347` | the one transport; the boundary is the only thing that should drive it |
| `createDraftSession(...)` | `public/js/draft-session.js` | the service itself, proven by `draft-session-check` **18/18** including the fence check added in #51's review |

**Both had no application caller before the session boundary landed.** That was issue #63's S4 complaint in one line.
The boundary gives them a caller; this slice gives the writing surface a reason to use it.

## The concrete gap

`public/js/exam.js` writes through the **local store**:

- `recordSetAttempts(partId, set, result, source)` at `public/js/exam.js:506` calls `store.recordAttempt({...})`
  per item (`:509`). That covers the **choice-based** parts — reading, listening, language elements.
- The **writing** part is the one that needs `draft-session.js`, because writing is where a learner produces text
  over time and can leave — which is precisely the recoverable-draft case.

## The slice, in the order it should be done

1. **Find the writing entry point** and the exact place its text is currently persisted. Do this by reading, not by
   assuming: `exam.js` is 1643 lines and the writing flow may persist through `store.saveNow()` or a direct
   `store.recordAttempt` rather than an obvious "save draft" function.
2. **Render the draft through the boundary.** On entering a writing task, open the account's draft via
   `session().openDraft(taskId)` and populate the textarea from it. On the **single-user path** (accounts off or
   never signed in) behaviour must be **exactly as today** — the same hard constraint the session boundary was held
   to, and the reason that slice landed safely.
3. **Save through the boundary**, debounced, with the revision the draft was opened at, so a second device cannot
   silently overwrite (the server answers `409`).
4. **Handle the conflict honestly.** A `409` must not silently discard the learner's text. Offer the same choice the
   draft service already models rather than inventing a third behaviour.
5. **Restore on return.** Leaving the writing screen and coming back must resume the draft — this is the property
   that makes the slice worth doing, and it is the one to write the check around **first**.

## The check, and the property it must discriminate

`tools/writing-draft-check.mjs`, following the real-server-process pattern of `tools/accounts-http-check.mjs`:

- **leave and return**: text written, the screen left, the screen re-entered → the text is there;
- **another device**: the same account on a second simulated session opens the draft;
- **the fence**: a stale save is **refused** and the text is **proven unchanged** — assert the stored value, not the
  status code;
- **single-user path unchanged**: accounts off → the local behaviour, byte-identical, exactly as asserted today;
- **discrimination**: break the restore in a scratch copy and watch the check fail.

## What this deliberately does NOT include

- **No account list or resume route.** A fresh browser cannot list an account's drafts because **the server has no
  such route** — that is issue #63's **S6**, a server-side slice, and it is a *prerequisite* for the
  "fresh browser resumes a draft" half of the milestone. This slice makes a draft **survive within a session**; S6
  makes it **findable later**. Saying so here prevents the two being conflated.
- **No authoritative marking.** Client-side marking is issue #63's S6 too, and it is a separate conversion item.
- **No changes to `draft-session.js`'s contract.** The #51 review already hardened it; this slice consumes it.

## Why this was not started in this session, stated plainly

`public/js/exam.js` is the largest file in the app, the objective item is genuinely a slice rather than an edit, and
starting it while `session-boundary-01` was still being reviewed would have meant two overlapping changes to the same
wiring — the exact problem issue #63 raised about #60, #61 and #62 sitting on different bases. **A plan that the next
session can execute is worth more than a rushed edit at the end of a long one.**
