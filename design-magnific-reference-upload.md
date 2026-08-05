# 設計書: Magnific 参照つき画像生成の全滅を直す (2026-08-06)

## 症状 (STΛCK 実機報告 v2.5.1)

- Magnific 接続済み。**参照なし = 生成成功 / 参照あり = 4件すべて失敗**
- 表示文言: 「画像生成に失敗しました（4件すべて失敗）。自動リトライしても改善しませんでした。
  原因を特定できませんでした。…ログイン状態や接続（ChatGPT / Higgsfield）を見直す…」
- 二次問題: provider が Magnific なのに案内が「ChatGPT / Higgsfield」

## 原因 (実測で確定。仮説(c)「参照形式の不一致」の一種＝レスポンスのキー名変更)

`src-tauri/src/commands/magnific.rs:257` が `creations_request_upload` の応答から
**`directUploadUrl`** を固定キーで読み、無ければ即エラーにしている。

現行 Magnific MCP を本セッションから直接叩いた実測 (2026-08-06):

```
creations_request_upload {mimeType:"image/png"}
→ {"proxyUploadUrl":"https://ak-data.magnific.com/app/api/mcp/uploads/proxy/....png?...",
   "path":"temp-files/....png","mimeType":"image/png","expiresAt":"...","instructions":"..."}
```

**`directUploadUrl` は返らない。現行キー名は `proxyUploadUrl`。**
`grep -rn directUploadUrl` の結果、この文字列はリポジトリ内で magnific.rs にしか存在せず、
PoC (2026-06-10) 当時のキー名がそのまま焼かれていた＝外部前提の陳腐化 (規律7)。

### 機序 (参照ありだけが落ちる理由)

1. 参照なし → `upload_magnific_reference` を一度も通らない → `images_generate` へ直行 → **成功**
2. 参照あり → 1枚目のアップロード準備で `directUploadUrl` が無く `Err` →
   `magnific_generate_batch` は `failed_count: count` で**即 return** (magnific.rs:427)
   → 画像は1枚も作られない = **4件すべて失敗**

### 「原因を特定できませんでした」になる理由 (別バグ・同時に直す)

エラー文言 `"creations_request_upload の応答に directUploadUrl がありません"` は
`retryClassify.ts` の PERMANENT_KEYWORDS のどれにも当たらない
→ **一時的失敗**に分類 → 3回リトライ → 毎回同じ理由で失敗 →
`decision.permanentReasons` が空 → `totalFailureMessage([])` の汎用文言に落ちる。
つまり Rust は理由を返していたのに、分類器が握り潰していた。

## 修正方針

### F1 (根治): アップロード URL を多キー・フォールバックで読む

`credits` 解釈 (`magnific_json_to_number`) と同じ既存方針を踏襲する。固定1キーをやめる:

- 優先順: `proxyUploadUrl` (現行) → `directUploadUrl` (旧PoC/将来の復活) →
  `uploadUrl` / `url` (一般名) → トップレベルで「http から始まる文字列値」を1つ拾う
- **`path` は現行どおり必須**。取れなければエラー (推測で埋めない)
- 読めなかった場合のエラーに **受信キー構成** を載せる (`magnific_describe_shape` を再利用。
  値は出さない＝署名付きURLを漏らさない)。次に壊れたとき即座に原因が分かる

### F2: 参照アップロード失敗を「恒久的失敗」に分類する

アプリ側の形式不一致・非対応拡張子はリトライで直らない。
`retryClassify.ts` の PERMANENT_KEYWORDS に参照アップロード系の語を追加し、
3回の無駄リトライをやめ、**理由をそのままユーザーに出す**。

### F3: エラー文言が実プロバイダを指すようにする

`totalFailureMessage` の「ログイン状態や接続（ChatGPT / Higgsfield）を見直す」を
provider 別に出し分ける (`magnific` → Magnific / `higgsfield` → Higgsfield /
`codex` → ChatGPT)。`provider` は同ファイル 234行で既に算出済みなので再利用する。

### F4: 可視化 (原則5)

`upload_magnific_reference` に tracing を入れる。現状この関数は成功・失敗とも
一切ログを出さず、実機ログ (`gori-gori-kun.log.2026-08-05`) に痕跡がゼロだった。
**パスとキー構成だけ**を出す (署名付きURL・画像の中身は出さない)。

## 非スコープ (触らない)

- Higgsfield 経路 / codex 経路の挙動 (F3 の文言分岐のみ、意味は不変)
- 本日の i2v 参照併用 `resolveVideoRefPaths` / チカチカ対策
- `images_generate` の references 形式 (`{type:"image", identifier}` は
  現行スキーマと一致していることを MCP スキーマで確認済み。変更不要)

## 受入条件 (DoD)

1. `npx tsc --noEmit` 0 / `npx vitest run` 全パス / `cargo check` 緑 / `cargo test --lib` 全パス
2. `proxyUploadUrl` を返す応答から URL を取り出せる (Rust ユニットテスト)
3. `directUploadUrl` しか無い旧応答でも取り出せる (後方互換テスト)
4. どちらも無い応答では **エラーになり、キー構成がメッセージに含まれる** (値は含まない)
5. 参照アップロード失敗が `isPermanentFailure` = true (フロントテスト)
6. 全件失敗の案内文が provider に応じて Magnific / Higgsfield / ChatGPT を出し分ける (フロントテスト)
7. 牙: 修正を戻すと上記テストが落ちることを実証してから復元する
8. 実機での実生成は本作業では行わない (STΛCK が1枚試して閉じる)
