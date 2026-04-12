#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/overleaf.lumia.env"}
BACKUP_ROOT=${2:-"${OVERLEAF_BACKUP_DIR:-$SCRIPT_DIR/backups}"}
TIMESTAMP=$(date +%F-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"
MONGO_DB=${OVERLEAF_MONGO_DB:-sharelatex}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Copy deploy/overleaf.lumia.env.example to deploy/overleaf.lumia.env and fill in the secrets first." >&2
  exit 1
fi

ENV_FILE=$(cd -- "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
BACKUP_ROOT=$(mkdir -p "$BACKUP_ROOT" && cd -- "$BACKUP_ROOT" && pwd)
BACKUP_DIR="$BACKUP_ROOT/$TIMESTAMP"

set -a
. "$ENV_FILE"
set +a

SHARELATEX_CONTAINER=${OVERLEAF_CONTAINER_NAME:-lumia-overleaf}
MONGO_CONTAINER=${OVERLEAF_MONGO_CONTAINER_NAME:-lumia-overleaf-mongo}
REDIS_CONTAINER=${OVERLEAF_REDIS_CONTAINER_NAME:-lumia-overleaf-redis}

for container in "$SHARELATEX_CONTAINER" "$MONGO_CONTAINER" "$REDIS_CONTAINER"; do
  if ! docker inspect "$container" >/dev/null 2>&1; then
    echo "Missing container: $container" >&2
    exit 1
  fi
done

mkdir -p "$BACKUP_DIR"

backup_mongo() {
  local output="$BACKUP_DIR/mongo-${MONGO_DB}.archive.gz"
  echo "Backing up MongoDB database '$MONGO_DB' from $MONGO_CONTAINER"
  docker exec "$MONGO_CONTAINER" \
    mongodump --db "$MONGO_DB" --archive --gzip >"$output"
}

backup_overleaf_data() {
  local source_dir="$SCRIPT_DIR/data/overleaf"
  local output="$BACKUP_DIR/overleaf-data.tar.gz"
  if [[ ! -d "$source_dir" ]]; then
    echo "Missing Overleaf data directory: $source_dir" >&2
    exit 1
  fi
  echo "Backing up $source_dir"
  tar czf "$output" -C "$SCRIPT_DIR/data" overleaf
}

backup_redis() {
  local output="$BACKUP_DIR/redis-dump.rdb"
  local redis_tmp_file="/tmp/overleaf-redis-backup.rdb"
  local redis_cmd=(redis-cli)

  if [[ -n "${OVERLEAF_REDIS_PASS:-}" ]]; then
    redis_cmd+=(-a "$OVERLEAF_REDIS_PASS")
  fi
  if [[ "${OVERLEAF_REDIS_TLS:-false}" == "true" ]]; then
    redis_cmd+=(--tls)
  fi
  redis_cmd+=(--rdb "$redis_tmp_file")

  echo "Streaming Redis snapshot from $REDIS_CONTAINER"
  docker exec "$REDIS_CONTAINER" rm -f "$redis_tmp_file"
  docker exec "$REDIS_CONTAINER" "${redis_cmd[@]}" >/dev/null
  docker cp "$REDIS_CONTAINER:$redis_tmp_file" "$output"
  docker exec "$REDIS_CONTAINER" rm -f "$redis_tmp_file"
  gzip -f "$output"
}

write_manifest() {
  {
    echo "timestamp=$TIMESTAMP"
    echo "env_file=$ENV_FILE"
    echo "sharelatex_container=$SHARELATEX_CONTAINER"
    echo "mongo_container=$MONGO_CONTAINER"
    echo "redis_container=$REDIS_CONTAINER"
    echo "mongo_db=$MONGO_DB"
  } >"$BACKUP_DIR/manifest.txt"
}

write_checksums() {
  (
    cd "$BACKUP_DIR"
    sha256sum ./* >SHA256SUMS
  )
}

backup_mongo
backup_overleaf_data
backup_redis
write_manifest
write_checksums

echo "Backup completed: $BACKUP_DIR"
