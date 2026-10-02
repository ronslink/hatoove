# DECISION RECORD — saas-runtime-01: merge now, or review first?

| | |
|---|---|
| Decision taken | **Do NOT merge `codex/saas-runtime-01` into the candidate yet.** Get an independent review first. |
| Taken by | Coordinator, 2026-10-01 02:00, autonomously (Ron asked me to use judgement at blockers) |
| Reversible | Yes — it is one `git merge` either way, and **nothing is lost by waiting** |
| Slice | PR [#64](https://github.com/ronslink/hatoove/pull/64) @ `c5ce81b`, base `codex/ownapi-03-persistent` @ `9cccd97` |

## What is not in question

The work is **verified**. I re-ran it myself against a fresh disposable `postgres:17-alpine`: **9 passed, 0 failed,
completing in under 90 seconds**, with the evidence recorded on the PR — notably
`ai-authenticated-cannot-override-the-model` asserting the **provider stub received `model=operator-model-synthetic`
while the caller sent `attacker-chosen-model`**, and `legacy-progress-refused-anonymous-in-saas` asserting the
account header **and** the unscoped fallback are both refused. Baseline unchanged at that head.

## Why review first anyway — three reasons, in order of weight

1. **It is security-sensitive, and a checker is not a security review.** The programme's own standard, written
   before this slice, is that a human should read the fix rather than only the checker. The checker proves the four
   refusals work for the cases it names; it cannot prove the *implementation* has no path around them — a header
   parsed differently, a route reached before the gate, a flag read from a place the test does not set. That is
   exactly the class of defect an independent reader finds and a suite does not.

2. **I specified what to verify, so I am the wrong reviewer.** I wrote the brief that named all nine checks. When
   the reviewer authors the acceptance criteria, "it passes my criteria" is close to circular. This is not a
   formality I am inventing: the programme already requires independent review, and Hermes independently reviewed
   the platform candidate for the same reason — and found three defects, two of them documentary, that I had not
   seen.

3. **Waiting costs nothing.** PR #64 already targets the candidate branch, the commits are on `origin`, and the
   branch is mergeable. There is no deployment pending, no user waiting, and no other slice blocked on this merging
   tonight. The asymmetry is stark: merging a defective security refusal into the candidate risks a **false claim of
   safety** reaching `main`; waiting risks only that I do it a few hours later.

## What I did instead

- **Left the commits on `origin`** and recorded the full verification on PR #64, so the evidence is durable and
  nobody has to re-derive it.
- **Kept the PR in draft** and stated explicitly, in the PR comment, **what it does not close** — issue #63 remains
  open, its S4 and S5 are untouched, and the session port is still the synthetic one rather than Better Auth. That
  matters more than usual here because the slice's whole claim is "these two findings are closed", which invites the
  reader to over-read it as "the security work is done".
- **Queued the independent review** as the next available reviewer's task.

## What would have changed the decision

- **A deployment deadline.** If the candidate had to ship tonight, the trade would flip: a refusal that is verified
  and imperfect beats an anonymous proxy that is verified to be open.
- **An independent review already in hand.** Then there is nothing to wait for.
- **A second change stacked on this branch.** Stacking would make the review harder, not easier, and would risk the
  same review covering a moving target — the exact problem issue #63 raised about #60, #61 and #62 sitting on
  different bases.
