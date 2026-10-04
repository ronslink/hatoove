# Production preparation and operator runbook

This implements the configuration side of [PILOT-HOSTING-01](contracts/PILOT-HOSTING-01.md). It is not permission to deploy, change DNS, contact a managed database, create resources or spend money. The separate sequential worker still uses a **deterministic stub grader: this is a deployment blocker**, not production feedback. Public content approval, evaluated provider integration, email delivery, payment activation, security/privacy/legal review, backup/restore objectives and real-device acceptance remain separate gates. `PAYMENTS_MODE=off` and public/approved-only content policy are deliberate defaults.

Ron selected a 2 vCPU / 4 GiB DigitalOcean Droplet in London for preparation. This is not a 200-learner capacity finding. Database placement is still an operator decision. Do not add this workload to the Paykey/Typeforge managed cluster without measuring its remaining connection, memory, CPU and I/O capacity. Separate databases do not isolate those resources.

## Files and topology

Use `compose.production.yaml` plus **exactly one** of `compose.production.local-db.yaml` or `compose.production.managed-db.yaml`. Never combine them with the developer `compose.yaml`, which retains its existing loopback ports and development trust authentication. The production base alone deliberately supplies an invalid TLS mode and cannot open database pools. Do not change the fixed one-app/one-worker replica configuration using `--scale`.

Only Caddy publishes TCP 80 and 443. Port 80 remains necessary for HTTP-01 renewal. Caddy and Node share the internal `application` network; Caddy alone also joins `edge`. App, worker and migrator join `backend`, which permits outbound connections required by an explicitly chosen managed database. No Node, worker, database, Docker socket or Caddy admin port is published. Node binds its container address on port 4321. There is no direct file server for private exam media. Ingress preserves Host, Origin, Referer, Cookie, X-Hatoove-Account, raw webhook bodies and response cache/range headers. The application continues to ignore forwarded network identity; this configuration does not introduce trusted-proxy authorization.

`HATOVE_APP_IMAGE`, `HATOVE_CADDY_IMAGE` and (local variant) `HATOVE_POSTGRES_IMAGE` must identify reviewed images by immutable `@sha256:` digest. Use the repository Dockerfile for the app, a stock Caddy 2 image supporting `disable_tlsalpn_challenge`, and the official PostgreSQL 17 image. Select and record actual digests separately; the template intentionally invents none. Image retrieval/build is an explicit operator step. `pull_policy: never` prevents a start command from silently selecting or downloading another image. Record image identity, source revision and migration manifest together. No repository `.env`, credentials or live data belong in an image or build context.

## External inputs, secrets and budgets

Copy `deploy/production.env.example` to an operator-controlled location **outside** the checkout. It contains nonsecret settings and absolute secret-file paths only, never passwords. Populate every required value for the selected variant; leave the unused variant entries absent. Use an explicit `--env-file` and a clean command environment, rather than ambient shell overrides or automatic repository `.env` loading. Do not paste `docker compose config` output or secret files into tickets. The structural checker uses its own synthetic files and reports only fixed check labels.

Generate eight independent passwords: bootstrap admin, migration, auth, learner, worker, deletion, payments and provisioner. Reusing the privileged password in several filenames destroys the intended separation. Password files are one nonempty UTF-8 value of 1–4096 bytes, optionally followed by one LF or CRLF. Never put passwords in shell arguments, tracked files, Compose environment values or screenshots. Existing roles are not automatically rotated: these inputs set passwords only for absent roles. Incorrect credentials for an existing role must fail; resolve an authorized rotation separately.

| Service | Mounted password files | Other protected material |
| --- | --- | --- |
| app | auth, learner, worker, deletion, payments, provisioner | Optional public managed CA directory |
| worker | worker only | Optional public managed CA directory |
| migrate | admin, migration and all six restricted runtime roles | Optional public managed CA directory |
| local db | admin only | Retained database volume |
| ingress | none | Retained certificate state, including private keys |

The app currently constructs a restricted worker pool as well as the standalone worker; its one-connection allocation is included. The provisioner has its existing restricted privileges. This slice widens no role privileges.

