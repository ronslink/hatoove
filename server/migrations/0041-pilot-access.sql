-- PILOT ACCESS REQUESTS — the queue the public request form writes to.
--
-- Ron, 4 October 2026: "we need to handle the link for a request for an account during the pilot
-- phase." During the pilot the front door asks for an account instead of opening the sign-up form,
-- and a person on the team provisions each account by hand. This table is the queue that person works
-- from; it is NOT the invite gate (code issuance belongs to its own slice) and it changes nothing
-- about how an account is created.
--
-- WHY A TABLE AND NOT A MESSAGE. There is no email provider: the processor question (P-03) is
-- undecided, so nothing in this product may depend on sending mail. A request that is only "sent"
-- would therefore be a request nobody receives. It is stored instead, and the operator reads the
-- queue with `server/access.mjs` (`docker compose run`), so the request survives a crash, a restart
-- and the person who happens to be watching the console.
--
-- WHY IT IS AN AUTH-SUPPORT TABLE AND NOT AN OWNED ONE. These rows are not account data: there is no
-- account yet, so there is no owner to scope them to, and `owner_id`/`user_id` would be a claim that
-- some account owns a request it predates. The same rule as `auth_throttle` (0019) therefore applies:
-- no RLS, PUBLIC holds nothing, and the auth seam is the only role with any privilege. `account_request`
-- is registered in `AUTH_SUPPORT_TABLES` (`tools/lib/catalogue.mjs`) and
-- `tools/table-class-check.mjs` fails the day it stops fitting that class.
--
-- NO FREE-TEXT FIELD, deliberately. Every column here is a closed value or a bounded scalar, so the
-- queue cannot become a place where a stranger writes arbitrary text into the operator's terminal or
-- into a future screen. The request says who is asking (name, email), which language they want to be
-- answered in, and which consent wording they agreed to.
--
-- EMAIL IS STORED LOWERCASED, and the uniqueness is on that column: `Anna@Example.com` and
-- `anna@example.com` are one request, not two, which is the same reason the route answers a duplicate
-- with the identical 202. The CHECK is the database's own statement of that rule, so a future writer
-- that forgets to normalise fails rather than filing a second row.
--
-- CONSENT IS A VERSION, NOT A BOOLEAN. "They ticked a box" is not something an operator can answer a
-- question about later; "they agreed to the wording this deployment shipped on 4 October 2026" is.
-- The value is written by the route from one constant, never from request input.
--
-- RETENTION. `created_at` carries an index because the one scheduled thing an operator may want is a
-- sweep of requests older than N days (`server/access.mjs purge --older-than <days>`). No default
-- retention period is invented here: none has been decided, and the honest state is that requests stay
-- until a person removes them.

CREATE TABLE IF NOT EXISTS "__SCHEMA__".account_request (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL
                    CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  name            text NOT NULL
                    CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  language        text NOT NULL
                    CHECK (language IN ('de', 'en', 'uk', 'ar', 'tr')),
  consent_version text NOT NULL
                    CHECK (length(consent_version) BETWEEN 1 AND 40),
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'invited', 'declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  handled_at      timestamptz,
  CONSTRAINT account_request_email_key UNIQUE (email)
);

-- The retention sweep walks by age, so it needs the column it walks on.
CREATE INDEX IF NOT EXISTS account_request_created_at_idx ON "__SCHEMA__".account_request (created_at);

-- NOT PUBLIC, AND NOT THE LEARNER ROLE EITHER: a request carries an email address of somebody who is
-- not an account holder, so no runtime role outside the auth seam may read who asked for access.
REVOKE ALL ON "__SCHEMA__".account_request FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON "__SCHEMA__".account_request TO "__AUTH__";
