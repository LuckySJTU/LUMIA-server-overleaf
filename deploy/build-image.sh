#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/overleaf.lumia.env"}
BASE_IMAGE=${OVERLEAF_BASE_TAG:-lumia-overleaf-base:latest}
APP_IMAGE=${OVERLEAF_IMAGE:-lumia-overleaf:latest}
FORCE_BASE_REBUILD=${OVERLEAF_FORCE_BASE_REBUILD:-false}
PHUSION_BASEIMAGE_TAG=${OVERLEAF_PHUSION_BASEIMAGE_TAG:-phusion/baseimage:noble-1.0.2}
TEXLIVE_SCHEME=${OVERLEAF_TEXLIVE_SCHEME:-scheme-medium}
TEXLIVE_EXTRA_PACKAGES="${OVERLEAF_TEXLIVE_EXTRA_PACKAGES:-collection-langcjk microtype tools caption booktabs multirow cleveref mathtools todonotes xcolor hyperref enumitem algorithms algorithmicx natbib url xurl units wrapfig float sttools adjustbox threeparttable tablefootnote soul ulem listings pgf pgfplots siunitx makecell preprint forloop xifthen ifmtarg cmap psnfss textcase changepage datetime fmtcount fancyhdr lastpage titlesec needspace kvoptions tcolorbox fontawesome5 xcharter fontaxes mweights newtx zlmtt extsizes geometry colortbl forest elocalloc changes xstring truncate bclogo mdframed zref lipsum tocloft bbding epigraph nextpage minitoc textgreek cjk greek-fontenc cbfonts cbfonts-fd}"

if [[ -f "$ENV_FILE" ]]; then
  ENV_FILE=$(cd -- "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
  set -a
  . "$ENV_FILE"
  set +a
fi

cd "$ROOT_DIR"

BASE_IMAGE=${OVERLEAF_BASE_TAG:-$BASE_IMAGE}
APP_IMAGE=${OVERLEAF_IMAGE:-$APP_IMAGE}
FORCE_BASE_REBUILD=${OVERLEAF_FORCE_BASE_REBUILD:-$FORCE_BASE_REBUILD}
PHUSION_BASEIMAGE_TAG=${OVERLEAF_PHUSION_BASEIMAGE_TAG:-$PHUSION_BASEIMAGE_TAG}
TEXLIVE_SCHEME=${OVERLEAF_TEXLIVE_SCHEME:-$TEXLIVE_SCHEME}
TEXLIVE_EXTRA_PACKAGES="${OVERLEAF_TEXLIVE_EXTRA_PACKAGES:-$TEXLIVE_EXTRA_PACKAGES}"

if [[ "$BASE_IMAGE" == "sharelatex/sharelatex-base:latest" ]]; then
  BASE_IMAGE="lumia-overleaf-base:latest"
fi

if [[ "$FORCE_BASE_REBUILD" == "true" ]] || ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  docker build \
    --file "$ROOT_DIR/server-ce/Dockerfile-base" \
    --tag "$BASE_IMAGE" \
    --build-arg "PHUSION_BASEIMAGE_TAG=$PHUSION_BASEIMAGE_TAG" \
    --build-arg "TEXLIVE_SCHEME=$TEXLIVE_SCHEME" \
    --build-arg "TEXLIVE_EXTRA_PACKAGES=$TEXLIVE_EXTRA_PACKAGES" \
    "$ROOT_DIR/server-ce"
fi

docker build \
  --file "$ROOT_DIR/server-ce/Dockerfile" \
  --tag "$APP_IMAGE" \
  --build-arg "OVERLEAF_BASE_TAG=$BASE_IMAGE" \
  "$ROOT_DIR"
