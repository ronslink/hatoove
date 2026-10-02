# WORKER-WIRE-01 — run the worker as a process, and prove feedback end to end

**Status:** IN PROGRESS (skeleton + composition decision pushed first; legs land next).
**Base SHA:** `2b0295ea3d294812a879b4a9fc5526217d410586` (`origin/codex/integration-01`, as instructed "must be 2b0295e or later").
**Branch:** `codex/worker-wire-01`.

> This file is written incrementally and pushed after every step (dispatch §0.1). Sections below
> are filled in as each step lands; anything not yet run is marked **NOT YET RUN**, never guessed.

---

## 1. Composition decision (Step 1) — RECORDED BEFORE ANY CODE

**Decision: the worker runs as a SEPARATE PROCESS — `node server/worker.mjs` under its own
supervisor — and connects with the restricted `worker` role (`<prefix>_worker`, here
`hatoove_worker`), never `admin` and never `migration`.**

The three shapes and why this one:

| Shape | Verdict | Reason |
|---|---|---|
| **Separate supervised process** (`node server/worker.mjs`) | **CHOSEN** | One supervisor unit regardless of how many web instances exist, so worker count is a deliberate, separate scaling decision rather than a side effect of web scale. It is the only shape that neither multiplies workers with instances nor needs a leader-election lock. The CLI is already bounded and lease-fenced (`WORKER-RUNNER-01`), so a supervisor restart is safe. |
| Started by the web process | rejected | Every instance would run a worker. Preventing N instances from starting N workers needs a leader election / advisory-lock gate that does not exist here, and getting it wrong double-grades. It also tempts the web process into reusing its runtime `admin` pool. |
| Externally scheduled (cron/platform job) | rejected for now | Viable, and the bounded `--once`/`--max-iterations` CLI already supports it, but it makes the *journey* leg depend on an external scheduler being present. A supervised long-running process is the simplest thing that composes for the pilot; the same binary can be scheduled later without change. |

**Which pool the worker uses, and what it is granted.** The worker connects as
`<prefix>_worker` (`worker.persistentRolePool(config, 'worker')` in `server/worker.mjs`).
`spikes/auth-runtime/isolation.sql:18-23` is the authority for its grants:

```
GRANT SELECT ON attempts, submissions, jobs, entitlements, assessments, usage_ledger TO __WORKER__;
GRANT UPDATE(deleted_at) ON attempts TO __WORKER__;
GRANT UPDATE(used,reserved) ON entitlements TO __WORKER__;
GRANT UPDATE(status,lease_token,lease_until,tries,failure_code) ON jobs TO __WORKER__;
GRANT INSERT ON assessments, usage_ledger TO __WORKER__;
```

plus schema `USAGE` and the `worker_*` RLS policies (`isolation.sql:71-76`) that let this one
trusted process see cross-account jobs. It holds **no** DB-level DDL, no `CREATE`, no
`BYPASSRLS` (the role is created `NOBYPASSRLS`, `provision.mjs:ensureRolesAndSchema`).

**No second privileged pool.** The architect review found the web runtime keeps a superuser
`admin` pool open. The worker does **not** reuse it and does **not** add one: `server.js` is
deliberately left not starting the worker (dispatch §4), so the web process's pool topology is
unchanged.

**What `server.js` does: deliberately nothing.** The worker is not started by `server.js` in
this slice (Step 2 decision, per dispatch §4 "decide, deliberately, not to start the worker").
The journey harness and operators start it explicitly as a child/supervised process. Because it
is not started by the web process, the "N instances → N workers" hazard cannot arise, and no
guard is needed.

---

## 2. What Step 2 proved — the journey harness runs a real worker process

**NOT YET RUN** — see §4 for the verbatim legs and output once green.

---

## 3. Safety legs (Step 3) and discrimination

**NOT YET RUN.**

---

## 4. Verbatim check output

**NOT YET RUN.**

---

## 5. LIMITS (unhedged)

**NOT YET RUN.**
