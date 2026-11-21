#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
    db_password="$(cat /run/database-secrets/password)"
    export DATABASE_URL="postgresql://certiflow:$db_password@db:5432/${DATABASE_NAME:-certiflow}"
fi

if [ -z "${CERTIFICATE_LINK_SECRET:-}" ] && [ -r /run/certificate-secrets/password ]; then
    export CERTIFICATE_LINK_SECRET="$(cat /run/certificate-secrets/password)"
fi

case "$1" in
    demo-seed)
        export DEMO_PASSWORD="$(cat /run/demo-secrets/password)"
        exec node apps/api/dist/seed.js
        ;;
    test)
        export TEST_DATABASE_URL="$DATABASE_URL"
        npm run db:migrate
        npm run test -w @certiflow/api
        exec npm run test:integration -w @certiflow/api
        ;;
    *) exec "$@" ;;
esac
