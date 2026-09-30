# F-02/A-01 local isolation result

Execution `f02-20260930-a`, coordinator; base a9a4cfd, implementation PR18. Main commits082524a and86d2ed3 introduced the local role boundary, tests and review follow-up. Final cleanup correction acquires test clients inside their release guard so a partial connection failure cannot hang pool shutdown.

Observed checks:10 isolation scenarios/11 Node runner checks;12 original PostgreSQL scenarios/13 checks;101+9+14 legacy checks. Staged source guard and whitespace checks run before pushes; GitHub Linux/Windows and PostgreSQL checks are recorded on PR18. No root dependencies or public app changes in this slice. The independent CSS slice PR12 merged atbb30267 after coordinator screenshot/diff review and green CI.

Independent review: OpenClaw PR15 inspected082524a, found no owner leak and supplied I01-I05/M01-M06. Their scope/disposition is recorded in LOCAL-ISOLATION.md. A separate local read-only reviewer, execution f02r2-20260930-a, inspected exact86d2ed3, approved the documented local-fixture scope and found one nonblocking cleanup edge. The coordinator applied its proposed try/finally acquisition correction and reran11 isolation checks successfully. Neither reviewer claimed to run PostgreSQL; actual database/HTTP execution was local coordinator/CI evidence. This is not human security signoff.

Default privileges initially exposed a real fail-before regression: per-schema function REVOKE did not remove global PUBLIC EXECUTE. The corrected per-role default and fixture cleanup pass. Two-account HTTP concurrency now uses3 real pooled connections in addition to single-client commit/rollback checks.

Accepted boundary: trusted session-derived owner context, explicit worker cross-account access, no runtime DDL/admin/credential crossover. Arbitrary SQL by a compromised backend can spoof its custom owner setting. Bootstrap trust, one-time fixture SQL and dedicated database CREATE/TEMP policy are local experiments, not deployable settings. Aborted runs can leave their random objects; cleanup must remain specific to this synthetic database/container.

Next coordinator work: bounded owned client/draft identity/recovery integration, preserving the existing learner UI and contract account isolation. USER04 supplies source corrections/fixtures and a recovery matrix; Hermes discovery is being corrected separately. Reviewed content/audio/native languages, human security, actual devices, complete journey and deployment remain open gates. The active ten-minute heartbeat updates the master plan and board from actual evidence.
