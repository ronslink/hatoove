
    -- PILOT-06 — an attempt gets its OWN creation time.
    --
    -- ## Why this is a migration and not a query tweak
    --
    -- `GET /api/v1/attempts?open=1` has to answer "which of my unfinished letters should I continue?"
    -- and the honest answer is "the most recent one". The first version ordered by `attempts.created_at`
    -- and the adapter threw `column a.created_at does not exist` (SQLSTATE 42703): the only timestamp on
    -- the table was on `submissions`, not on `attempts`. A probe against the real adapter caught it
    -- immediately; the memory fixture had been setting a `created_at` of its own, so the check passed on
    -- one backend and the route answered 500 on the other. That is the whole argument for running the
    -- same suite on both.
    --
    -- Ordering by `id` was not an option: ids are random UUID v4, so "newest" would have been an
    -- arbitrary order presented as a meaningful one.
    --
    -- ## Why `now()` for existing rows is acceptable
    --
    -- Attempts that predate this column get the migration's time. There is no production installation and
    -- no learner data to preserve (the pilot has never been deployed), so the backfill is exact enough for
    -- its purpose: it makes every existing row orderable rather than dropping it from the index.
    --
    -- The column is `NOT NULL DEFAULT now()` so the INSERT in the adapter needs no change, and it is
    -- indexed with `owner_id` because that is exactly how the open index reads it.

    ALTER TABLE "__SCHEMA__".attempts
      ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

    -- The open index filters by owner and orders by recency, so the index matches the query.
    CREATE INDEX IF NOT EXISTS attempts_owner_created_idx
      ON "__SCHEMA__".attempts (owner_id, created_at DESC);
