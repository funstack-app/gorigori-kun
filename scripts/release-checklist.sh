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

# 5. macOS の matrix に載っている target を実体から読む
#
# 以前は `grep -q "x86_64-apple-darwin"` で判定していたが、これはファイル内の
# **コメント文にもヒットする**。2026-07-25 に Intel Mac を matrix から外し、
# その理由をコメントで残したところ、matrix には無いのにチェックは ✅ を出した。
# 「検査が実態でなく文字列の存在を見ている」典型で、通ったのに実態が違う状態は
# 検査が無いより危ない。matrix ブロックを構造として読む方式へ変更する。
MAC_TARGETS="$(python3 - "$RELEASE_YML" <<'PY'
import sys, yaml
# 正規表現でなく YAML として読む。文字列マッチだと本文とコメントを区別できず、
# 貪欲マッチで後続の `- name:` まで拾ってしまう (実際に両方踏んだ)。
try:
    doc = yaml.safe_load(open(sys.argv[1]))
    targets = doc["jobs"]["macos"]["strategy"]["matrix"]["target"]
except Exception:
    sys.exit(1)
if not isinstance(targets, list) or not targets:
    sys.exit(1)
for t in targets:
    print(str(t).strip())
PY
)" || MAC_TARGETS=""

if [ -z "$MAC_TARGETS" ]; then
  fail "macOS の matrix.target を読み取れない (release.yml の構造が変わった?)"
else
  # Apple Silicon は必須。これが無いと STΛCK 自身の機械向けが作られない。
  if printf '%s\n' "$MAC_TARGETS" | grep -qx "aarch64-apple-darwin"; then
    ok "Mac matrix: $(printf '%s' "$MAC_TARGETS" | tr '\n' ' ')"
  else
    fail "Mac matrix に aarch64-apple-darwin (Apple Silicon) が無い"
  fi
  # Intel は 2026-07-25 に ort の prebuilt 配布終了で外したが、2026-07-28 に復活した。
  # ort を Windows 専用依存へ格下げし (src-tauri/Cargo.toml の
  # [target.'cfg(target_os = "windows")'.dependencies])、Mac が ort 無しで
  # ビルドできるようになったため。以後は必須扱いにする — 落ちたことに気づかず
  # 「Intel 対応」と書いた README のまま配布するのを防ぐ。
  if printf '%s\n' "$MAC_TARGETS" | grep -qx "x86_64-apple-darwin"; then
    ok "Mac matrix に x86_64-apple-darwin (Intel) がある"
  else
    fail "Mac matrix に x86_64-apple-darwin (Intel) が無い — README は対応表記のはず"
  fi
fi

# 6. 既定モデル × 同梱 codex CLI の整合 (2026-07-26 実害を受けて追加)
#
# なぜ: 2026-07-17 にモデルを 5.6 世代へ更新した際、同梱 CLI の更新を忘れ、
# 「既定モデルが 400 で必ず失敗する」状態を v2.0.0 / v2.1.0 として出荷した。
# dev では PATH の新しい CLI を拾うため再現せず、発覚はユーザー報告まで9日。
# 整合を取るべき値が別ファイルにあるので、人の注意ではなくコードで検査する。
if [ -f "$ROOT/scripts/check-model-cli-match.py" ]; then
  if python3 "$ROOT/scripts/check-model-cli-match.py" > /tmp/model-cli-check.txt 2>&1; then
    ok "既定モデルと同梱 codex CLI の整合"
  else
    fail "既定モデルと同梱 codex CLI が不整合"
    sed 's/^/     /' /tmp/model-cli-check.txt
  fi
else
  fail "scripts/check-model-cli-match.py が見つからない (検査が消えている)"
fi

# 7. git working tree clean (オプション、警告のみ)
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
