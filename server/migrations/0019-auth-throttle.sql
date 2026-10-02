
    -- PILOT-18 — AUTH THROTTLE: the abuse gap the queue measured.
    --
    -- Measured 1 October 2026: 12 rapid registrations all accepted, and 12 rapid failed sign-ins all 401 with
    -- no 429. The plan's instruction was "Throttle first — it is what protects the operator's provider
    -- budget."
    --
    -- WHY THE COUNTERS ARE IN THE DATABASE AND NOT IN PROCESS MEMORY. A counter in the process is lost on
    -- every restart and gives each replica its own budget, so the limit multiplies by the number of replicas
    -- and disappears when a container is replaced. The `auth` role already reaches the auth tables, and one
    -- row per bucket is a small price for a limit that is actually a limit.
    --
    -- THE BUCKET IS THE KEY AND IT CARRIES THE SUBJECT, e.g. `signin:<email>`, `signup:global`,
    -- `password:<user-id>`. That is deliberate: a SINGLE GLOBAL COUNTER FOR SIGN-IN WOULD BE A DENIAL OF
    -- SERVICE, because one attacker hammering one account would lock every learner out of the product. The
    -- only genuinely global resource here is registration (each account costs a row and a session), so that
    -- is the only global bucket.
    --
    -- `window_started_at` is stored rather than derived, so the window is a fixed period from the first
    -- attempt in it and not a rolling one that a slow attacker can ride indefinitely.
    --
    -- PERSONAL DATA, KEPT SMALL ON PURPOSE: a bucket key can contain an email address. Rows are swept once
    -- they are older than any window can be (see `sweep` in `throttle.mjs`), so the table holds recent
    -- attempts rather than a growing history of who tried to sign in.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".auth_throttle (
      bucket            text PRIMARY KEY,
      window_started_at timestamptz NOT NULL DEFAULT now(),
      attempts          integer NOT NULL DEFAULT 0,
      updated_at        timestamptz NOT NULL DEFAULT now()
    );

    -- The sweep walks by age, so it needs the column it walks on.
    CREATE INDEX IF NOT EXISTS auth_throttle_age_idx ON "__SCHEMA__".auth_throttle (window_started_at);

    -- NOT PUBLIC, AND NOT THE LEARNER ROLE EITHER: only the auth seam reads or writes a limit. A learner
    -- query cannot see who else has been failing to sign in, which is the same least-privilege rule the
    -- objective answer keys follow.
    REVOKE ALL ON "__SCHEMA__".auth_throttle FROM PUBLIC;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "__SCHEMA__".auth_throttle TO "__AUTH__";
