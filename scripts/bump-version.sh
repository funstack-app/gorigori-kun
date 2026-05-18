#!/bin/bash
# バージョン番号を3ヶ所同時に更新する。
#
# 使い方:
#   ./scripts/bump-version.sh 0.7.0

set -e

NEW_VERSION="${1}"

if [ -z "$NEW_VERSION" ]; then
  echo "Usage: $0 <new-version>"
  echo "  Example: $0 0.7.0"
  exit 1
fi

# semver チェック (X.Y.Z 形式)
if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: バージョンは X.Y.Z 形式 (例: 0.7.0)"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> バージョンを $NEW_VERSION に更新"

# 1. src-tauri/Cargo.toml
sed -i.bak -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW_VERSION\"/" "$ROOT/src-tauri/Cargo.toml"
rm -f "$ROOT/src-tauri/Cargo.toml.bak"
echo "  ✓ src-tauri/Cargo.toml"

# 2. src-tauri/tauri.conf.json
python3 <<PYEOF
import json
path = "$ROOT/src-tauri/tauri.conf.json"
with open(path) as f:
    conf = json.load(f)
conf["version"] = "$NEW_VERSION"
with open(path, "w") as f:
    json.dump(conf, f, indent=2, ensure_ascii=False)
PYEOF
echo "  ✓ src-tauri/tauri.conf.json"

# 3. package.json
python3 <<PYEOF
import json
path = "$ROOT/package.json"
with open(path) as f:
    pkg = json.load(f)
pkg["version"] = "$NEW_VERSION"
with open(path, "w") as f:
    json.dump(pkg, f, indent=2, ensure_ascii=False)
PYEOF
echo "  ✓ package.json"

echo ""
echo "✅ 3ファイル全部 $NEW_VERSION に更新完了"
echo ""
echo "次のステップ:"
echo "  git add -A"
echo "  git commit -m 'release: v$NEW_VERSION'"
echo "  git tag v$NEW_VERSION"
echo "  git push origin main && git push origin v$NEW_VERSION"
