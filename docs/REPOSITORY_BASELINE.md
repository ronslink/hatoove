# Hatoove repository baseline

This repository imports the working source from the canonical OneDrive development folder without changing the learner UI or deploying a service. The separate installed `D:\B1_Prep` copy is not the source of truth. After import, the shared Git main branch is the integration baseline and each worker uses its own clone.

## Included source

`public/` contains the existing learner app. `data/` contains authored curriculum and seeds, including deferred speaking source that remains outside pilot scope. `hatoove-site/dist/` contains maintained site HTML, CSS, JavaScript and licensed assets; there is no missing upstream build directory. `tools/` and `portable/` contain source utilities, not prebuilt portable installations. Research reports, scripts and explicitly synthetic fixtures are retained as background evidence.

The site initially had its own local Git history and uncommitted orange-brand changes. Its complete history was verified in `.qa/git-history/hatoove-site.bundle`, and its original Git metadata was preserved at `.qa/git-history/hatoove-site-dot-git`. The root baseline contains the actual current site files, not a Git submodule entry. Do not discard the archived history or reset the site to its earlier commit.

## Excluded material

Credentials, learner progress and backups, provider run outputs, local hosting associations, agent state, browser profiles, generated portable bundles and audit screenshots stay outside Git. `.env.example` contains empty credentials only. The common-pattern source guard is an additional check, not proof that arbitrary files are safe to publish. Repository visibility is private.

Recorded research reports link to timestamped runs that are intentionally retained locally rather than committed. Some benchmark scripts require those frozen run protocols and will not reproduce from this source-only clone alone. They are not CI or agent startup commands. Reproducibility work must first export a separately reviewed, synthetic research artifact; never copy broad runtime directories to make a benchmark run.

## Verified checks

On 30 September 2026, the source-only local checks passed on Node 24.4.1: `tools/check.js` 101, `tools/writing-check.js` 9 and `tools/feedback-check.js` 14. CI runs these on Linux and Windows using Node 24. Passing them preserves the legacy baseline; it does not certify telc accuracy, writing assessment, accessibility or production readiness.

Do not run generic browser tests against ports 4321 or 4381. They can mutate progress. The existing server reads `.env` at startup even when offline behavior is selected. Portable build/sync/recovery tools can copy or modify real credentials and learner records. Use an isolated source-only clone and synthetic records for application tests.

## Remote access

The coordinator uses the existing authenticated GitHub login and SSH alias `hetzner`; no credential values belong here. OpenClaw is installed on Hetzner. The local Docker container is `hermes-agent`, with persistent `/opt/data` and G-drive project mount `/projects`. Give Hermes a dedicated checkout; its children do not automatically gain separate filesystems. Confirm each worker's ability to produce a reviewed branch before assigning product code.

No deployment workflow, production token, public endpoint or domain change is part of this baseline.
