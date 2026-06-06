---
name: gori-multi-angle
description: Generate many camera-angle and shot-distance variations of a single subject
  from one reference image, keeping subject identity and environment fixed — as if the
  camera moved around the subject. Use for /gori-multi-angle, multi-angle generation,
  turnaround views, angle variations, "make many shots of this character from different
  angles and distances". Each selected cut is generated in parallel as a single image.
---

# GORI Multi-Angle

1枚の被写体参照画像から、被写体の同一性（顔・体型・服）と環境・ライティングを固定したまま、
**カメラだけを動かしたように** アングル × ショット距離 の構図バリエーションを生成する。

storyboard と違い、対話・絵コンテ・並列候補比較・AI評価・連続性は持たない。
ユーザーが選んだ構図カット（最大30）を **並列で一気に** 生成し、各カットを1枚の独立画像として返す。

## Inputs

- `character_image` (required): 被写体の参照画像パス。全カットでこの同一性を維持する。
- `environment_description` (optional): 全カット共通の環境・背景。空なら参照画像の環境を踏襲。
- `aspect_ratio`: "1:1" | "9:16" | "16:9" | "4:5"。
- `cut_prompts`: ユーザーが選んだ構図カットの配列。各 `{ cut_id, label, prompt_fragment }`。
  `prompt_fragment` は構図の英語表現（例: "full body shot, eye level, front view"）。

## 構図語彙（3軸 + 特殊）

詳細は `references/angle-dictionary.md`（語彙の正典）を読む。

- ショット距離: EWS / WS / FS / MLS / MS / MCU / CU / ECU
- 垂直アングル: バーズアイ / ハイ / アイレベル / ロー / ワームズアイ / ダッチ / 真上 / ドローン
- 水平方向: 正面 / 右斜め前3/4 / 右サイド / 右斜め後3/4 / 背面 / 左斜め後3/4 / 左サイド / 左斜め前3/4
- 特殊: 目ECU / 手ECU / ヒーロー / 肩越し / POV / アイソメ

構図カタログの正本（30カット）はアプリ側 `src/lib/multiangle/angles.ts`。
本スキルは prompt_fragment を受け取って生成に焼き込むだけ。

## Workflow

1. 各カットについて、被写体参照画像を渡しつつ構図プロンプトを組み立てる。
   - 被写体同一性・環境・ライティングを固定する固定句を必ず付与する。
   - カメラを動かす（被写体を動かさない）という前提を明示する。
2. 選ばれた全カットを並列生成する（同時実行数は rate limit 保護のため制限）。
3. 各カットは1枚の独立画像。評価せず生成結果をそのまま採用する。
4. 生成画像は出力ディレクトリに `{cut_id}.png` で保存する。

## 被写体同一性・環境固定の固定句（全カット共通）

```
keep the exact same character identity, face, body and outfit from the reference image,
keep the same environment and lighting, only the camera position/angle/distance changes
as if the camera moved around the subject, no text, no watermark, no collage, single image.
```

## References

- `references/angle-dictionary.md`: 構図語彙の正典（3軸 + 特殊 + プリセット）。

## 実行形態

アプリ（GORI GORI KUN）の MultiAngleWorkspace から `multiangle_run` コマンド経由で起動される。
Rust オーケストレーター（`multiangle.rs`）が CODEX_HOME を隔離し、各カットを `codex exec` の
`image_gen` で並列生成する。進捗は `codex://multiangle` イベントで UI に流れる。
スタンドアロンの `codex exec` 実行も可能（被写体画像 + 構図リストを渡す）。
