# Q-01 rendered accessibility evidence

Issue [121](https://github.com/ronslink/hatoove/issues/121); author execution **PILOT-Q01-AXE-20261003-A**, coordinator semantic fixes **PILOT-Q01-20261003-B**. Base is S6 PR120 at `2f0ca7cac3f1be93350aba65b66702eb7b256485`. The [frozen contract](../../docs/contracts/PILOT-Q01-AXE.md) governs this verification slice. Automated coverage is delivered and independently reviewed; full accessibility and product acceptance remain open.

## Result and source identity

The three existing isolated browser runners now support locked local axe-core4.13.0 scans. They enforce every required state, engine identity and nonempty exercised rules, fail on every selected-rule violation, and retain incomplete findings for manual review. No rule or severity filter suppresses a finding. A separate same-origin control tab proves clean baseline, a real unnamed-button failure, recovery after removal and rejection of an omitted required state.

Two product fixes address invalid accessible naming: the sign-in/register controls use a labelled group, and each writing band has a visually hidden readable `Band ` prefix before the unchanged A–D badge. The latter preserves the declared rubric contract and adds no total score. Independent review also caught a harness error where failure to write the summary could skip fixture cleanup; the corrected helper records that failure and allows cleanup to continue.

Final browser source is clean author commit `f44e0b23c2f9f39cdf5167b390e56622c7d86ed0`. Integration adopted instrumentation as `82a3ff2`, semantic fixes as `1c75662` and cleanup repair as `56d3e71`; `b8b254c` adds CI wiring. At that integration revision, `server/`, `public/`, `tools/` and Docker runtime sources match the final tested author source. Documentation and CI wiring are different and separately reviewed.

| Final isolated run | Checks | Required states / scans | Violations | Scan interval |
|---|---:|---:|---:|---:|
| App and account flows | 230/230 | 19/29 | 0 | 136,501ms |
| Fixed listening and saved mocks | 23/23 | 6/10 | 0 | 43,057ms |
| Stub checkout and activation | 24/24 | 5/9 | 0 | 44,037ms |

These durations are recorded scan-suite intervals, not a measured hosted CI job duration. Every summary reports `sourceDirty:false`, the exact source revision, completed state manifest, viewport/theme, token-free URL path and control results. Runs cover desktop light and representative390px dark/320px light variants. App verification also passed all22 original design pins using the local design reference. Original design inputs remain untracked.

Final ignored evidence is under the author worktree `.qa/q01-20261003/{app-final,audio-final,payments-final}/`, including `axe/summary.json`, per-state reports and screenshots. Root inspected desktop sign-in and mobile writing-band screenshots and independently derived totals and remaining findings from all three summaries. Exploratory and earlier accepted directories are not the final evidence source.

## Independent verification and remaining manual findings

Root reviewed the author's helper, lockfile, full-document scans, manifest controls, environment isolation and cleanup. The playback author independently reviewed the coordinator's product and CI changes; a separate package reviewer inspected accessible naming and incomplete findings. Root reproduced actual `ENOTDIR` summary-write failures for all three suites: each reported evidence failure, continued cleanup and removed its temporary resource (3/3). Workflow-shape checks pass12/12; retained owned-client checks32/32 and design structure14/14 pass, with the existing two design warnings unchanged.

Remaining incomplete `color-contrast` findings are explicitly **not passes**. App desktop `writing-rubric` retains `#signout` with `elmPartiallyObscured`. Each of the six desktop audio states retains `.crumbs` (`shortTextContent`) and `#page-title`, `#crumb-date`, `#signout` (`elmPartiallyObscured`). The translucent sticky-header composition prevents axe from calculating those backgrounds. Mobile audio variants and all payment scans have no incomplete findings. Qualified visual/assistive-technology review must resolve these; zero reported violations does not establish WCAG conformance.

The source-only synthetic stacks use unique project labels, free loopback ports and task-only databases. Exact generated containers and volumes were checked absent after each suite. No learner runtime, learner data, existing volumes, live email, AI provider or Stripe service was used.

## CI and acceptance limits

The existing scheduled/manual rendered job installs the pinned test dependency and runs all three suites with `--axe`. Its app run explicitly uses `--design-evidence=served-only`, recording original-reference checks as not performed while retaining served-asset pins; default local mode remains strict. Private artifacts retain only the three synthetic evidence folders for seven days, including failed-run output. Upload uses the verified immutable upstream actions/upload-artifact v7.0.1 commit `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a`.

This is not a new required PR browser gate. Hosted CI success must be recorded from an actual run before integration; the predecessor PR stack remains blocked by GitHub's account payment/spending restriction. Headless evidence does not close keyboard, screen-reader, physical iPhone/Android audio, qualified accessibility, content, privacy/legal or product acceptance gates. C-03 planning contracts in this stack are follow-on design work, not delivered content-review runtime or human approval.
