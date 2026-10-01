# DELETION-WIRE-01 — make the hard delete actually reachable, and fix the deletion checker

**Status:** IN PROGRESS
**Branch:** `codex/deletion-wire-01`
**Base:** `codex/ownapi-03-persistent` @ `e126d8c4b18a2beaf58eca2d279fe8d191e825ae`
**PR:** (opened below)

## Findings addressed

- F1 · HIGH — deletion not wired into the running server (`createPostgresWorld` has no deletion-port seam)
- F2 · HIGH — no provisioned role can run the deletion
- F3 · HIGH — `no-op-step` failure mode is a second throw; the port's read-back is exercised by no check
- F4 · MEDIUM — dangling pointer to `HARD-DELETE-01.md §6`
- F5 · MEDIUM — `ACCOUNT_TABLES` omits `drafts`; comment overstates read-back
- F6 · MEDIUM — `FOR UPDATE` on `"user"` does not serialize `submit()`; lock order fix
- F7 · MEDIUM — reply reports `removed` without qualification
- F8 · MEDIUM — `DELETION_NOT_REMOVED` omits the model provider
- F9 · LOW — `legacy_progress_file` wording untrue under `B1PREP_ACCOUNTS=1`
- F10 · LOW — `Content-Type` requirement on a bodyless DELETE; record footgun
- F11 · LOW — idempotence assertion passes vacuously
- F12 · LOW — discrimination claim about `e621618` is wrong

## Step log

(commits pushed per step; verbatim outputs recorded as steps complete)
