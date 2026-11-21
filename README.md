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
- **Database** uses PostgreSQL and Prisma Migrate. The checked-in migrations create ownership and revision foreign keys, uniqueness across decisions and certificates, and SQL checks for role assignment and state-dependent metadata. Approval, PDF generation, and delivery have separate statuses. A centre-scoped completion register validates imported candidates. A unique claim prevents two batches from reusing the same training completion.
- **Worker** is a separate process from the backend package. BullMQ uses Redis for coordination and currently runs an idempotent session-expiry sweep. Expired sessions are refused immediately by the API. Redis can go offline while the API continues serving requests.
- **Batch submission** commits the transition to district review, the attributed audit entry, and the outbox event in one transaction. A PostgreSQL row lock on the centre serializes its writes, including completion claims across its batches. Each draft write checks the version returned by the last read. The [deployment plan](DEPLOYMENT.md) describes how future workers will consume committed events and reconcile unfinished work.

| Endpoint | Purpose |
| --- | --- |
| GET `/health/live` | HTTP liveness |
| GET `/health/ready` | Checks the migrated session table and returns 503 on database failure |
| POST `/api/auth/login` | JSON email and password, then a session cookie |
| GET `/api/auth/me` | Current authenticated account |
| POST `/api/auth/logout` | Revokes the session and clears the cookie. Send an empty JSON object. |
| GET `/api/centres` | Directory scoped to the current account |
| GET `/api/centres/:id` | Scoped centre detail. Returns 404 for missing or inaccessible centres. |
| POST `/api/batches` | Create revision 1 as a draft with JSON `centreId` and `courseName`. |
| GET `/api/batches` | List batches and their latest revision summaries for the assigned centre. |
| GET `/api/batches/:id` | View the latest revision and its candidates. |
| PATCH `/api/batches/:id` | Update the initial draft’s course with JSON `courseName`. |
| PUT `/api/batches/:id/candidates` | Replace the draft roster. Send the UTF-8 CSV bytes as `text/csv`. |
| POST `/api/batches/:id/submit` | Submit the validated draft to district review. Send an empty JSON object. |

## Run from a fresh clone

Start Docker Desktop with Linux containers enabled. Run the following from the repository root.

```powershell
docker compose up --build --wait
```

Open [http://localhost:8080](http://localhost:8080). If port 8080 is busy, set `$env:CERTIFLOW_PORT = '8081'` before the Compose command and use localhost on that port. Use `localhost` as the hostname so the application origin matches the browser.

Startup creates local credentials in Docker volumes, applies the migrations, and seeds the demo accounts and completion register. Use the following command to retrieve the shared, randomly generated demo password from your local Docker project.

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

## Batch intake and CSV template

Only a training-centre account can use the batch endpoints. It can create, read, edit, and submit for its assigned centre. PATCH, import, and submit require the current response value from `revision.version` in the `X-Draft-Version` header. A successful edit or import advances that version. A stale write returns HTTP 409. Fetch the batch again before retrying. Repeating a successful submission with the same version returns the submitted batch and reuses its recorded transition.

Use UTF-8, a comma delimiter, and this exact header order. A BOM and CRLF line endings are accepted. Format phone numbers and references as text before exporting from a spreadsheet editor.

| Column | Required value |
| --- | --- |
| `candidate_reference` | Case-sensitive participant ID within the batch. Use 1–64 ASCII letters, digits, periods, underscores, hyphens, or slashes. Start with a letter or digit. |
| `full_name` | Name with letters, up to 120 characters on one line. Quote names containing commas. |
| `phone_e164` | International phone number starting with `+` and a nonzero country calling code, followed by digits. Maximum 15 digits. |
| `completion_reference` | Case-sensitive reference from the centre’s training completion register. Uses the same format as the participant ID. |

The upload limit is 512 KiB and 1,000 candidate rows. The API checks each candidate’s completion against the centre, course, candidate ID, passed result, and completion date. A completion can be claimed by one batch. CSV values supply candidate contact details, while staff provision completion records separately. Compose seeds the demo register. Production needs a trusted provisioner for those records.

A successful import replaces the entire draft roster while retaining candidate IDs for the same references. Removing a draft-only candidate releases their completion claim. Earlier revision snapshots and their completion claims persist. A failed import leaves the prior roster and its version intact. Row validation returns HTTP 422 with `error.issues` entries containing a one-based spreadsheet row, field, and message. Blank lines still count toward row numbers. Malformed CSV returns HTTP 400, an unsupported type returns 415, and an oversized upload returns 413.

Changing the initial draft’s course preserves the roster. Submission revalidates every completion against the new course. Import a corrected CSV if any reference is ineligible. On successful submission, the roster becomes read-only and CertiFlow writes one `BATCH_SUBMITTED` audit record and one `batch.submitted` outbox event for the revision. The event contains identifiers and the candidate count.

### Try the import

1. Sign in as Anika and create a draft for **Solar Installation Basics**.
2. Upload the [invalid CSV](apps/web/public/samples/invalid-candidates.csv). The workspace shows errors on rows 3–6 and keeps the prior roster.
3. Upload the [valid CSV](apps/web/public/samples/valid-candidates.csv). Three candidates appear. Submit the batch and confirm its status shows District review.

The demo completion references remain assigned after submission. Use a separate set of provisioned completions or a fresh demo database to repeat the full demonstration.

## Milestone 2 scope

Batch intake delivers scenario A, including tested rollback and competing writes. The district approval engine and returned-batch correction flow come next. XLSX uploads, PDF generation and download, mock WhatsApp, public verification and revocation, escalations, workflow-event processing, and SSE are pending. Local login limiting applies per API process. Production will need shared rate limiting, staff account provisioning, and database credentials with limited privileges.

The lockfile pins Prisma’s transitive Effect dependency to a patched 3.x release.

AI assistance was used to scaffold, implement, and review the foundation. The migration and unit and integration tests are executable checks for the resulting code. The final submission also calls for an approved public GitHub repository and a demo video of at most two minutes.
