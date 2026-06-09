#!/bin/bash
# リリース前自動チェック。
# .claude/rules/gori-gori-kun-release.md のチェック項目を機械的に検証する。

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
fail() {
  echo "❌ $1"
  FAIL=$((FAIL + 1))
}
ok() {
  echo "✅ $1"
}

echo "==> GORI GORI KUN リリース前チェック"

# 1. バージョン番号 3ファイル一致
CARGO_VER=$(grep -E "^version = " src-tauri/Cargo.toml | head -1 | sed -E 's/version = "([^"]+)".*/\1/')
TAURI_VER=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
PKG_VER=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")

if [ "$CARGO_VER" = "$TAURI_VER" ] && [ "$TAURI_VER" = "$PKG_VER" ]; then
  ok "バージョン一致: $CARGO_VER"
else
  fail "バージョン不一致: Cargo=$CARGO_VER, Tauri=$TAURI_VER, package.json=$PKG_VER"
  fail "  → scripts/bump-version.sh X.Y.Z で揃えること"
fi

# 2. TypeScript 型チェック
if npx tsc --noEmit 2>/dev/null; then
  ok "TypeScript 型エラーなし"
else
  fail "TypeScript 型エラーあり"
fi

# 3. Rust check
if (cd src-tauri && cargo check --quiet 2>&1 | grep -q "^error"); then
  fail "Rust エラーあり"
else
  ok "Rust エラーなし"
fi

# 4. release.yml に必要なjobが揃っているか
# Higgsfield 拡張パックは MCP 方式へ移行済み (拡張ジョブ廃止)。
# 配布は本体3ファイル (macos×2 + windows) + latest.json のみ。
RELEASE_YML=".github/workflows/release.yml"
REQUIRED_JOBS=("macos:" "windows:")
for job in "${REQUIRED_JOBS[@]}"; do
  if grep -q "^  $job" "$RELEASE_YML"; then
    ok "$job が release.yml に存在"
  else
    fail "$job が release.yml にない"
  fi
done

# 5. matrix で aarch64 + x64 両方ビルドする設定があるか
if grep -q "aarch64-apple-darwin" "$RELEASE_YML" && grep -q "x86_64-apple-darwin" "$RELEASE_YML"; then
  ok "Mac matrix (aarch64 + x86_64) 設定あり"
else
  fail "Mac matrix が aarch64 / x86_64 両方を含んでいない"
fi

# 6. git working tree clean (オプション、警告のみ)
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  未コミットの変更あり (git status で確認)"
fi

echo ""
if [ $FAIL -eq 0 ]; then
  echo "🎉 全チェック OK: リリース可能"
  exit 0
else
  echo "❌ $FAIL 件の問題: 修正してください"
  exit 1
fi
