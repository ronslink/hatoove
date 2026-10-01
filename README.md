# Hatoove exam preparation

Hatoove is a multi-user exam-preparation server. Run the API, background worker, migrations and PostgreSQL through Docker Compose. The host needs Docker with Compose; it does not need Node, npm or a separate app installation.

The canonical source is D:\Hatoove and the private repository is https://github.com/ronslink/hatoove. Read MASTER-PLAN.md for progress, PILOT_BUILD_PLAN.md for product scope and docs/AGENT_WORKFLOW.md before agent work.

## Run the server

From this repository:

~~~sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app worker migrate
~~~

Open http://localhost:4300. The published ports bind only to loopback. The worker uses a deterministic grading stub: the current app is an incomplete development server, not a production deployment or evidence of assessment quality.

Compose starts PostgreSQL, runs the numbered migrations, then starts the API and worker. Only the API has an HTTP readiness probe; the worker is supervised as a separate process.

## Stop and restart

~~~sh
docker compose down
docker compose up -d
~~~

Stopping retains the named database volume and account data. Do not remove volumes to upgrade or switch launchers. The retired host setup used a different database volume; this change neither deletes it nor imports it into the Compose database. Explicitly inventory and migrate any needed records before retiring that old volume.

## Configuration

The defaults are HATOVE_APP_PORT=4300, HATOVE_DB_PORT=55440 and HATOVE_PUBLIC_ORIGIN=http://localhost:4300. If the app port or browser hostname changes, set the public origin to that exact address as well; mutations reject a mismatched origin. Set these as operator environment variables consumed by Compose. Provider configuration belongs on the server and is never learner editable.

The database trust configuration is for this isolated development stack only. Production authentication, secrets, provider access, content review and deployment authorization remain open gates. Publishing ports publicly or deploying is a separate task.

## Source and verification

The learner shell is public/app/, with shared assets in public/assets/design/. Private learner records belong in PostgreSQL. The Docker build uses an explicit runtime allowlist and excludes local learner files, secrets, agent state and handoffs.

The separate host Node launcher, its database bootstrap and the old installer have been removed. For developers who already use npm, npm start delegates to Docker Compose; it does not start a host Node server. Historical installed-app instructions remain in Git history. Node remains inside the image; server.js is its entrypoint, not an alternative host setup.

Developer checks remain available in a clean source checkout. They must use synthetic data and isolated services; never aim generic checks at an existing learner installation. See work/implementation/DOCKER-ONLY-01.md for this change and its measured validation.
