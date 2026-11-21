# CertiFlow engineering guide

- Use the root problem statement PDF as the authoritative hackathon brief. Business policy choices and current implementation status are in the README.
- Keep one TypeScript monorepo with a React/Vite client, an Express API, and a separate BullMQ worker process from the backend package. Use PostgreSQL with Prisma migrations and Redis for queue coordination. Docker Compose is the local entry point.
- PostgreSQL owns business state. Enforce structural invariants with keys and CHECK constraints and validate transitions and authorization inside database transactions. Add forward migrations for changes to an applied migration.
- Authenticate on the server. Derive actor, role, district, and centre from the current account. Require ownership and jurisdiction at the point of access. Filter public responses to explicitly allowed fields.
- Keep approval, generation, and delivery state independent. Keep revision snapshots and decisions attributable and preserve decision history when a revision changes.
- Write domain changes and outbox events together. Design eventual worker handlers for repeated execution and provider idempotency. Keep approval requests independent of Redis, PDF storage, and WhatsApp availability.
- Store certificate PDFs privately. Server-Sent Events will replay persisted, scoped events after reconnect. Public verification must read current revocation state.
- Check types, lint, and run Vitest/Supertest. Use migrated PostgreSQL integration tests for concurrency, transaction rollback, uniqueness and other database guarantees. Document commands actually run and any remaining limits.
- Keep credentials out of source and logs. Use the mock WhatsApp provider for development. Preserve existing files and local changes and obtain approval before pushing.
