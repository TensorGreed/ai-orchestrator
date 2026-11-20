#!/bin/sh
# Starts the API for docker-compose.quickstart.yml: fills in what a first start needs, then runs the API as the
# image's default command does.
#
#   - SECRET_MASTER_KEY_BASE64 unset: a random 32-byte key is made once and kept in the data volume
#     (quickstart/master-key, mode 0600). Later starts read it from there. It is never printed.
#     If the volume already holds a database but no key, it stops instead (a new key would make the stored
#     secrets unreadable).
#   - BOOTSTRAP_ADMIN_PASSWORD unset on a new install (no database file yet): a random password is made once,
#     kept in quickstart/initial-admin-password (mode 0600) and printed to the log once, with the address and the
#     email to sign in with.
#
# Everything stays in the data volume; nothing is sent anywhere. Set SECRET_MASTER_KEY_BASE64 and
# BOOTSTRAP_ADMIN_PASSWORD yourself to skip both.
set -eu

data_dir=${L2M_DATA_DIR:-/app/apps/api/data}
state_dir="$data_dir/quickstart"
url=${L2M_PUBLIC_URL:-http://localhost:8080}

umask 077
mkdir -p "$state_dir"
new_install=no
[ -e "$data_dir/orchestrator.db" ] || new_install=yes

# Prints <bytes> random bytes, base64 (url-safe and unpadded with "url"). Fails rather than print nothing.
random_base64() {
  value=$(node -e 'const b = require("node:crypto").randomBytes(Number(process.argv[1])); process.stdout.write(process.argv[2] === "url" ? b.toString("base64url") : b.toString("base64"));' "$1" "${2:-}")
  [ -n "$value" ] || {
    echo "L2M quickstart: could not generate random bytes" >&2
    exit 1
  }
  printf '%s' "$value"
}

# Writes <value> to <file> atomically (a partial file is never left behind).
write_file() {
  printf '%s' "$2" > "$1.tmp"
  mv -f "$1.tmp" "$1"
}

if [ -z "${SECRET_MASTER_KEY_BASE64:-}" ]; then
  key_file="$state_dir/master-key"
  if [ ! -s "$key_file" ]; then
    # Data without its key: a new key would leave every stored secret unreadable, so stop and say why.
    if [ "$new_install" = no ]; then
      echo "L2M quickstart: this data volume has a database but no master key (quickstart/master-key), and" >&2
      echo "SECRET_MASTER_KEY_BASE64 is not set. Set it to the key this database was created with; a new key would" >&2
      echo "make the stored secrets unreadable." >&2
      exit 1
    fi
    key=$(random_base64 32)
    write_file "$key_file" "$key"
    echo "L2M quickstart: made a master key for stored secrets and saved it in the data volume (quickstart/master-key)."
    echo "L2M quickstart: back up the data volume; without that key, saved secrets cannot be read."
  fi
  SECRET_MASTER_KEY_BASE64=$(cat "$key_file")
  export SECRET_MASTER_KEY_BASE64
fi

admin_email=${BOOTSTRAP_ADMIN_EMAIL:-admin@l2m.local}
BOOTSTRAP_ADMIN_EMAIL=$admin_email
export BOOTSTRAP_ADMIN_EMAIL

# The generated password is only passed on a new install; once the admin exists the API ignores it anyway.
if [ -z "${BOOTSTRAP_ADMIN_PASSWORD:-}" ] && [ "$new_install" = yes ]; then
  password_file="$state_dir/initial-admin-password"
  if [ ! -s "$password_file" ]; then
    password=$(random_base64 18 url)
    write_file "$password_file" "$password"
    echo "================================================================================"
    echo " L2M is starting. When it is ready, sign in at $url"
    echo "   email:    $admin_email"
    echo "   password: $password"
    echo " This password is printed once. It is also kept in the data volume; to read it again:"
    echo "   docker compose exec api cat $password_file"
    echo "================================================================================"
  fi
  BOOTSTRAP_ADMIN_PASSWORD=$(cat "$password_file")
  export BOOTSTRAP_ADMIN_PASSWORD
fi

# Compose passes an unset password as an empty string, which the API would refuse as too short.
[ -n "${BOOTSTRAP_ADMIN_PASSWORD:-}" ] || unset BOOTSTRAP_ADMIN_PASSWORD

# Files the API itself writes get the image's usual permissions.
umask 022
exec pnpm --filter @ai-orchestrator/api start
