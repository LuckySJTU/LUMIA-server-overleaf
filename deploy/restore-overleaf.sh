#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/overleaf.lumia.env"}
BACKUP_DIR=${2:-}
CONFIRM=${3:-}
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.lumia.yml"
RESTORE_TIMESTAMP=$(date +%F-%H%M%S)
SAFETY_ROOT=${OVERLEAF_RESTORE_SAFETY_DIR:-"$SCRIPT_DIR/restore-safety"}
SAFETY_DIR="$SAFETY_ROOT/$RESTORE_TIMESTAMP"

usage() {
  cat >&2 <<'EOF'
Usage:
  ./deploy/restore-overleaf.sh ENV_FILE BACKUP_DIR --yes

Example:
  ./deploy/restore-overleaf.sh ./deploy/overleaf.lumia.env ./deploy/backups/2026-04-01-150517 --yes

Notes:
  - This script stops the Overleaf stack during restore.
  - Existing data directories are moved into deploy/restore-safety/<timestamp>/ before restore.
  - The backup directory must contain at least:
      mongo-*.archive.gz
      overleaf-data.tar.gz
    redis-dump.rdb.gz is optional.
EOF
}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  usage
  exit 1
fi

if [[ -z "$BACKUP_DIR" || "$CONFIRM" != "--yes" ]]; then
  usage
  exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Missing backup directory: $BACKUP_DIR" >&2
  exit 1
fi

ENV_FILE=$(cd -- "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
BACKUP_DIR=$(cd -- "$BACKUP_DIR" && pwd)
mkdir -p "$SAFETY_ROOT"
SAFETY_ROOT=$(cd -- "$SAFETY_ROOT" && pwd)
SAFETY_DIR="$SAFETY_ROOT/$RESTORE_TIMESTAMP"

set -a
. "$ENV_FILE"
set +a

SHARELATEX_CONTAINER=${OVERLEAF_CONTAINER_NAME:-lumia-overleaf}
MONGO_CONTAINER=${OVERLEAF_MONGO_CONTAINER_NAME:-lumia-overleaf-mongo}
REDIS_CONTAINER=${OVERLEAF_REDIS_CONTAINER_NAME:-lumia-overleaf-redis}
MONGO_DB=${OVERLEAF_MONGO_DB:-sharelatex}

MONGO_ARCHIVE=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mongo-*.archive.gz' | head -n 1)
OVERLEAF_ARCHIVE="$BACKUP_DIR/overleaf-data.tar.gz"
REDIS_ARCHIVE="$BACKUP_DIR/redis-dump.rdb.gz"

if [[ -z "$MONGO_ARCHIVE" ]]; then
  echo "Missing Mongo archive in $BACKUP_DIR" >&2
  exit 1
fi
if [[ ! -f "$OVERLEAF_ARCHIVE" ]]; then
  echo "Missing overleaf-data.tar.gz in $BACKUP_DIR" >&2
  exit 1
fi

if [[ -f "$BACKUP_DIR/manifest.txt" ]]; then
  manifest_mongo_db=$(awk -F= '$1=="mongo_db"{print $2}' "$BACKUP_DIR/manifest.txt" || true)
  if [[ -n "${manifest_mongo_db:-}" ]]; then
    MONGO_DB="$manifest_mongo_db"
  fi
fi

verify_checksums() {
  if [[ -f "$BACKUP_DIR/SHA256SUMS" ]]; then
    echo "Verifying backup checksums"
    (
      cd "$BACKUP_DIR"
      sha256sum -c SHA256SUMS
    )
  fi
}

move_if_exists() {
  local source="$1"
  local target="$2"
  if [[ -e "$source" ]]; then
    mkdir -p "$(dirname "$target")"
    mv "$source" "$target"
  fi
}

prepare_fresh_data_dirs() {
  mkdir -p \
    "$SCRIPT_DIR/data/mongo" \
    "$SCRIPT_DIR/data/redis" \
    "$SCRIPT_DIR/data"
}

restore_overleaf_data() {
  echo "Restoring Overleaf filesystem data from $OVERLEAF_ARCHIVE"
  tar xzf "$OVERLEAF_ARCHIVE" -C "$SCRIPT_DIR/data"
}

restore_redis_data() {
  mkdir -p "$SCRIPT_DIR/data/redis"
  if [[ -f "$REDIS_ARCHIVE" ]]; then
    echo "Restoring Redis snapshot from $REDIS_ARCHIVE"
    gzip -dc "$REDIS_ARCHIVE" >"$SCRIPT_DIR/data/redis/dump.rdb"
  fi
}

wait_for_mongo() {
  local waited=0
  while (( waited < 120 )); do
    if [[ "$(docker inspect -f '{{.State.Health.Status}}' "$MONGO_CONTAINER" 2>/dev/null || true)" == "healthy" ]]; then
      return 0
    fi
    sleep 2
    (( waited += 2 ))
  done
  echo "Timed out waiting for $MONGO_CONTAINER to become healthy" >&2
  return 1
}

restore_mongo() {
  echo "Starting MongoDB container for restore"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d mongo
  wait_for_mongo
  echo "Restoring MongoDB database '$MONGO_DB' from $MONGO_ARCHIVE"
  docker exec -i "$MONGO_CONTAINER" mongorestore --drop --gzip --archive <"$MONGO_ARCHIVE"
}

start_stack() {
  echo "Starting full Overleaf stack"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
}

verify_checksums

echo "Stopping Overleaf stack"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down

echo "Moving current data into $SAFETY_DIR"
move_if_exists "$SCRIPT_DIR/data/mongo" "$SAFETY_DIR/mongo"
move_if_exists "$SCRIPT_DIR/data/redis" "$SAFETY_DIR/redis"
move_if_exists "$SCRIPT_DIR/data/overleaf" "$SAFETY_DIR/overleaf"

prepare_fresh_data_dirs
restore_overleaf_data
restore_redis_data
restore_mongo
start_stack

cat <<EOF
Restore completed.

Backup restored from:
  $BACKUP_DIR

Previous data moved to:
  $SAFETY_DIR
EOF
