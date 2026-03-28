#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/overleaf.lumia.env"}
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.lumia.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Copy deploy/overleaf.lumia.env.example to deploy/overleaf.lumia.env and fill in the secrets first." >&2
  exit 1
fi

ENV_FILE=$(cd -- "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")

mkdir -p \
  "$SCRIPT_DIR/data/overleaf" \
  "$SCRIPT_DIR/data/mongo" \
  "$SCRIPT_DIR/data/redis"

export OVERLEAF_ENV_FILE="$ENV_FILE"

"$SCRIPT_DIR/build-image.sh" "$ENV_FILE"

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d
