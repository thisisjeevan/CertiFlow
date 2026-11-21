# CertiFlow final submission audit

- **Reviewed checkpoint** `35a5bce` on `main`
- **Audit date** 21 November 2026
- **Scope** All five pages of the [original problem statement](problem-statement.pdf), the committed application and history, a fresh local clone, and isolated runtime verification.

**GO for publishing the reviewed source once authorized. NO-GO for filing the final submission until a public GitHub URL and a shareable demo recording of at most two minutes have been verified.** The form has not been submitted. No submission-blocking code defect or committed live credential was found. This audit changed only this report.

## Requirements-to-evidence matrix

PASS means the requirement has code and corroborating test, runtime, or document evidence. PARTIAL identifies a verified boundary or an untested production claim. MISSING means the submission evidence was unavailable in this audit.

### Product, safety, and technical requirements

| Brief requirement | Result | Evidence and limits |
| --- | --- | --- |
| Centres create, import, submit, and track batches | PASS | Centre-owned drafts, validated CSV replacement, submission and status in the React workspace. [Batch service](apps/api/src/batches/service.ts) · [Intake tests](apps/api/tests/integration/batches.test.ts#L146) |
| Invalid rows receive precise errors with zero partial writes | PASS | Physical row and field errors. An invalid replacement preserves the previous roster, completion claims, and version. [CSV parser](apps/api/src/batches/csv.ts) · [Intake tests](apps/api/tests/integration/batches.test.ts#L165) |
| Reviewers see their queues and can approve, reject, or return with reasons | PASS | Role, district, stage, and current revision are checked server-side. Returns and rejections require a reason. [Review queries](apps/api/src/workflow/read.ts) · [Review routes](apps/api/src/workflow/routes.ts) · [Decision tests](apps/api/tests/integration/workflow.test.ts#L436) |
| District approval requires two officers | PASS | A single vote leaves the stage unchanged. Two different officers produce one transition. Duplicate votes cannot count twice. [Review policy](apps/api/src/workflow/policy.ts) · [Concurrency tests](apps/api/tests/integration/workflow.test.ts#L396) |
| Large batches receive extra quality scrutiny, with final approval at state level | PASS | The 49/50 boundary is tested. A 60-candidate batch went through the quality gate and state approval over HTTP. [Decision tests](apps/api/tests/integration/workflow.test.ts#L405) · [60-candidate test](apps/api/tests/integration/certificates.test.ts#L171) |
| Centres can correct and resubmit with deliberate treatment of earlier votes | PASS | Returns preserve decisions and snapshots. A corrected submission starts a new revision with an empty vote count. Stale decisions fail. [Correction code](apps/api/src/batches/service.ts) · [Correction test](apps/api/tests/integration/workflow.test.ts#L496) |
| State office sees blocked reviews and can revoke certificates | PASS | The worker scans all three pending stages after 24 hours and alerts active state officers. State revocation requires a reason and records the actor and time. [Scanner](apps/api/src/workflow/escalation.ts) · [Escalation tests](apps/api/tests/integration/workflow.test.ts#L260) · [Revocation test](apps/api/tests/integration/certificates.test.ts#L365) |
| Candidates receive one private certificate through a fallible WhatsApp stand-in | PASS | PDF and QR generation, a private volume, one delivery ledger entry per certificate, mock rejection, timeout after acceptance, and retry are implemented. The brief permits a stand-in. [PDF renderer](apps/api/src/certificates/pdf.ts) · [Provider and retry tests](apps/api/tests/integration/certificates.test.ts#L308) |
| Anonymous certificate verification and immediate revocation | PASS | A fresh lookup reads the PostgreSQL primary, bypasses caches, and discloses only the permitted fields. It verifies the current status of the number. Authenticity of a copied or altered PDF is outside the lookup’s scope. [Verification implementation](apps/api/src/certificates/access.ts) · [Public lookup test](apps/api/tests/integration/certificates.test.ts#L365) |
| Staff see changes without refreshing | PASS | SSE refreshes authorized review, notification, and certificate views. Cross-instance isolation and reconnect recovery are tested. Chromium confirmed updates with no page navigation. [SSE server](apps/api/src/live.ts) · [Client](apps/web/src/LiveUpdates.tsx) · [SSE tests](apps/api/tests/integration/workflow.test.ts#L182) |
| Live changes for every viewer, including the public | PARTIAL | A fresh public lookup reflects current revocation immediately. An anonymous result already on screen shows the last lookup until the viewer checks again. [Public verification page](apps/web/src/PublicCertificate.tsx) |
| Staff cannot impersonate actors or act outside their authority | PASS | Sessions use a stored SHA-256 token digest, salted scrypt password hashes, expiry and active-account checks. Mutations revalidate the actor and scope. Centre/district/role boundaries and input tampering are tested. [Sessions](apps/api/src/auth/session.ts) · [Auth tests](apps/api/tests/integration/auth.test.ts#L77) · [Decision tests](apps/api/tests/integration/workflow.test.ts#L436) |
| A candidate gets one certificate and certificate numbers cannot collide | PASS | Database uniqueness covers the stable candidate, completion, and certificate number. Replays and concurrent generation preserve rows and the stored file. [Schema](apps/api/prisma/schema.prisma) · [Replay and concurrency tests](apps/api/tests/integration/certificates.test.ts#L198) |
| Strangers cannot obtain private certificates or candidate details | PASS | A certificate-specific bearer grant is required for private PDF bytes. Missing, invalid, expired, and revoked grants are denied. The public lookup exposes no names, phone numbers, or download links. [Certificate access](apps/api/src/certificates/access.ts) · [Grant tests](apps/api/tests/integration/certificates.test.ts#L365) |
| Every reviewer decision is attributable and outcomes are traceable | PASS | Persisted actor and timestamp, retained revision snapshots, decision and transition audit, linked issuance/delivery outbox records, attempt history, and revocation audit. Escalation is recorded as a system action. [Decision code](apps/api/src/workflow/decisions.ts) · [Read and timeline code](apps/api/src/workflow/read.ts) · [Certificate worker](apps/api/src/certificates/generation.ts) |
| Six named demo roles and reproducible sample data | PASS | Anika, Dev, Meera, Kabir, Neha, and Farah are seeded with the completion register, 3- and 60-candidate review batches, and a 25-hour overdue example. Fresh data and browser sign-in worked. [Seed](apps/api/src/seed.ts) · [Batch fixtures](apps/api/src/workflow/demo-batches.ts) |
| Event-driven behavior and durable recovery | PASS | Approval, audit and outbox commit together. Issuance is asynchronous. Leases allow republishing after Redis loss. Handler state and provider receipts control replay. The suite kills a real worker and recovers its active job. [Dispatcher](apps/api/src/certificates/dispatcher.ts) · [Worker and Redis tests](apps/api/tests/integration/certificates.test.ts#L232) |
| Scale by adding capacity and retain correctness through restarts | PARTIAL | Parallel API instances, overlapping database writes, duplicate jobs, and worker restart are tested. Local PDFs require a shared same-host volume. Multi-host storage and the production throughput target have not been load-tested or deployed. [Integration tests](apps/api/tests/integration) · [Deployment plan](DEPLOYMENT.md) |
| Required stack and queue explanation | PASS | React and Vite, Express and TypeScript, PostgreSQL and Prisma migrations, Redis and BullMQ. README explains the queue, application state, and recovery. [Manifests](package.json) · [Architecture](README.md#architecture) |
| Redis in the architecture | PARTIAL | Redis serves BullMQ coordination and persistence for queued work. A separate application-data cache is absent. Public revocation and session checks intentionally read PostgreSQL. [Compose](docker-compose.yml) · [Worker](apps/api/src/worker.ts) |
| Containerized startup with one command from a fresh clone | PASS | Clean-clone `docker compose up --build --wait` succeeded with new volumes. API, DB, Redis, and web were healthy, the worker was running, and migrations and seed exited successfully. [Compose](docker-compose.yml) · [Setup](README.md#run-from-a-fresh-clone) |
| Automated coverage of the six moments and invariants | PASS | All six scenarios have tests against migrated PostgreSQL. The issuance tests also use a dedicated Redis service and a real worker process. See the table below. [Integration suite](apps/api/tests/integration) |

### Submission and deployment requirements

| Brief requirement | Result | Evidence and limits |
| --- | --- | --- |
| Requirements note and policy choices at the top of the README | PASS | District vote threshold, quality threshold, correction, rejection, escalation, revocation, and candidate identity are explicit. [README](README.md#requirements-and-assumptions) |
| Setup guide with demo accounts and tests | PASS | The documented Docker startup and test commands passed from a clean clone. README explains password retrieval and data retention. [Setup](README.md#run-from-a-fresh-clone) |
| Deployment diagram and hosting rationale | PASS | The plan describes browsers, edge and load balancer, Express and SSE, PostgreSQL, Redis, workers, provider and private storage. It specifies placement and managed service choices. [Architecture](DEPLOYMENT.md#architecture-and-hosting) |
| Deployment load, scaling limits, and backlog clearance | PASS | Covers 100,000 registered users, 10,000 daily active users, 500 approvals per peak hour, roughly 30,000 PDFs and sends, and burst verification. States throughput assumptions and drain-time estimates. [Design load](DEPLOYMENT.md#design-load) · [Throughput](DEPLOYMENT.md#throughput-and-backlogs) |
| Plan for worker crash, Redis restart, provider outage, slow database | PASS | Lists recovery behavior and distinguishes the mock provider from a real deployment. Database failover and production provider behavior are planned. [Failure handling](DEPLOYMENT.md#failure-handling) |
| Deployment storage and access control | PASS | Private S3, IAM, encryption, database-backed revocation and access validation are specified. Local Docker uses a private volume. [Certificate storage](DEPLOYMENT.md#certificate-storage-and-access) |
| Monitoring, alerting, estimated monthly costs and trade-offs | PASS | Lists signals, initial page thresholds, components, cost ranges, and managed-service trade-offs. Production instrumentation and pricing were outside runtime verification. [Monitoring](DEPLOYMENT.md#monitoring) · [Cost assumptions](DEPLOYMENT.md#rough-monthly-cost) |
| AI use and checks disclosed | PASS | README says where AI assisted and points to executable migration and test checks. [README](README.md#operational-limits) |
| Public GitHub repository and accessible URL | MISSING | The local source contains Dockerfiles, Compose, migrations, fixtures, docs, and tests. This audit found no configured Git remote and did not publish the source. |
| Shareable demonstration video, at most two minutes | MISSING | No video or share link was provided for verification. The browser and API evidence below is local. |
| Submission form | MISSING | No submitted form was verified. Submit only after the public repository and shareable video are ready. |

## Six required failure scenarios

| # | Result | Automated proof |
| --- | --- | --- |
| 1. Invalid spreadsheet is explained and atomic | PASS | An invalid physical row reports its field and leaves zero changes. A failed replacement retains the prior snapshots, claims, and version. [Intake tests](apps/api/tests/integration/batches.test.ts#L165) |
| 2. Simultaneous district approvals advance once | PASS | Two HTTP requests overlap at a real PostgreSQL lock. Both legitimate votes persist and there is one district transition. A duplicate actor is rejected. [Workflow tests](apps/api/tests/integration/workflow.test.ts#L414) |
| 3. Unreliable provider still yields 60 unique certificates and messages | PASS | The complete approval workflow yields 60 unique private PDFs and a receipt per candidate. Tests cover replay, simultaneous generation, rejection, bounded retries, timeout after provider acceptance, worker termination, and Redis job loss. [Certificate tests](apps/api/tests/integration/certificates.test.ts#L171) |
| 4. Revocation takes effect publicly | PASS | Public lookup changes from valid to revoked after the state transaction. Existing grants fail and pending sends are suppressed. [Revocation and grant tests](apps/api/tests/integration/certificates.test.ts#L365) |
| 5. Stalled review alerts a senior officer automatically | PASS | The scanner tests the exact 24-hour boundary and the first overdue millisecond, state-only recipients, concurrent scans, uniqueness, and resets across stages and revisions. Fresh worker startup produced the seeded escalation. [Escalation tests](apps/api/tests/integration/workflow.test.ts#L260) |
| 6. Correction retains attribution and starts fresh approval | PASS | The HTTP test returns a voted batch, opens and submits a new revision, rejects stale votes, and checks both histories and the new count. [Correction test](apps/api/tests/integration/workflow.test.ts#L496) |

## Security, concurrency, and publication review

- **Authentication and isolation.** The API derives role and jurisdiction from the active session. Protected CRUD and decision queries enforce centre/district access. Login is rate-limited, cookies are HttpOnly and SameSite=Lax, and HTTPS enables Secure. Browser writes enforce origin and content type. SSE rechecks session expiry, active status, and scope at each poll and sends only the names of views to refetch. Database-backed REST queries authorize the actual data.
- **Atomicity and replay.** Draft writes and decisions share a centre lock and recheck the draft version or active revision. The suite verified rollback when the outbox insert fails. A unique vote constraint, single-live-revision constraint, and composite batch ownership keys protect against inconsistent writes. Outbox leases, durable worker state, unique certificate and receipt keys, and PostgreSQL row locks handle replay and concurrent work. Escalations are unique per revision and stage and persist together with audit and recipient notifications.
- **File and verification boundaries.** The worker can write the private volume. The API can only read it and serves bytes after checking the grant and current revocation. The public web service cannot serve the private volume. Public verification and downloads send no-store responses. Verification only reports what the certificate number can prove and a fresh check is required for current status.
- **Git audit.** A pattern scan examined five reachable commits and 145 distinct blobs, including the brief’s extracted text and metadata. It found no credential file or live credential. Flagged lines were empty template fields, test-only values, or a URL built from a runtime password mount. The PDF has no embedded attachments. Committed email addresses use reserved test domains and CSV phone examples are fictional 555-01xx numbers. Package artifacts resolve from the public npm registry. The scan checks common credential patterns and does not guarantee discovery of every possible secret.
- **Local versus hosted configuration.** Compose publishes only the web service on loopback. PostgreSQL, Redis, and the Express port are internal. Bootstrap generates independent random database, demo, and link secrets into volumes. The development HTTP settings, demo accounts, and mock modes are for local use. The optional native Express server binds all interfaces. Use the loopback-only Compose setup for recording. Production TLS, narrow database roles, shared private storage, edge rate limits, and monitoring are deployment work.
- **Public source hygiene.** Publish only the intended branch and reviewed files once authorized. Keep local refs, Docker volumes, environment files, logs, and temporary QA output outside the release. Keep the generated password and bearer tokens out of the recording. `npm audit --json` reported zero advisory findings across the npm tree. Container OS advisories were outside this scan.

## Documentation accuracy and remaining limits

- README’s clone steps, demo accounts, approval policy, outbox recovery, mock behavior, and live-update mechanism match tested behavior. The endpoint table describes the download as streaming. The current handler buffers the PDF in memory before sending it. Object-storage streaming is described in the production plan.
- DEPLOYMENT.md identifies its target separately from the running Compose implementation. Throughput, cloud costs, alerts, failover, and worker sizing are estimates and operating plans that need production validation.
- Live staff updates use one-second scoped state checks with coalesced invalidations. A public result already on screen shows the last lookup. Application rate limits are per API process.
- Intake is UTF-8 CSV. PDF storage uses a single Docker host locally. Download grants last 24 hours. Manual grant renewal and resend after terminal failures are pending. Actual WhatsApp delivery guarantees depend on a real provider.

## Verification record

| Check | Observed result |
| --- | --- |
| `npm run lint` | Exit 0 |
| `npm run typecheck` | Exit 0 for API and web |
| `npm run build` | Exit 0 for API and Vite production bundle |
| `npm test` | 18 passed, 0 failed across 4 unit files |
| Clean clone with `git clone --local --no-hardlinks --single-branch --branch main` | Checked out `35a5bce` with a clean worktree |
| `docker compose -p certiflow-final-audit up --build --wait` | Exit 0 with new volumes on port 8085. Migrations and seed finished. Existing demo projects were preserved. |
| `docker compose -p certiflow-final-audit --profile test run --rm --build tests` | 18 unit and 55 integration tests passed, 0 failed. Integration breakdown was 21 workflow, 10 certificates, 14 intake, 5 authentication, and 5 integrity. |
| `GET /health/live` and `GET /health/ready` | Both returned 200 in the clean clone. The original and populated Milestone 5 demo readiness checks also returned 200. |
| `npm audit --json` | Exit 0, zero npm advisories |
| Isolated worker and private storage | Fresh worker logged one automatic escalation. The worker mount was writable and the API mount was read-only. |
| Chromium on the clean clone | Four independent signed-in sessions. Anika’s submit reached Dev, Meera’s vote updated Dev’s open detail, Dev’s vote moved Anika and Farah to state review, and Farah saw 3 of 3 certificates issued and delivered. No page refresh or navigation occurred. Farah also saw the seeded alert. |
| Seeded 60-candidate API replay on the clean clone | Two concurrent district decisions, followed by the quality gate and final state approval. Observed 60 unique issued certificates and 60 mock receipts, with 12 rejections retried and 12 timeout receipts recovered. A valid grant downloaded a PDF. No grant returned 403. After revocation the public result was revoked and the old grant returned 403. |

## Safest reproducible demo

Use a fresh Compose project so previously consumed training completions and revocations cannot affect the recording. Existing demo data can stay in its volumes.

```powershell
$env:CERTIFLOW_PORT = '8086'
docker compose -p certiflow-submission-demo up --build --wait
Invoke-RestMethod http://localhost:8086/health/ready
$demoPassword = docker compose -p certiflow-submission-demo run --rm --no-deps --entrypoint cat seed /run/demo-secrets/password
```

1. Open separate browser profiles for Anika and Dev. As Anika, create **Solar Installation Basics** and import [invalid-candidates.csv](apps/web/public/samples/invalid-candidates.csv). Show the row errors and unchanged roster. Import [valid-candidates.csv](apps/web/public/samples/valid-candidates.csv), submit, and show the new queue entry in Dev’s already-open tab.
2. Use **Digital Skills** for the 60-person flow. Dev and Meera give the district votes, Neha approves at quality, and Farah approves at state. Wait for 60 issued and 60 delivered in the state workspace. Open the mock inbox to show receipt reuse and successful retry.
3. Open one fresh mock download link, show the PDF and QR, and verify anonymously. Revoke that certificate with a reason as Farah, then run a fresh public lookup and show the revoked result. Use a different valid certificate for another take.
4. Show **Overdue Review Demo** under Farah’s Notifications. A fresh seed supplies the already-aged district review. For correction history, use **Electrical Safety** separately. Have one district officer approve and a second return it. In Anika’s correction, keep the Electrical completion references when editing the copied roster, submit revision 2, and open it as Dev to show the earlier decision and the fresh district vote count.
5. For a recording capped at two minutes, prepare the separate profiles and batch states off-camera. Prioritize the invalid import, live queue update, 60/60 delivery, and public revocation. Confirm the recording duration and that its share link opens in a signed-out browser before submitting the form.

Stop only the new project if desired. `docker compose -p certiflow-submission-demo stop` retains its data.
