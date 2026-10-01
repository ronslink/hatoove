# SESSION-FENCE-03 — F-A: fence the mock and speaking late writers

- Status: working
- Owner: Hetzner OpenClaw worker (bounded assignment)
- Branch: `codex/session-fence-03`
- **Base: `codex/session-fence-02` @ `2633ffec5ba71ea6445be0f7cbcf047f18721f68`**
- PR: (opened after the first push) against `codex/ownapi-03-persistent`
- Continuing PR #77's slice: this branch carries #77's commits (F-C and F-B) as its base.

```text
$ git rev-parse origin/codex/session-fence-02
2633ffec5ba71ea6445be0f7cbcf047f18721f68
```

The base matches the dispatch. F-C and F-B are already done and green on this base, so this
run touches **F-A only**. Anything adjacent that is noticed is recorded under LIMITS as
"seen, not fixed" and left alone.

## Scope

**F-A only.** The mock-test gate and the speaking gate both write learner state after an
`await` with no `store.scopeToken()` on the path, so an answer for account A that resolves
after a sign-out or a same-page switch lands in the NEXT account's record (the mock gate's
`isCurrent` compares the resumed session to itself). The DOM half: the mock writing textarea
is repainted with the previous account's text on a signed-out page.

## Findings

| ID | Severity | State |
|----|----------|-------|
| F-A | HIGH | in progress |

## Checks

Failing check written and committed first, then made to pass. Every check has a
discrimination leg (break the fix in a scratch copy, watch it fail, restore). Verbatim
output is quoted per check below.

## §2 answers (repaint / resume / drop seam)

(filled in after execution)

## LIMITS

(filled in at completion)

## Baseline re-run (observed counters)

(filled in at completion)
