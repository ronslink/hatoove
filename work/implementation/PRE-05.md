# PRE-05 / F-03: local runtime and durable contracts

Status: working. Coordinator owns architecture, source and integration.
Execution: pre05-20260930-a. Slot 1. Base: 48c3d210173a0291eb1d82ad2c8a74ad52da8416.
Branch: codex/pre-05-runtime-contracts. Managed worktree: C:/Users/ronon/.codex/worktrees/pre05-runtime-contracts/B1_Prep.
Issued 2026-09-30 17:35 UTC; checkpoint 17:50 UTC; expires 18:35 UTC. No children.

Allowed paths: spikes/auth-runtime/**, docs/contracts/**, work/implementation/**, work/BOARD.md, .github/workflows/pilot-contracts.yml.
No public/, server.js, root package or learner-data edits. Disposable PostgreSQL container hatoove-pre05-db, loopback port 55435; API uses ephemeral loopback port. No production access, email, AI or payment calls.

Deliverable: pin and exercise Better Auth + pg + Node; library-derived auth tables; versioned account/attempt/draft/submission/job/usage contract; real PostgreSQL persistence and meaningful failure tests. Preserve the existing app for later UI integration.
Acceptance: two accounts cannot read/write each other's drafts; re-login retrieves saved work; stale draft writes conflict; immutable submission plus job is transactional and idempotent; retry/completion uses lease fencing and one success debit; deletion defeats late completion. Run 124 offline checks and staged repository guard. A source-only spike is not hosted-auth, security, exam or device approval.
Review: OpenClaw source audit, Hermes independent implementation review. Human security review of production sessions, email recovery, abuse, SQL roles/RLS and deployment configuration is required before external pilot admission. This spike must remain local-only and has no production entrypoint.
Integration: issue/PR recorded by coordinator; independent findings resolved, CI green and all incoming commits inspected before merge.
