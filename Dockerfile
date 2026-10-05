# PILOT-01b — the local SERVER image.
#
# The product is a hosted, multi-user service that happens to run on this machine, not a
# single-user program that happens to have a server. So the whole stack runs in containers and the
# host needs Docker and nothing else: no Node install, no `npm install`, no environment drift
# between a developer's machine, a worker's host and CI.
#
# ONE image serves the API, the worker and the migration step. They differ only by command, which
# keeps them on identical code and dependency versions — the alternative is the classic drift where
# the worker runs yesterday's build.
#
# `node:22-bookworm` and not `alpine`: `server/owned-postgres/package.json` requires `node >= 22.16`
# and this tag is v22.22.3. `pg` is pure JavaScript, so no build toolchain is needed either way.
FROM node:22-bookworm

ENV NODE_ENV=production
WORKDIR /app

# The repository has exactly one dependency scope — the root app is deliberately dependency-free
# (`"dependencies": {}`) and must stay that way. Copying only the manifests first means the
# dependency layer is cached and is not invalidated by an application edit.
COPY server/owned-postgres/package.json server/owned-postgres/package-lock.json ./server/owned-postgres/
RUN npm ci --prefix server/owned-postgres --ignore-scripts --no-audit --no-fund

COPY package.json server.js ./
COPY server/ ./server/
COPY public/ ./public/
# MEDIA-MOUNT-01 — the recordings ARE in this image, deliberately.
#
# The nine telc B1 recordings are tracked PLAIN in the repository (A12(1), 5 Oct 2026 — 43.89 MB,
# sha256-matching the package's `media` rows), so `COPY content/exams/` below carries both the manifests and
# the audio. That is what production needs: `compose.production*.yaml` runs a digest-pinned `read_only` image
# with no runtime volumes and an exactly pinned command (`tools/production-compose-check.mjs` asserts both), so
# the bytes must be inside the reviewed artifact.
#
# Locally, `compose.yaml` binds the same tracked tree (or an operator's HATOVE_AUDIO_ROOT) at `/app/media` and
# points B1PREP_MEDIA_ROOT at it, so new audio can be exercised without an image rebuild. A clean clone needs
# neither: the default mount source is the tracked tree. `tools/media-mount-check.mjs` runs as the `media`
# service and makes a missing recording loud at startup instead of a 404 at play time.
COPY content/exams/ ./content/exams/
COPY tools/import-exam-package.mjs ./tools/import-exam-package.mjs
COPY tools/review-content.mjs ./tools/review-content.mjs
COPY tools/provider-usage-report.mjs ./tools/provider-usage-report.mjs
# The media preflight the `media` compose service runs before `app` starts (filesystem only).
COPY tools/media-mount-check.mjs ./tools/media-mount-check.mjs
# NOTE: `data/` is deliberately NOT copied into the image. Every authored corpus is in the database
# (migrations 0010-0014) and served by the API; the image used to carry 557 KB of JSON that NOTHING in
# the container read. Removing it means a re-added static route could not serve the corpus even by
# mistake -- the files are not there. The tool that used to read them from the repo checkout in CI,
# `tools/check.js`, was retired with the client it tested (SPA-RETIRE 4); `tools/objective-fixture-check.mjs`
# and `tools/exam-blueprint-check.mjs` still read the repo's data and run from the checkout, not here.

# Run as the unprivileged `node` user that the base image already provides. The runtime must hold
# restricted database roles; it should not also be root inside its own container.
RUN chown -R node:node /app
USER node

EXPOSE 4321

# Health probes belong to the service: the worker and migrator do not listen on HTTP.
CMD ["node", "server.js"]
