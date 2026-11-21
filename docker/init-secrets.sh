#!/bin/sh
set -eu

create_password() {
    if [ -s "$1/password" ]; then return; fi
    umask 077
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$1/password.tmp"
    test "$(wc -c < "$1/password.tmp")" -eq 48
    chmod 0444 "$1/password.tmp"
    mv "$1/password.tmp" "$1/password"
}

create_password /run/database-secrets
create_password /run/demo-secrets
