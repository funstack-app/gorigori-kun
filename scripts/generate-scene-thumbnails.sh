#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPTS_FILE="$SCRIPT_DIR/scene-thumbnails-prompts.json"
OUT_ROOT="$PROJECT_DIR/public/scene-thumbnails"
PARALLEL=4

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-scene-thumbnails.sh --all [--dry-run]
  scripts/generate-scene-thumbnails.sh --category <name> [--dry-run]

Options:
  --all              Generate every configured scene thumbnail.
  --category <name>  Generate one category only.
  --dry-run          Print target paths and prompts without calling codex.
  -h, --help         Show this help.

Categories:
  composition, aspect_ratio, light_source, camera_equipment, focal_length,
  lens, film, photographer, cinematic_look, filter
USAGE
}

MODE=""
CATEGORY=""
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --all)
      MODE="all"
      shift
      ;;
    --category)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --category requires a name" >&2
        exit 2
      fi
      MODE="category"
      CATEGORY="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$MODE" ]; then
  echo "ERROR: pass --all or --category <name>" >&2
  usage >&2
  exit 2
fi

if [ ! -f "$PROMPTS_FILE" ]; then
  echo "ERROR: prompts file not found: $PROMPTS_FILE" >&2
  exit 1
fi

RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/scene-thumbnails.XXXXXX")"
ITEMS_FILE="$RUN_DIR/items.tsv"
FAIL_LOG="$RUN_DIR/failures.log"
SUCCESS_LOG="$RUN_DIR/success.log"
: > "$FAIL_LOG"
: > "$SUCCESS_LOG"

cleanup() {
  if [ "${KEEP_RUN_DIR:-0}" != "1" ]; then
    rm -rf "$RUN_DIR"
  fi
}
trap cleanup EXIT

python3 - "$PROMPTS_FILE" "$MODE" "$CATEGORY" > "$ITEMS_FILE" <<'PY'
import json
import os
import re
import sys

prompts_path, mode, category_filter = sys.argv[1:4]

# slug は scene-thumbnails-slugs.json から引く (2026-07-25)。
# 以前はこのスクリプト内に手書きの slug_map があり、prompts.json を更新しても
# slug を足し忘れると fallback_slug に落ちて意図しないファイル名になっていた。
# さらに実在ブランド名 (Sony FX6 / ARRI / iPhone Pro / 写真家名) が残っており、
# 商標・人名をプロンプトに含めない方針と矛盾していた。
# 定義を1箇所 (slugs.json) に寄せ、prompts.json と同時に生成する。
slug_path = os.path.join(os.path.dirname(prompts_path), "scene-thumbnails-slugs.json")
slug_table = {}
if os.path.exists(slug_path):
    with open(slug_path, "r", encoding="utf-8") as fh:
        slug_table = json.load(fh)


