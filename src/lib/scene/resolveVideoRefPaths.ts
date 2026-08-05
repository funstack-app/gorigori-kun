/**
 * 動画生成に渡す参照画像パスを決める。
 *
 * ## 背景 (2026-08-05)
 *
 * 旧実装は i2v 元画像 (`sourceImagePath`) がセットされていると、参照ラックの
 * キャラ参照画像を **丸ごと捨てて** 元画像1枚だけを渡していた:
 *
 * ```ts
 * if (sourceImagePath) return [sourceImagePath];   // ← composerReferences が消える
 * return composerReferences.map((r) => r.path);
 * ```
 *
 * その結果「ストーリーボードから確定カットを送った状態」でキャラプリセットを
 * 適用すると、**参照ラックのチップには画像が見えているのに**、生成へ渡るのは
 * 元画像1枚だけで、キャラの同一性は属性テキスト
 * (`キャラクター設定: 黒髪ロング / 青い瞳 …`) でしか効かなかった。
 *
 * これは STΛCK の原則
 * 「画像はあくまで参照（＝これ）／プロンプトはそれをどうするか」
 * の逆転で、コード中に設計理由のコメントも無かった (＝意図的判断ではなくバグ)。
 *
 * ## なぜ両方渡してよいか (モデル側制約の実測)
 *
 * `src-tauri/src/commands/higgsfield_mcp.rs:661-683` は `ref_image_paths` を
 * **全件** ループして `media_upload` → `medias[]` に積む。枚数上限も、
 * i2v 元画像と参照画像を区別するスロットも**存在しない**:
 *
 * ```rust
 * for path in &ref_paths {
 *     match upload_reference(&state, &http, path).await {
 *         Ok(media_id) => medias.push(json!({ "value": media_id, "role": role })),
 * ```
 *
 * role は `resolve_media_role` がモデルカタログから引く 1 種類を全画像に付ける。
 * つまり「元画像は先頭、以降が参照」という順序以上の意味はフロントには無く、
 * **捨てる必要が無い**。よって i2v 元画像を先頭に置き、参照ラックを後ろに
 * 連結する (順序 = 意味を持ちうる唯一の情報なので元画像を先頭に固定する)。
 *
 * 上限が将来モデル側に入った場合でも、ここで黙って捨てず
 * 「捨てたことを呼び出し側へ返す」形 (`dropped`) にしてあるので、UI で
 * 可視化できる (原則5「失敗させるより救済して可視化」)。
 */

export type VideoRefSource = {
  /** i2v 元画像 (動画タブの sourceImagePath)。無ければ null/undefined。 */
  sourceImagePath?: string | null;
  /** 参照ラックの画像パス (登録順)。 */
  referencePaths: readonly string[];
};

export type VideoRefPathsResult = {
  /** 実際に生成へ渡すパス (i2v 元画像が先頭・重複排除済み)。 */
  paths: string[];
  /**
   * 枚数上限などで落とした参照画像。現状の Higgsfield MCP には上限が無いため
   * 常に空だが、「黙って捨てない」契約を型で固定しておく。
   */
  dropped: string[];
};

/**
 * i2v 元画像と参照ラックを結合する。
 *
 * - i2v 元画像があれば先頭に置く (順序が唯一の手掛かりのため)
 * - 参照ラックはその後ろに登録順で連結する
 * - 同一パスの重複は 1 回に正規化する (元画像がラックにも入っている場合)
 * - 空文字・空白のみのパスは無視する
 */
export function resolveVideoRefPaths(
  source: VideoRefSource,
): VideoRefPathsResult {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (path: string | null | undefined): void => {
    if (typeof path !== "string") return;
    const trimmed = path.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  // i2v 元画像を先頭に固定する。参照ラックはその後ろ。
  push(source.sourceImagePath);
  for (const path of source.referencePaths) {
    push(path);
  }

  return { paths: ordered, dropped: [] };
}
