#!/bin/bash
# Higgsfield 拡張パック ビルドスクリプト (Mac aarch64 / Mac x64)
#
# 出力:
#   dist/GORI-HiggsField-Extension_mac-aarch64.dmg
#   dist/GORI-HiggsField-Extension_mac-x64.dmg
#
# 各 dmg を /Applications にD&Dすると、その中の post-install スクリプトが
# ~/Library/Application Support/app.codexframefactory/extensions/higgsfield/
# 配下に node / higgsfield CLI を展開する。
#
# 使い方:
#   ./scripts/build-higgsfield-extension.sh aarch64    (Apple Silicon)
#   ./scripts/build-higgsfield-extension.sh x64        (Intel Mac)

set -e

ARCH="${1:-aarch64}"
if [ "$ARCH" != "aarch64" ] && [ "$ARCH" != "x64" ]; then
  echo "Usage: $0 [aarch64|x64]"
  exit 1
fi

# Node.js のアーキ名は arm64 / x64 (注: aarch64 ではなく arm64)
if [ "$ARCH" = "aarch64" ]; then
  NODE_ARCH="arm64"
else
  NODE_ARCH="x64"
fi

NODE_VERSION="v20.18.0"
NODE_TAR="node-${NODE_VERSION}-darwin-${NODE_ARCH}.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_TAR}"

HF_PKG_NAME="@higgsfield/cli"

WORK_DIR="$(pwd)/_work/higgsfield-extension-${ARCH}"
DIST_DIR="$(pwd)/dist"
PAYLOAD_DIR="${WORK_DIR}/payload"
EXT_DIR="${PAYLOAD_DIR}/higgsfield"

echo "==> クリーンビルド準備"
rm -rf "${WORK_DIR}"
mkdir -p "${EXT_DIR}/bin" "${EXT_DIR}/lib/node_modules" "${DIST_DIR}"

# ───── 1. Node.js ポータブル版を取得 ─────
echo "==> Node.js ${NODE_VERSION} (${NODE_ARCH}) をダウンロード"
curl -L -o "${WORK_DIR}/${NODE_TAR}" "${NODE_URL}"
tar -xzf "${WORK_DIR}/${NODE_TAR}" -C "${WORK_DIR}"
NODE_UNPACK="${WORK_DIR}/node-${NODE_VERSION}-darwin-${NODE_ARCH}"
cp "${NODE_UNPACK}/bin/node" "${EXT_DIR}/bin/node"
chmod +x "${EXT_DIR}/bin/node"

# npm も同梱 (CLI install のため)
cp -R "${NODE_UNPACK}/lib/node_modules/npm" "${EXT_DIR}/lib/node_modules/"
# npm の bin (CLI実体) は node_modules/npm/bin/npm-cli.js
# 簡易ラッパー作成
cat > "${EXT_DIR}/bin/npm" <<'EOF'
#!/bin/bash
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_ROOT="$(cd "${SELF_DIR}/.." && pwd)"
exec "${EXT_ROOT}/bin/node" "${EXT_ROOT}/lib/node_modules/npm/bin/npm-cli.js" "$@"
EOF
chmod +x "${EXT_DIR}/bin/npm"

# ───── 2. higgsfield CLI を npm install で取得 ─────
echo "==> Higgsfield CLI を npm install"
export PATH="${EXT_DIR}/bin:${PATH}"
cd "${EXT_DIR}"
# prefix 指定で node_modules 配下に展開
"${EXT_DIR}/bin/npm" install --prefix "${EXT_DIR}" "${HF_PKG_NAME}" --no-save --no-audit --no-fund --quiet

# higgsfield 実行ラッパー作成 (内部の node を呼ぶ)
HF_JS=$(find "${EXT_DIR}/node_modules/@higgsfield/cli" -name "*.js" -type f | grep -E "(bin/|dist/cli)" | head -1)
if [ -z "$HF_JS" ]; then
  # フォールバック: package.json の bin を見る
  HF_JS=$(node -e "
    const pkg = require('${EXT_DIR}/node_modules/@higgsfield/cli/package.json');
    const bin = pkg.bin;
    if (typeof bin === 'string') console.log(bin);
    else if (typeof bin === 'object') console.log(Object.values(bin)[0]);
  ")
  HF_JS="${EXT_DIR}/node_modules/@higgsfield/cli/${HF_JS}"
fi

if [ ! -f "$HF_JS" ]; then
  echo "ERROR: Higgsfield CLI の entry point が見つかりません"
  ls -R "${EXT_DIR}/node_modules/@higgsfield/cli" | head -50
  exit 1
fi

# higgsfield ラッパー作成 (PATH 不要、絶対パスで node を呼ぶ)
cat > "${EXT_DIR}/bin/higgsfield" <<EOF
#!/bin/bash
SELF_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
EXT_ROOT="\$(cd "\${SELF_DIR}/.." && pwd)"
exec "\${EXT_ROOT}/bin/node" "\${EXT_ROOT}/node_modules/@higgsfield/cli/$(realpath --relative-to="${EXT_DIR}" "$HF_JS" 2>/dev/null || python3 -c "import os; print(os.path.relpath('$HF_JS', '${EXT_DIR}'))" | sed 's|node_modules/@higgsfield/cli/||')" "\$@"
EOF
chmod +x "${EXT_DIR}/bin/higgsfield"

# ───── 3. dmg ビルド ─────
echo "==> dmg をビルド"

# README を payload に追加
cat > "${PAYLOAD_DIR}/README.txt" <<EOF
GORI GORI KUN - Higgsfield 拡張パック
======================================

このフォルダごと、以下の場所にコピーしてください:
  ~/Library/Application Support/app.codexframefactory/extensions/

または同梱の「インストール.command」をダブルクリックして自動配置できます。

インストール後、GORI GORI KUN を再起動して
「設定 → 接続先 → HiggsField」から「接続する」を押してください。
EOF

# 自動インストーラ
cat > "${PAYLOAD_DIR}/インストール.command" <<EOF
#!/bin/bash
set -e
SRC_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
DEST="\${HOME}/Library/Application Support/app.codexframefactory/extensions"
mkdir -p "\${DEST}"
echo "==> Higgsfield 拡張を \${DEST}/higgsfield にインストール中..."
rm -rf "\${DEST}/higgsfield"
cp -R "\${SRC_DIR}/higgsfield" "\${DEST}/"
echo "✅ インストール完了"
echo ""
echo "GORI GORI KUN を再起動して、設定 → 接続先 → HiggsField から接続してください。"
echo ""
read -p "Enter キーを押して閉じる"
EOF
chmod +x "${PAYLOAD_DIR}/インストール.command"

# dmg 作成
DMG_PATH="${DIST_DIR}/GORI-HiggsField-Extension_mac-${ARCH}.dmg"
rm -f "${DMG_PATH}"
hdiutil create \
  -volname "GORI HiggsField Extension" \
  -srcfolder "${PAYLOAD_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

echo "✅ Built: ${DMG_PATH}"
ls -lh "${DMG_PATH}"