Fixed allocations are auth2, learner2, app-worker1, deletion1, payments1, provisioner1, runner1, admin1 and migration1. Add the dedicated readiness connection: **9 app + 1 runner + 2 concurrent deployment = 12** configured connections. Learner totals3 and worker totals2, below each existing role's limit10. Set `OWNAPI_PG_CONNECTION_BUDGET` to an explicitly allocated value of at least12, after reserving capacity for other applications and maintenance. A larger budget does not increase these fixed pools. Changing allocations or replicas requires a reviewed configuration change and repeated load evidence. Query capacity, queue wait and latency are not established by this arithmetic.

Compose file-backed secrets retain host file ownership; `uid`, `gid` or `mode` declarations would not establish remapping. The repository image runs as the unprivileged `node` user. Before any start, inspect the selected image's numeric UID/GID and the Docker daemon's rootless/user-namespace mapping. On ordinary Linux without remapping this is commonly UID/GID1000, but **verify it; do not assume it**. Provision readable files using the correct mapped owner/group or narrowly scoped ACL and restrictive host directory permissions. App, worker and migrator all need their assigned files readable; the PostgreSQL entrypoint must also read its admin file. Do not solve permission failures by running the app as root or making passwords world-readable. Verify access with a synthetic secret first under a separately authorized execution. Keep certificate-volume ownership and off-host copies equally restricted.

Local variant: explicitly select an external named database volume. Initialization uses SCRAM for both host and local authentication; no trust mode and no published DB port. Create a new named volume only after an operator confirms it is new and intended. Existing PostgreSQL volumes ignore initialization password/auth environment changes: do not attach the development trust-mode volume and assume it has become SCRAM. Existing-volume adoption requires a separate authentication/data review. A typo must fail as a missing external volume, never silently initialize an empty replacement.

Managed variant: provide the actual certificate-matching DNS endpoint and port; `verify-full` is mandatory. Mount an operator-chosen directory containing **only public CA material** at `/run/hatoove/pg-trust`. It may be empty when Node's default trust roots suffice. Omit `OWNAPI_PG_TLS_CA_FILE` entirely in that case. If the provider needs a custom CA, set that variable in the explicit nonsecret environment file to `/run/hatoove/pg-trust/provider-ca.pem`. Do not use an IP, override hostname verification, enable insecure TLS or copy account credentials into this trust directory. The configured file is validated before connecting.

The managed operator must confirm permission to create the seven scoped LOGIN roles, revoke PUBLIC CREATE/TEMP on the selected dedicated database, create the schema with the migration owner and run the existing migrations as that owner. A managed administrator is not assumed to be a PostgreSQL superuser. Never point bootstrap at a Paykey/Typeforge database or compensate for insufficient privileges using a privileged runtime connection. Direct managed endpoints are the initial contract; transaction-pooler compatibility is not assumed.

## Configuration-only preparation

The checker does not build, pull, start or contact PostgreSQL:

```sh
node tools/production-compose-check.mjs
node tools/production-compose-check.mjs --compose
```

The second command needs the Docker Compose plugin (major version2 or later) supporting JSON `config`, uses an isolated temporary project and explicit synthetic environment, inspects both merged variants, applies negative mutations and verifies scratch cleanup. It does not establish real TLS, Caddy parsing, startup, migrations, capacity or cloud readiness. Those need the separately bounded integration rehearsal below. Use the same reviewed Compose plugin version for the subsequent rehearsal and operator commands.

## HTTPS bootstrap and renewal

Stock Caddy uses HTTP-01 only; direct TLS-ALPN is disabled because Cloudflare terminates the public TLS handshake. Before changing authorized apex DNS, prepare the origin firewall, retained external `caddy-data` and `caddy-config` volumes, Caddy configuration and image. Ingress has no dependency on app readiness: certificate bootstrap happens with app/worker stopped. Only the separately authorized operator may create the named volumes and launch ingress.