with open(prompts_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

if mode == "category":
    if category_filter not in data:
        print(f"ERROR: unknown category: {category_filter}", file=sys.stderr)
        print("Available: " + ", ".join(data.keys()), file=sys.stderr)
        sys.exit(2)
    categories = [category_filter]
else:
    categories = list(data.keys())

def fallback_slug(label: str) -> str:
    slug = label.lower()
    slug = slug.replace("'", "")
    slug = re.sub(r"[^a-z0-9]+", "-", slug).strip("-")
    return slug

for category in categories:
    options = data[category]
    for label, prompt in options.items():
        slug = (slug_table.get(category) or {}).get(label) or fallback_slug(label)
        if not slug:
            print(f"ERROR: no ASCII slug for {category}/{label}", file=sys.stderr)
            sys.exit(2)
        if "\t" in prompt or "\t" in label:
            print(f"ERROR: tabs are not allowed in prompts: {category}/{label}", file=sys.stderr)
            sys.exit(2)
        print(f"{category}\t{slug}\t{label}\t{prompt}")
PY

if [ "$?" -ne 0 ]; then
  exit 2
fi

TOTAL="$(wc -l < "$ITEMS_FILE" | tr -d ' ')"
if [ "$TOTAL" = "0" ]; then
  echo "ERROR: no thumbnails matched" >&2
  exit 1
fi

echo "Scene thumbnail jobs: $TOTAL"
echo "Output root: $OUT_ROOT"
echo "Parallel workers: $PARALLEL"

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: no images will be generated."
  while IFS="$(printf '\t')" read -r category slug label prompt; do
    printf '\n[%s] %s -> public/scene-thumbnails/%s/%s.png\n' "$category" "$label" "$category" "$slug"
    printf '%s\n' "$prompt"
  done < "$ITEMS_FILE"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "ERROR: codex command not found in PATH" >&2
  exit 1
fi

mkdir -p "$OUT_ROOT"

make_worker_home() {
  worker_home="$1"
  source_home="${CODEX_HOME:-$HOME/.codex}"
  mkdir -p "$worker_home/generated_images"
  if [ -d "$source_home" ]; then
    for entry in "$source_home"/* "$source_home"/.[!.]* "$source_home"/..?*; do
      [ -e "$entry" ] || continue
      name="$(basename "$entry")"
      [ "$name" = "generated_images" ] && continue
      ln -s "$entry" "$worker_home/$name" 2>/dev/null || true
    done
  fi
}

latest_png() {
  python3 - "$1" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
if not root.exists():
    sys.exit(0)

pngs = [p for p in root.rglob("*.png") if p.is_file()]
ig_pngs = [p for p in pngs if p.name.startswith("ig_")]
pool = ig_pngs or pngs
if not pool:
    sys.exit(0)
newest = max(pool, key=lambda p: p.stat().st_mtime_ns)
print(newest)
PY
}

run_one() {
  category="$1"
  slug="$2"
  label="$3"
  prompt="$4"

  target_dir="$OUT_ROOT/$category"
  target_path="$target_dir/$slug.png"
  worker_root="$(mktemp -d "${TMPDIR:-/tmp}/scene-thumb-worker.XXXXXX")"
  worker_home="$worker_root/codex-home"
  stdout_log="$worker_root/stdout.log"
  stderr_log="$worker_root/stderr.log"

  mkdir -p "$target_dir"
  make_worker_home "$worker_home"

  instruction="$(cat <<EOF
Use the image_gen tool exactly once to create one PNG thumbnail.

Image generation requirements:
- Model/tool: GPT Image 2 through image_gen
- quality: medium
- aspect ratio: 16:9
- Style: cinematic, dramatic lighting, photorealistic
- No text, no logos, no watermark, no contact sheet, no collage
- Let image_gen write its normal PNG output under CODEX_HOME/generated_images

Thumbnail prompt:
$prompt

Final response must be one line only: OK or NG <reason>.
EOF
)"

  echo "START $category/$slug ($label)"
  if printf '%s\n' "$instruction" | CODEX_HOME="$worker_home" codex exec --skip-git-repo-check -C "$PROJECT_DIR" - > "$stdout_log" 2> "$stderr_log"; then
    src_path="$(latest_png "$worker_home/generated_images")"
    if [ -n "$src_path" ] && [ -f "$src_path" ]; then
      cp "$src_path" "$target_path"
      echo "$target_path" >> "$SUCCESS_LOG"
      echo "OK    $category/$slug -> $target_path"
      rm -rf "$worker_root"
      return 0
    fi
    echo "MISS  $category/$slug: codex finished but no PNG was found" | tee -a "$FAIL_LOG" >&2
  else
    last_error="$(tail -20 "$stderr_log" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g')"
    [ -n "$last_error" ] || last_error="codex exec failed without stderr"
    echo "FAIL  $category/$slug: $last_error" | tee -a "$FAIL_LOG" >&2
  fi

  KEEP_FAILED_WORKERS="${KEEP_FAILED_WORKERS:-0}"
  if [ "$KEEP_FAILED_WORKERS" = "1" ]; then
    echo "DEBUG $category/$slug worker logs kept at $worker_root" | tee -a "$FAIL_LOG" >&2
  else
    rm -rf "$worker_root"
  fi
  return 1
}

pids=""
active=0

wait_first() {
  first="${pids%% *}"
  rest="${pids#* }"
  if [ "$first" = "$pids" ]; then
    rest=""
  fi
  if ! wait "$first"; then
    :
  fi
  pids="$rest"
  active=$((active - 1))
}

while IFS="$(printf '\t')" read -r category slug label prompt; do
  run_one "$category" "$slug" "$label" "$prompt" &
  pid="$!"
  if [ -z "$pids" ]; then
    pids="$pid"
  else
    pids="$pids $pid"
  fi
  active=$((active + 1))
  if [ "$active" -ge "$PARALLEL" ]; then
    wait_first
  fi
done < "$ITEMS_FILE"

while [ "$active" -gt 0 ]; do
  wait_first
done

SUCCESS_COUNT="$(wc -l < "$SUCCESS_LOG" | tr -d ' ')"
FAIL_COUNT="$(wc -l < "$FAIL_LOG" | tr -d ' ')"

echo
echo "Summary"
echo "  total:   $TOTAL"
echo "  success: $SUCCESS_COUNT"
echo "  failed:  $FAIL_COUNT"

if [ "$FAIL_COUNT" != "0" ]; then
  KEEP_RUN_DIR=1
  echo "Failure log: $FAIL_LOG"
  exit 1
fi

exit 0
