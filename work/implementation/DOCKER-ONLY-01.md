# DOCKER-ONLY-01 — retire the host setup

User instruction: remove the local setup; run the application entirely as a server in Docker.

Base: 3e3c3538422c3b4ef7c49a98a7f0a1cf01feba66. Branch: codex/docker-only-runtime. Execution: docker-only-20261001-a. Scope: launcher/installer retirement, container build/health, replacement Compose verification and current run instructions. No server API, schema, UI or existing deployment was modified.

## Result

- Docker Compose runs PostgreSQL, numbered migrations, API and worker. The host Node launcher and checker, plus the old D:\B1_Prep installer, are removed.
- npm start explicitly delegates to Docker Compose. Omitting scripts.start would let npm implicitly run the root server.js on the host.
- Docker copies only package.json, server.js, server/, public/ and data/. A default-deny build context excludes private state even inside runtime directories.
- Only the API service has an HTTP readiness probe. The worker no longer inherits a probe for an HTTP port it never opens.
- README and agent/master-plan instructions now name Compose as the supported runtime. Historical launcher evidence is labelled retired.
- Existing installations and database volumes are preserved. Old host and Compose volumes are different; no automatic import or data deletion occurred.

## Verification

Run the developer acceptance check from a clean source checkout with Node and Docker:

~~~sh
node tools/docker-stack-check.mjs
~~~

The application itself still requires only Docker. The checker creates a unique Compose project, chooses loopback ports, uses a synthetic environment file, verifies resolved ports/origin before startup, and removes only its own project/volume. It never starts a host API/worker.

Executed twice: **8 passed, 0 failed** each run. The second run deliberately inherited conflicting HATOVE_APP_PORT/HATOVE_DB_PORT=1 and an invalid public origin to verify the checker overrides them safely.

1. Host launcher/installer absent; npm delegates to Compose.
2. Resolved isolated port/origin configuration and service-specific health probe.
3. Container startup in dependency order.
4. Six migrations, six task versions; application roles neither superuser nor BYPASSRLS.
5. Built image excludes synthetic private files and non-runtime roots; worker has no inherited HTTP probe.
6. Re-running migrations leaves the six-row ledger unchanged.
7. Synthetic signup, authenticated shell and owned settings mutations succeed.
8. Fresh sign-in after API/worker restart restores saved settings.

Both disposable projects were removed by the checker. Offline baseline: **101 + 9 + 14 passed**. Design asset verification: **6 passed**. Independent review found npm implicit-start and inherited Compose environment issues; both were corrected before the second run.

## Remaining gates

This is setup retirement, not full SaaS/API retirement. Old single-user branches in server.js, catalogue/learning flows, runtime composition and production authentication remain governed by their existing slices. They are not claimed complete because the server is containerized.

The separate review of base 3e3c353 found auth-gate traversal/startup bypasses, account-switch mutation risk and client failure-state defects. They remain integration blockers and are not hidden by these setup checks. Full product acceptance, native-device behavior, content/model validity and production deployment remain open.

Status: implementation and local verification complete; independent follow-up review/integration record follows in the coordinator handoff. No production service or existing data volume was changed.
