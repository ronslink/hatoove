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

COPY . .

# Run as the unprivileged `node` user that the base image already provides. The runtime must hold
# restricted database roles; it should not also be root inside its own container.
RUN chown -R node:node /app
USER node

EXPOSE 4321

# The container binds 0.0.0.0 so the published port reaches it; loopback is still one of its own
# interfaces, so this probe works without leaving the container.
HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.B1PREP_PORT||4321)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