1. Keep Cloudflare **Full (Strict)**; never use Flexible, Full without validation, or an insecure origin as a bootstrap workaround.
2. Leave Cloudflare's blanket **Always Use HTTPS off** for this profile. Forward HTTP `/.well-known/acme-challenge/` to origin80 without a redirect, cache, managed challenge, Access login or URL/body rewrite. Confirm no other zone redirect rule overrides this exception. Caddy itself answers an active ACME challenge before user routes. The explicit canonical HTTP route redirects other requests to `https://hatoove.com` with their URI and308; unknown hosts receive421. Keeping this route explicit also preserves redirects with manually mounted certificates, where automatic HTTPS may be disabled in whole or part ([Caddy documentation](https://caddyserver.com/docs/automatic-https)).
3. Set the authorized proxied apex record to the chosen origin. Validate both A and AAAA routes; do not publish IPv6 unless it reaches the same protected service. Make origin80 reachable from Cloudflare and keep it reachable for renewals. Origin443 must likewise accept Cloudflare traffic. If firewall allowlists are used, maintain both current Cloudflare IPv4/IPv6 ranges; an origin CA certificate alone is not an inbound firewall.
4. Start only ingress using the explicit selected Compose pair and nonsecret environment file. Obtain and verify the origin certificate's hostname, chain and expiry before exposing the accepted app. No live ACME request is part of offline validation. Monitor renewals and expiry; test the challenge forwarding path after every edge/firewall change. Preserve Caddy's data volume across rebuilds, restarts and rollback.
5. Add cache bypass for exact `/api` and its prefix, exact `/app` and its prefix, `/signin`, `/signin.html`, `/reset-password`, `/reset-password.html`, `/verify-email`, `/verify-email.html`, and any request containing `hatoove_owned_session=`. Preserve origin `no-store`/`private` headers and Set-Cookie. Do not use cache-everything. Keep the exact Stripe POST `/api/v1/payments/stripe/webhook` free of browser login/bot challenges; its application signature check remains mandatory. No provider is called by the synthetic webhook acceptance.

The supplied Caddyfile preserves the application 64KiB API/webhook body limit, raw bytes, media Range GET/HEAD, 206/416, Content-Range/Length and ETag. It adds no proxy cache, compression, mutation retries or short whole-audio timeout. The existing application account-generation check remains effective. Header defaults add nosniff, no-referrer and frame denial after upstream headers are copied, so upstream nosniff does not produce a duplicate value; there is no untested CSP, HSTS preload or blanket subdomain commitment. Validate these headers in the later ingress rehearsal. No new access log is enabled; restrict service logs and do not add request-body, cookie, authorization or recovery-query logging.

An **operator-selected Origin CA alternative** needs a separate reviewed local override: replace the ACME `tls` block with `tls /run/secrets/origin_certificate /run/secrets/origin_private_key`, mount those external files read-only only into Caddy, and mount that operator configuration instead of the tracked default. Certificate/key material never enters Git. Origin CA supports Full (Strict) but is not browser-trusted for DNS-only/direct-origin fallback. Track expiry and manual renewal/reload; Cloudflare does not supply expiry notifications for these certificates. Changing the selected certificate/redirect profile is an explicit operator decision, not an automatic fallback.

## Authorized start and upgrade procedure

Do not execute this section until deployment and product gates are satisfied. First take the required consistent backup and validate the restore/rollback plan. Serialize deployments; verify there is no other running migrator. Use a dedicated shell with an explicitly selected nonsecret config file; inherited variables override env-file values, so remove conflicting ambient deployment/PG/provider variables. Never source a password file.

The following Linux-shell procedure illustrates the required **stop → fresh migrate → success-only start** sequence. Fill the three nonsecret absolute paths deliberately. It neither creates nor deletes volumes. For local DB, explicitly start and wait for `db` before this sequence; omit that step for managed DB. Retain ingress for certificate renewals; the app may return unavailable while stopped.

