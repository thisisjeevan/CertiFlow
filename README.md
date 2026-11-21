# CertiFlow

## Requirements and assumptions

CertiFlow is the Pragati Skills Mission’s staff workspace for deciding who gets certified, issuing certificates, and letting the public check whether a certificate is valid. The programme processes about 8,000 candidates a month through more than 300 training centres. The [hackathon brief](problem-statement.pdf) is the source of the product and submission requirements.

Training centres create batches, import passed candidates from a spreadsheet, submit them, track progress, and correct returned submissions. District officers review batches in their jurisdiction. A quality team reviews large batches, and state officers make the final decision, monitor stuck work, and can revoke a certificate. Candidates receive a private download through simulated WhatsApp. Employers can verify a certificate anonymously. In-app updates should arrive without refreshing, and decisions and escalations must be traceable.

The brief calls for district agreement, extra scrutiny for large batches, and escalation of slow reviews. CertiFlow’s chosen policies set the specifics.

| Policy | CertiFlow decision |
| --- | --- |
| District review | Two distinct district officers assigned to the centre’s district must approve. |
| Quality review | A submitted revision with 50 or more candidates requires quality review. |
| State review | Every batch requires final state approval. |
| Return and correction | Officers give a reason. Correction creates a new revision, preserves historical decisions, and requires fresh approvals. |
| Rejection | Officers give a reason. A rejection closes the current submission. |
| Escalation | Escalate a pending review stage after 24 hours. Record the notification and deduplicate by revision, stage, and recipient. |
| Revocation | Only an authorized state officer may revoke, with a reason. Public verification reads current status from PostgreSQL. |
| Candidate identity | A centre’s candidate reference identifies one participant in a batch. Retain that identity through corrections. A separate completed course can earn a separate certificate. |

The final workflow must demonstrate all six scenarios.

| Scenario | Required proof |
| --- | --- |
| A. Invalid spreadsheet | Identify each bad row and field. Persist zero rows from the invalid import. |
| B. Concurrent district approvals | Two officers can approve at the same time. Exactly one workflow transition occurs. |
| C. Results-day issuance | One approved 60-person batch yields exactly 60 unique certificates and one accepted mock delivery per candidate despite errors and timeouts. |
| D. Revocation | An anonymous lookup reflects revocation as soon as the transaction commits. |
| E. Escalation | Overdue work automatically creates a traceable escalation. |
| F. Corrected revision | Previous decisions stay visible. The new submission starts with fresh approvals. |

## Architecture

- **Web** uses React, Vite, and TypeScript. nginx serves the built frontend and proxies the API on the same origin.
- **API** is an Express TypeScript modular monolith. Auth stores a SHA-256 digest of a random session token in PostgreSQL and sends the original in an HttpOnly, SameSite cookie. Production configuration requires HTTPS. Passwords use salted scrypt. The centre directory filters access in database queries using the current account’s role and scope. A liveness probe tests HTTP and a readiness probe tests the migrated database.
- **Database** uses PostgreSQL and Prisma Migrate. The checked-in migrations create ownership and revision foreign keys, uniqueness across decisions and certificates, and SQL checks for role assignment and state-dependent metadata. Approval, PDF generation, and delivery have separate statuses. Outbox, notification, and audit tables are ready for future workflow events.
- **Worker** is a separate process from the backend package. BullMQ uses Redis for coordination and currently runs an idempotent session-expiry sweep. Expired sessions are refused immediately by the API. Redis can go offline while the API continues serving requests.
- **Workflow design** puts approval transitions, audit entries, and outbox inserts in one PostgreSQL transaction. Workers process committed events, deduplicate side effects, and reconcile unfinished work after outages. The [deployment plan](DEPLOYMENT.md) describes this target architecture.

| Endpoint | Purpose |
| --- | --- |
| GET `/health/live` | HTTP liveness |
| GET `/health/ready` | Checks the migrated session table and returns 503 on database failure |
| POST `/api/auth/login` | JSON email and password, then a session cookie |
| GET `/api/auth/me` | Current authenticated account |
| POST `/api/auth/logout` | Revokes the session and clears the cookie. Send an empty JSON object. |
| GET `/api/centres` | Directory scoped to the current account |
| GET `/api/centres/:id` | Scoped centre detail. Returns 404 for missing or inaccessible centres. |

## Run from a fresh clone

Start Docker Desktop with Linux containers enabled. Run the following from the repository root.

```powershell
docker compose up --build --wait
```

Open [http://localhost:8080](http://localhost:8080). If port 8080 is busy, set `$env:CERTIFLOW_PORT = '8081'` before the Compose command and use localhost on that port. Use `localhost` as the hostname so the application origin matches the browser.

Startup creates local credentials in Docker volumes, applies both migrations, and seeds the demo accounts. Use the following command to retrieve the shared, randomly generated demo password from your local Docker project.

```powershell
docker compose run --rm --no-deps --entrypoint cat seed /run/demo-secrets/password
```

| Name | Email | Workspace |
| --- | --- | --- |
| Anika | anika@demo.certiflow.test | Training centre |
| Dev | dev@demo.certiflow.test | District officer |
| Meera | meera@demo.certiflow.test | District officer |
| Kabir | kabir@demo.certiflow.test | District officer |
| Neha | neha@demo.certiflow.test | Quality reviewer |
| Farah | farah@demo.certiflow.test | State officer |

Anika sees her centre. District officers see the two centres in their district. Quality and state accounts see all three centres. Sign out to switch accounts. The demo credential stays in the same Docker volume across ordinary stops and starts. Only the web service is published, on the loopback interface.

```powershell
docker compose ps -a
Invoke-RestMethod http://localhost:8080/health/live
Invoke-RestMethod http://localhost:8080/health/ready
docker compose logs worker
docker compose --profile test run --rm --build tests
```

The test container migrates `certiflow_test` and runs Vitest/Supertest unit and PostgreSQL integration tests. The demo database is separate. Use `docker compose down` to stop the project while retaining data.

### Optional native development

Install Node.js 22.18+ on the 22.x line or a current Node.js 24.x release, and have PostgreSQL and Redis available. Copy `.env.example` to `.env`, set the PostgreSQL URL and a local demo password of at least 16 characters, and adjust the Redis URL if needed.

```powershell
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run db:migrate
npm run db:seed
```

In separate terminals, run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web`. Open [http://localhost:5173](http://localhost:5173). For native PostgreSQL integration tests, use a dedicated database whose name ends in `_test`. In a separate terminal set `DATABASE_URL` and `TEST_DATABASE_URL` to that database URL, then run `npm run db:migrate` followed by `npm run test:integration`.

## Milestone 1 scope

The running shell covers sign-in, session restoration, sign-out, and a scoped training-centre directory. The demo seed supplies staff and centres. The schema records candidate revisions, decisions, generation, delivery, audit, notifications, and outbox state. The API currently exposes foundation endpoints only, and the worker handles session maintenance.

Next comes draft batch creation and atomic spreadsheet import with row-level errors. Add the revision-scoped approval service and two-officer concurrency test before building issuance. PDF download, mock WhatsApp, public verification, revocation, escalations, workflow audit and notification SSE, and the full A–F scenario suite are pending. Local login limiting applies per API process. Production will need shared rate limiting, staff account provisioning, and database credentials with limited privileges.

The lockfile pins Prisma’s transitive Effect dependency to a patched 3.x release.

AI assistance was used to scaffold, implement, and review the foundation. The migration and unit and integration tests are executable checks for the resulting code. The final submission also calls for an approved public GitHub repository and a demo video of at most two minutes.
