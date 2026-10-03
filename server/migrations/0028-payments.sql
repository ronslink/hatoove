-- No commercial offers are seeded. Prices and terms require an operator decision.
ALTER TABLE entitlements ADD COLUMN expires_at timestamptz;
CREATE TABLE payment_product (
 id text PRIMARY KEY, exam_id text NOT NULL REFERENCES exam_package(exam_id),
 allowance integer NOT NULL CHECK(allowance>0), term_days integer NOT NULL CHECK(term_days>0), active boolean NOT NULL DEFAULT false
);
CREATE TABLE payment_price (
 product_id text NOT NULL REFERENCES payment_product(id), market text NOT NULL CHECK(market ~ '^[A-Z]{2}$'),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), amount_minor integer NOT NULL CHECK(amount_minor>0),
 display_price text NOT NULL CHECK(length(display_price) BETWEEN 1 AND 100), stripe_price_id text NOT NULL,
 active boolean NOT NULL DEFAULT false, PRIMARY KEY(product_id,market)
);
CREATE TABLE payment_order (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), exam_id text NOT NULL REFERENCES exam_package(exam_id),
 product_id text NOT NULL, market text NOT NULL, currency text NOT NULL, amount_minor integer NOT NULL CHECK(amount_minor>0),
 display_price text NOT NULL, stripe_price_id text NOT NULL, allowance integer NOT NULL CHECK(allowance>0),
 term_days integer NOT NULL CHECK(term_days>0), status text NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','paid','failed','refunded','disputed')),
 provider_ref text UNIQUE, payment_intent_ref text UNIQUE, checkout_url text,
 session_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
 UNIQUE(id,owner_id)
);
CREATE UNIQUE INDEX payment_one_pending_exam ON payment_order(owner_id,exam_id) WHERE status='pending';
CREATE TABLE payment_checkout_event (
 owner_id text NOT NULL REFERENCES "user"(id), event_id uuid NOT NULL, order_id uuid NOT NULL,
 PRIMARY KEY(owner_id,event_id), FOREIGN KEY(order_id,owner_id) REFERENCES payment_order(id,owner_id)
);
CREATE TABLE payment_event (
 id text PRIMARY KEY, owner_id text REFERENCES "user"(id), order_id uuid,
 kind text NOT NULL, disposition text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,owner_id) REFERENCES payment_order(id,owner_id),
 CHECK((owner_id IS NULL)=(order_id IS NULL))
);
CREATE TABLE payment_grant (
 order_id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), event_id text NOT NULL UNIQUE REFERENCES payment_event(id),
 exam_id text NOT NULL REFERENCES exam_package(exam_id), allowance integer NOT NULL CHECK(allowance>0),
 expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,owner_id) REFERENCES payment_order(id,owner_id)
);
GRANT USAGE ON SCHEMA "__SCHEMA__" TO "__PAYMENTS__";
GRANT SELECT ON payment_product,payment_price TO "__LEARNER__","__PAYMENTS__";
GRANT SELECT ON exam_package TO "__PAYMENTS__";
GRANT SELECT(id) ON "user" TO "__PAYMENTS__";
GRANT SELECT,INSERT ON payment_order TO "__PAYMENTS__";
GRANT UPDATE(status,provider_ref,payment_intent_ref,checkout_url,session_expires_at,paid_at) ON payment_order TO "__PAYMENTS__";
GRANT SELECT,INSERT ON payment_checkout_event,payment_event,payment_grant TO "__PAYMENTS__";
GRANT SELECT,INSERT ON entitlements TO "__PAYMENTS__";
GRANT UPDATE(allowance,expires_at) ON entitlements TO "__PAYMENTS__";
CREATE POLICY payments_entitlements ON entitlements TO "__PAYMENTS__"
 USING(owner_id=current_setting('hatoove.owner_id',true)) WITH CHECK(owner_id=current_setting('hatoove.owner_id',true));
DO $payments$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['payment_order','payment_checkout_event','payment_event','payment_grant'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('GRANT SELECT ON %I TO "__LEARNER__"',t);
  EXECUTE format('GRANT SELECT,DELETE ON %I TO "__DELETION__"',t);
  EXECUTE format('CREATE POLICY payment_reader ON %I FOR SELECT TO "__LEARNER__" USING(owner_id=current_setting(''hatoove.owner_id'',true))',t);
  EXECUTE format('CREATE POLICY payment_deletion ON %I TO "__DELETION__" USING(owner_id=current_setting(''hatoove.owner_id'',true))',t);
  EXECUTE format('CREATE POLICY payment_service ON %I TO "__PAYMENTS__" USING(true) WITH CHECK(true)',t);
 END LOOP;
END $payments$;