```sh
set -eu
repo=/absolute/path/to/reviewed-checkout
config=/absolute/path/outside/checkout/production.env
variant="$repo/compose.production.local-db.yaml" # OR managed-db, never both
dc() { docker compose --project-name hatoove-production --env-file "$config" \
  -f "$repo/compose.production.yaml" -f "$variant" "$@"; }

# Before this sequence: confirm no other migration/deployment and record backup evidence.
# LOCAL ONLY: dc up -d --wait db
dc stop --timeout 60 app worker
# Verify both containers stopped, with no active grading invocation left to drain.
if [ -n "$(dc ps --status running --quiet app worker)" ]; then
  echo 'Upgrade refused: runtime still running' >&2
  exit 1
fi
# --force-recreate proves a new invocation; an old exited-success container is not evidence.
if ! dc up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate; then
  echo 'Migration failed; app and worker remain stopped' >&2
  exit 1
fi
dc up -d --no-deps --wait app worker
```

The app and worker retain `service_completed_successfully` dependencies for ordinary fresh startup; the explicit procedure verifies the new migration exit before its deliberate `--no-deps` restart. Compose does not stop an already running dependent when a later migration fails. Never reuse a historical success or run an unconditional restart in a cleanup trap. Verify readiness and schema head before routing accepted learner traffic. `pg_isready` only establishes server availability; it does not prove credentials or migrations. `/api/health` is liveness. `/api/ready` preserves startup configuration/schema refusals and, after successful initialization, probes bounded DB availability; it does not continually recheck migration history. The worker has no HTTP server: monitor its redacted outcomes, exit/restart state and queue age.

On failure, preserve logs with secrets redacted and leave app/worker stopped. Already committed migrations are not undone by a later failure. Do not blindly deploy an older image against a newer schema, rewrite checksums, delete ledger entries or downgrade SQL. Establish compatibility or rehearse an authorized restore into a separate database first. Never use `down --volumes`, volume pruning, or an existing learner volume as a test fixture.

## Remaining execution evidence and operations

The separate disposable source-only rehearsal must prove both merged variants, real verified PostgreSQL TLS success/untrusted-CA/wrong-host failure, mounted secret readability, successful fresh migrations, failed upgrade with previously running app/worker staying stopped, stale-schema/readiness refusal, canonical/foreign Host and Origin, Secure issuance/logout, account switching, authorized/unauthorized media Range/HEAD, exact signed synthetic webhook bytes and response/header preservation. Exercise actual Caddy adaptation and HTTPS with isolated test trust; local test certificates are not evidence of Cloudflare/ACME issuance. Use generated projects/isolated ports, synthetic accounts/media/review authority, no provider keys and exact container/network/volume/profile cleanup. Hosted CI and independent reviews remain separate from local evidence.

For later operations, restrict SSH to appointed keys and an explicitly approved management path; disable password login only after proving the key and recovery route. Do not expose PostgreSQL or Node through the host firewall. Document image/certificate renewal ownership, security updates, log access/retention and alerts for readiness, queue age, failures and certificate expiry. Take encrypted off-host database backups; define RPO/RTO, retention and key custody before production. A VM snapshot is not a demonstrated consistent PostgreSQL backup. Perform a restore rehearsal in a separate disposable database, verify roles/schema/owned data and record duration. Never test restore over an existing volume or shared managed database.

Run a separately approved synthetic load/soak plan at 50, then100, then200 concurrent learners with realistic request rates, draft saves, objective answers, private audio, finalisation, history and worker jobs. Record p50/p95/p99, error/retry rates, pool waits, DB connections/locks, queue age, event-loop delay, RSS, CPU/steal and audio bandwidth. Verify ownership, replay/debit invariants and preserved text during failures. Stop at agreed error/resource thresholds; no throughput or SLA claim follows from the VM size or one functional run.

Official references: [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), [file-backed secrets](https://docs.docker.com/reference/compose-file/services/#secrets), [Caddy HTTP-01](https://caddyserver.com/docs/automatic-https#acme-challenges), [Caddy TLS configuration](https://caddyserver.com/docs/caddyfile/directives/tls), [Cloudflare Full Strict](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/), [Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/), [Cloudflare caching](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
