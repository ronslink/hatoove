# Live writing feedback

The worker requires a DeepSeek credential. Missing or invalid configuration stops the worker; it never silently supplies simulated feedback. `HATOVE_GRADER_MODE=stub` is permitted only with `NODE_ENV=test` for isolated regression tests.

The production Actions workflow uses the encrypted repository secret `DEEPSEEK_API_KEY`. It transmits the value through SSH standard input into a private staging file, never as a command argument. The release script installs a versioned external file, readable only by the verified container UID1000, and checks it with networking disabled before stopping the running service. The full production composition must validate with the worker-only live overlay. Both automatic and manual deployment require successful CI for the exact main commit. Startup verification includes a restricted database connection from the actual worker container and zero restarts; it does not insert a synthetic learner submission into production.

Apply `compose.grading-live.yaml` after the chosen local or production Compose files. Set `HATOVE_DEEPSEEK_API_KEY_SOURCE` to an externally managed plaintext key file (outside the repository). Compose mounts it only in the worker at `/run/secrets/deepseek_api_key`. The app, browser and migration service receive no provider credential. Keep the source file private to its operator. Do not put credentials into tracked `.env` files or command-line arguments. Deployment still requires explicit authorization.

The adapter uses `deepseek-flash` with thinking disabled and the pinned `deepseek-flash-peak-20261128` estimate card. Historical provider identities/cards are immutable. Input, cache and output usage are recorded separately from the learner response; raw provider bodies and secrets are not logged. Estimated cost is not an invoice.

`HATOVE_GRADER_DAILY_USD_LIMIT` defaults to USD 15. Preflight counts observed usage and reserves USD 0.025 for uncertain or incomplete attempts within the last 24 hours. Definite predispatch refusals do not consume that reservation. The supported single-worker allocation and bounded prompt/output sizes are part of this budget mechanism; do not increase worker replicas without changing and validating admission concurrency.

Feedback uses the task's exact bound rubric descriptors. Every evidence quote must occur in the submitted text. Invalid, truncated or inconsistent model results remain failures with preserved submissions and refunded credit reservations. Results are provisional practice feedback, not calibrated examination scores or pass predictions.

Validation commands:

```text
node tools/writing-grader-deepseek-check.mjs
node tools/provider-attempt-check.mjs
node tools/production-compose-check.mjs --compose
node tools/live-grading-check.mjs --live
node tools/live-grading-pg-check.mjs --live
```

The last two commands intentionally use the real provider and require a server-side key. The PostgreSQL check additionally requires explicitly isolated disposable database settings. Neither runs automatically in CI. Ordinary contract fixtures remain useful for error cases but do not establish real provider acceptance.
