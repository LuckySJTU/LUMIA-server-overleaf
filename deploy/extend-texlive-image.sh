#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE=${1:-"$SCRIPT_DIR/overleaf.lumia.env"}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Usage: $0 <env-file> <tlmgr-package> [<tlmgr-package> ...]" >&2
  exit 1
fi

shift || true

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <env-file> <tlmgr-package> [<tlmgr-package> ...]" >&2
  exit 1
fi

ENV_FILE=$(cd -- "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")

set -a
. "$ENV_FILE"
set +a

SOURCE_IMAGE=${OVERLEAF_IMAGE:-lumia-overleaf:latest}
if [[ "$SOURCE_IMAGE" == *:* ]]; then
  TARGET_IMAGE_DEFAULT="${SOURCE_IMAGE%:*}:texlive-patched"
else
  TARGET_IMAGE_DEFAULT="${SOURCE_IMAGE}:texlive-patched"
fi
TARGET_IMAGE=${OVERLEAF_PATCHED_IMAGE:-$TARGET_IMAGE_DEFAULT}

normalize_package() {
  case "$1" in
    array|tabularx|xspace|afterpage|multicol)
      echo "tools"
      ;;
    CJKutf8|cjk)
      echo "cjk"
      ;;
    tikz)
      echo "pgf"
      ;;
    subcaption)
      echo "caption"
      ;;
    pifont)
      echo "psnfss"
      ;;
    nicefrac)
      echo "units"
      ;;
    stfloats)
      echo "sttools"
      ;;
    balance)
      echo "preprint"
      ;;
    bibentry)
      echo "natbib"
      ;;
    XCharter|xcharter)
      echo "xcharter"
      ;;
    newtxmath|newtxtext|newtx)
      echo "newtx"
      ;;
    extarticle|extreport|extbook|extletter|extproc|extsizes)
      echo "extsizes"
      ;;
    *)
      echo "$1"
      ;;
  esac
}

RESOLVED_PACKAGES=()
SEEN_PACKAGES=""
for package in "$@"; do
  resolved=$(normalize_package "$package")
  case " $SEEN_PACKAGES " in
    *" $resolved "*)
      ;;
    *)
      RESOLVED_PACKAGES+=("$resolved")
      SEEN_PACKAGES="$SEEN_PACKAGES $resolved"
      ;;
  esac

  if [[ "$resolved" == "xifthen" ]]; then
    case " $SEEN_PACKAGES " in
      *" ifmtarg "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("ifmtarg")
        SEEN_PACKAGES="$SEEN_PACKAGES ifmtarg"
        ;;
    esac
  fi

  if [[ "$resolved" == "datetime" ]]; then
    case " $SEEN_PACKAGES " in
      *" fmtcount "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("fmtcount")
        SEEN_PACKAGES="$SEEN_PACKAGES fmtcount"
        ;;
    esac
  fi

  if [[ "$resolved" == "xcharter" ]]; then
    case " $SEEN_PACKAGES " in
      *" fontaxes "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("fontaxes")
        SEEN_PACKAGES="$SEEN_PACKAGES fontaxes"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" mweights "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("mweights")
        SEEN_PACKAGES="$SEEN_PACKAGES mweights"
        ;;
    esac
  fi

  if [[ "$resolved" == "forest" ]]; then
    case " $SEEN_PACKAGES " in
      *" elocalloc "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("elocalloc")
        SEEN_PACKAGES="$SEEN_PACKAGES elocalloc"
        ;;
    esac
  fi

  if [[ "$resolved" == "changes" ]]; then
    case " $SEEN_PACKAGES " in
      *" xstring "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("xstring")
        SEEN_PACKAGES="$SEEN_PACKAGES xstring"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" truncate "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("truncate")
        SEEN_PACKAGES="$SEEN_PACKAGES truncate"
        ;;
    esac
  fi

  if [[ "$resolved" == "mdframed" ]]; then
    case " $SEEN_PACKAGES " in
      *" zref "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("zref")
        SEEN_PACKAGES="$SEEN_PACKAGES zref"
        ;;
    esac
  fi

  if [[ "$resolved" == "bclogo" ]]; then
    case " $SEEN_PACKAGES " in
      *" mdframed "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("mdframed")
        SEEN_PACKAGES="$SEEN_PACKAGES mdframed"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" zref "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("zref")
        SEEN_PACKAGES="$SEEN_PACKAGES zref"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" pgf "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("pgf")
        SEEN_PACKAGES="$SEEN_PACKAGES pgf"
        ;;
    esac
  fi

  if [[ "$resolved" == "epigraph" ]]; then
    case " $SEEN_PACKAGES " in
      *" nextpage "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("nextpage")
        SEEN_PACKAGES="$SEEN_PACKAGES nextpage"
        ;;
    esac
  fi

  if [[ "$resolved" == "textgreek" ]]; then
    case " $SEEN_PACKAGES " in
      *" greek-fontenc "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("greek-fontenc")
        SEEN_PACKAGES="$SEEN_PACKAGES greek-fontenc"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" cbfonts "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("cbfonts")
        SEEN_PACKAGES="$SEEN_PACKAGES cbfonts"
        ;;
    esac

    case " $SEEN_PACKAGES " in
      *" cbfonts-fd "*)
        ;;
      *)
        RESOLVED_PACKAGES+=("cbfonts-fd")
        SEEN_PACKAGES="$SEEN_PACKAGES cbfonts-fd"
        ;;
    esac
  fi
done

PACKAGES="${RESOLVED_PACKAGES[*]}"

TMP_DIR=$(mktemp -d)
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$TMP_DIR/Dockerfile" <<'EOF'
ARG SOURCE_IMAGE=lumia-overleaf:latest
FROM ${SOURCE_IMAGE}

ARG TEXLIVE_PACKAGES

RUN tlmgr install ${TEXLIVE_PACKAGES} \
 && tlmgr path add \
 && mktexlsr
EOF

docker build \
  --file "$TMP_DIR/Dockerfile" \
  --tag "$TARGET_IMAGE" \
  --build-arg "SOURCE_IMAGE=$SOURCE_IMAGE" \
  --build-arg "TEXLIVE_PACKAGES=$PACKAGES" \
  "$TMP_DIR"

cat <<EOF
Built patched image: $TARGET_IMAGE
Source image: $SOURCE_IMAGE

To deploy it:
  sed -i 's#^OVERLEAF_IMAGE=.*#OVERLEAF_IMAGE=$TARGET_IMAGE#' "$ENV_FILE"
  docker compose --env-file "$ENV_FILE" -f "$SCRIPT_DIR/docker-compose.lumia.yml" up -d
EOF
