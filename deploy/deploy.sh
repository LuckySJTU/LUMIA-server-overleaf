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

set -a
. "$ENV_FILE"
set +a

CONFIGURED_OVERLEAF_IMAGE=${OVERLEAF_IMAGE:-lumia-overleaf:latest}
TEXLIVE_EXTRA_PACKAGES="${OVERLEAF_TEXLIVE_EXTRA_PACKAGES:-}"
APP_BUILD_IMAGE=${OVERLEAF_APP_BUILD_IMAGE:-}
FINAL_OVERLEAF_IMAGE=$CONFIGURED_OVERLEAF_IMAGE

mkdir -p \
  "$SCRIPT_DIR/data/overleaf" \
  "$SCRIPT_DIR/data/mongo" \
  "$SCRIPT_DIR/data/redis"

export OVERLEAF_ENV_FILE="$ENV_FILE"

if [[ -n "${TEXLIVE_EXTRA_PACKAGES//[[:space:]]/}" ]]; then
  if [[ -z "$APP_BUILD_IMAGE" ]]; then
    if [[ "$CONFIGURED_OVERLEAF_IMAGE" == *":texlive-patched" ]]; then
      APP_BUILD_IMAGE="${CONFIGURED_OVERLEAF_IMAGE%:*}:latest"
    else
      APP_BUILD_IMAGE="$CONFIGURED_OVERLEAF_IMAGE"
    fi
  fi

  if [[ -n "${OVERLEAF_PATCHED_IMAGE:-}" ]]; then
    FINAL_OVERLEAF_IMAGE=$OVERLEAF_PATCHED_IMAGE
  elif [[ "$CONFIGURED_OVERLEAF_IMAGE" == *":texlive-patched" ]]; then
    FINAL_OVERLEAF_IMAGE=$CONFIGURED_OVERLEAF_IMAGE
  elif [[ "$CONFIGURED_OVERLEAF_IMAGE" == *:* ]]; then
    FINAL_OVERLEAF_IMAGE="${CONFIGURED_OVERLEAF_IMAGE%:*}:texlive-patched"
  else
    FINAL_OVERLEAF_IMAGE="${CONFIGURED_OVERLEAF_IMAGE}:texlive-patched"
  fi

  OVERLEAF_APP_BUILD_IMAGE="$APP_BUILD_IMAGE" \
    "$SCRIPT_DIR/build-image.sh" "$ENV_FILE"

  TEXLIVE_PACKAGE_ARGS=()
  read -r -a TEXLIVE_PACKAGE_ARGS <<< "$TEXLIVE_EXTRA_PACKAGES"
  OVERLEAF_SOURCE_IMAGE="$APP_BUILD_IMAGE" \
    OVERLEAF_PATCHED_IMAGE="$FINAL_OVERLEAF_IMAGE" \
    "$SCRIPT_DIR/extend-texlive-image.sh" "$ENV_FILE" "${TEXLIVE_PACKAGE_ARGS[@]}"
else
  "$SCRIPT_DIR/build-image.sh" "$ENV_FILE"
fi

OVERLEAF_IMAGE="$FINAL_OVERLEAF_IMAGE" docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d
