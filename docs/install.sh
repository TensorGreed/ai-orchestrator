#!/bin/sh
# L2M installer: https://lsquarem.com/install.sh
#
#   curl -fsSL https://lsquarem.com/install.sh | sh
#
# What it does, and nothing else:
#   1. checks that Docker and Docker Compose v2 are installed and usable by you (it never uses sudo)
#   2. downloads docker-compose.quickstart.yml of the L2M release into ./l2m/docker-compose.yml
#   3. pulls the images and starts them (docker compose up -d)
#   4. waits until the studio answers, then prints its address and how to sign in
# Run it again to update the compose file and restart; your data stays in the l2m-quickstart_l2m-data volume.
# It sends nothing anywhere except the downloads from GitHub and the image registry.
#
# Settings (environment variables, all optional):
#   L2M_VERSION  release to install, a tag such as v0.1.0 (default: the one installed before, else v0.1.0)
#   L2M_DIR      folder for the compose file (default ./l2m)
#   L2M_PORT     port of the studio on this machine (default 8080)
#   L2M_PULL     when to pull the images: always (default) or missing
#
# Without this script, the same in two commands:
#   curl -fsSL https://raw.githubusercontent.com/TensorGreed/l2m/v0.1.0/docker-compose.quickstart.yml -o docker-compose.yml
#   docker compose up -d

# Everything runs from main, called on the last line, so a partly downloaded script does nothing.
set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'L2M install: %s\n' "$*" >&2
  exit 1
}

# Downloads <url> to <file>.
download() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed to download the compose file."
  fi
}

# Exits 0 when <url> answers with a success status.
answers() {
  if command -v curl > /dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 5 "$1" > /dev/null 2>&1
  else
    wget -q -O /dev/null -T 5 "$1" > /dev/null 2>&1
  fi
}

# Prints the value of <key> in ./.env, if any.
get_env() {
  if [ -f .env ]; then sed -n "s/^$1=//p" .env | tail -n 1; fi
}

# Sets <key>=<value> in ./.env, keeping its other lines (and, with umask 077, private to you).
set_env() {
  if [ -f .env ]; then
    grep -v "^$1=" .env > .env.tmp || true
  else
    : > .env.tmp
  fi
  printf '%s=%s\n' "$1" "$2" >> .env.tmp
  mv -f .env.tmp .env
}

# Exits 0 when <value> is a release tag: v<major>.<minor>.<patch>, optionally -<letters, digits, dots, dashes>.
is_release_tag() {
  printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' && [ "$(printf '%s\n' "$1" | wc -l)" -eq 1 ]
}

main() {
  umask 077
  default_version=v0.1.0
  version=${L2M_VERSION:-}
  dir=${L2M_DIR:-./l2m}
  port=${L2M_PORT:-}
  pull=${L2M_PULL:-always}

  [ -z "$version" ] || is_release_tag "$version" \
    || fail "L2M_VERSION must be a release tag such as $default_version (got '$version')."
  case $pull in
    always | missing) ;;
    *) fail "L2M_PULL must be always or missing (got '$pull')." ;;
  esac
  case $port in
    '' | *[!0-9]*) [ -z "$port" ] || fail "L2M_PORT must be a number (got '$port')." ;;
  esac

  command -v docker > /dev/null 2>&1 \
    || fail "Docker is not installed. Install Docker Desktop or Docker Engine (https://docs.docker.com/get-docker/), then run this again."
  docker info > /dev/null 2>&1 \
    || fail "Docker is installed but not running, or your user may not use it. Start Docker (or add your user to the docker group) and run this again. This script does not use sudo."
  docker compose version > /dev/null 2>&1 \
    || fail "Docker Compose v2 (the 'docker compose' command) is needed: https://docs.docker.com/compose/install/"

  mkdir -p -- "$dir"
  cd -- "$dir"
  # Keep the release installed before unless one is asked for: never move an install back by accident.
  if [ -n "$version" ]; then
    set_env L2M_VERSION "$version"
  else
    version=$(get_env L2M_VERSION)
    [ -n "$version" ] || {
      version=$default_version
      set_env L2M_VERSION "$version"
    }
  fi
  # The compose file comes from a release tag; with L2M_VERSION=latest (set by hand in .env) the images follow
  # the newest release and the file stays this script's release.
  compose_tag=$version
  is_release_tag "$compose_tag" || compose_tag=$default_version
  compose_url=${L2M_COMPOSE_URL:-https://raw.githubusercontent.com/TensorGreed/l2m/$compose_tag/docker-compose.quickstart.yml}
  say "L2M install: downloading the $compose_tag compose file into $(pwd)/docker-compose.yml"
  download "$compose_url" docker-compose.yml.tmp || fail "could not download $compose_url"
  grep -q 'ghcr.io/tensorgreed/l2m' docker-compose.yml.tmp || {
    rm -f docker-compose.yml.tmp
    fail "$compose_url is not the L2M quickstart compose file."
  }
  mv -f docker-compose.yml.tmp docker-compose.yml
  [ -z "$port" ] || set_env L2M_PORT "$port"
  [ -n "$port" ] || port=$(get_env L2M_PORT)
  port=${port:-8080}

  first_install=yes
  if docker volume inspect "${COMPOSE_PROJECT_NAME:-l2m-quickstart}_l2m-data" > /dev/null 2>&1; then
    first_install=no
  fi

  say "L2M install: starting L2M (the first download of the images takes a minute or two)"
  if [ "$pull" = always ]; then
    docker compose pull --quiet
  fi
  docker compose up -d

  url="http://localhost:$port"
  say "L2M install: waiting for $url"
  tries=0
  until answers "$url/health"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 90 ]; then
      fail "the studio did not answer within 3 minutes. See the log with: cd $(pwd) && docker compose logs api"
    fi
    sleep 2
  done

  say ""
  say "L2M is running: $url"
  password_file=/app/apps/api/data/quickstart/initial-admin-password
  if [ "$first_install" = yes ] && password=$(docker compose exec -T api cat "$password_file" 2> /dev/null) && [ -n "$password" ]; then
    email=$(docker compose exec -T api printenv BOOTSTRAP_ADMIN_EMAIL 2> /dev/null || echo admin@l2m.local)
    say "Sign in with"
    say "  email:    $email"
    say "  password: $password"
  else
    say "Sign in with the admin account. Its first password, if L2M made one, is shown by:"
    say "  cd $(pwd) && docker compose exec api cat $password_file"
  fi
  say ""
  say "Stop: cd $(pwd) && docker compose stop    Remove with all data: docker compose down -v"
  say "Docs: https://lsquarem.com/docs/getting-started/install"
}

main "$@"
