# S6-SPEC — the owned list/resume route, and why it is a datastore change first

| | |
|---|---|
| Why | issue #63's **S6**, and the concrete gap Claude found: **there is no route to list an account's saved work**, so a fresh browser cannot resume a draft. That is the remaining half of the milestone sentence *"a fresh browser must list or resume its account's saved work without importing local files"* |
| Status | **specification only — no code changed.** Recorded so the slice starts without re-deriving, exactly as `WRITING-SURFACE-01.md` was |
| Read from | `server/owned-api.mjs` and `server/owned-postgres/adapter.mjs` at `271a366` |

## The finding that makes this bigger than "add a route"

**The datastore cannot enumerate.** Its entire interface is:

```
create(owner, parent)      read(owner, id)      result(owner, submissionId)      retry(owner, submissionId)
```

Every read is **by id**, and every id has to come from somewhere else. **There is no `list(owner)` of any kind.** So a
list route is not a handler bolted onto the owned API — it needs a **new datastore capability**, and that capability
is the part with the security properties.

The owned API's current route table, for reference:

| Route | Present |
|---|---|
| `GET /api/v1/account` | yes |
| `GET`/`PUT /api/v1/settings` | yes |
| `POST /api/v1/attempts` | yes |
| `GET /api/v1/attempts/:id` | yes |
| `POST /api/v1/attempts/:id/submissions` | yes |
| `GET /api/v1/submissions/:id` | yes |
| `POST /api/v1/submissions/:id/retry` | yes |
| **anything that lists** | **no** |

## What the slice needs, in order

1. **A datastore `list(owner, {limit, cursor})`** — the security-critical part, because it is the first query that
   returns **many** of an owner's rows rather than one row the caller already named. It must:
   - filter on `owner_id` **in the query** and rely on `FORCE ROW LEVEL SECURITY` as the second line, not the first
     — a list that returns another owner's rows is the failure this exists to prevent;
   - be **deterministically ordered** (a stable key, not insertion luck) so pagination cannot skip or repeat;
   - be **bounded by default** and refuse an absurd `limit` rather than accepting it;
   - return **only ids, timestamps and the small fields a list needs** — not the learner's text. A list screen that
     ships every draft's full body is a privacy decision nobody made.
2. **`GET /api/v1/attempts` and a drafts listing**, session-derived owner only. **No owner parameter, no header, no
   query-string owner** — the runtime refusals slice just removed exactly that pattern from the legacy path, and it
   must not reappear here.
3. **`GET /api/v1/drafts`** or an attempts listing that carries draft state, whichever the writing surface actually
   needs. Decide from the surface, not from convenience.
4. **Pagination that a client can trust** — cursor-based, and the cursor must not be forgeable into another owner's
   range.
5. **A checker** proving: A's list contains A's work and **not** B's; the order is stable across calls; the bound
   holds; and **discrimination** — remove the `owner_id` filter in a scratch copy and the check must fail.

## The acceptance bar, stated so it cannot be met vacuously

- **Two accounts, both with attempts and drafts**, each listing only its own — counted, not asserted by inspection.
- **A stable order**: the same list twice returns the same sequence.
- **A bound**: `limit` above the maximum is refused, not silently clamped *and not silently honoured*.
- **No owner parameter anywhere** in the request surface.
- **Test the owner predicate and RLS INDEPENDENTLY, as well as together.** This corrects the first version of this
  document, which said "remove the `owner_id` predicate and the check must fail". **That expectation is wrong**, and
  an independent audit caught it: with `FORCE ROW LEVEL SECURITY` still active, removing an explicit SQL owner
  filter does **not** leak another account's rows — RLS is the second line and it holds. Three separate checks:
  1. **the predicate alone** — with RLS **disabled** for the test role, removing the predicate leaks, so the check
     fails and the predicate is proven load-bearing;
  2. **RLS alone** — with the predicate removed but RLS **active**, the query still returns only the owner's rows,
     which is the defence working as designed;
  3. **together** — the normal path returns exactly the owner's rows.
  **A safe result from the remaining protection is the expected outcome, not a reason to weaken it.** A check that
  demanded a leak from a correctly-configured database would be a broken check.
- **Stable task identity and version in the contract.** A discovered draft must be able to recover **its actual
  prompt**, so the task id and version are part of what enumeration returns. Without that, a fresh browser can find
  that a draft exists and not what it was about, and the milestone sentence — resume its account's saved work —
  would be only half met.

## Why this is not in the same slice as the session boundary

The session boundary made a draft **survive within a session**; this makes saved work **findable later**. They are
different layers — client and server — and the boundary's own record says plainly that the fresh-browser half is
**not** delivered by it. Keeping them separate is what stops the milestone being reported as closer than it is.

## What is still unverified about the *need*

The session-boundary worker reported that a fresh browser **does** resume the notebook, ability record, history and
settings from the server — only **drafts and writing** are unreachable, because there is no list route. **Confirm
that boundary before building**, so the slice lists what is genuinely missing rather than duplicating something the
account record already carries.
