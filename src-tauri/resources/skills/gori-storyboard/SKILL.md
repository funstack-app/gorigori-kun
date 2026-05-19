---
name: gori-storyboard
description: Generate consistent video storyboard cuts from a story prompt with character/style anchoring, scene-group-aware 180° rule, video-motion-aware composition, and AI quality evaluation. Use when the user asks for /gori-storyboard, continuous cut generation, video storyboard, scene-by-scene generation, "make N cuts for a video", or AI video preproduction. The skill ALSO has an interactive elicitation phase that draws out the user's story when they don't have one ready.
---

# GORI Storyboard

Use this skill to generate a coherent sequence of video storyboard cuts from a story prompt, keeping character/style identity stable while progressing the narrative.

このスキルは **2フェーズ** で動く:

1. **企画フェーズ (Story Elicit Phase)**: 企画タブでユーザーと対話し、ストーリーと必要情報を引き出す
2. **生成フェーズ (Generation Phase)**: 生成タブで構造化プロンプトに展開し、各カットを画像生成する

企画タブの planChat 経由で起動された場合は **Phase 0 (Story Elicit Phase) を必ず最初に実行する**。
プログラマティックに直接 storyboardParams が渡された場合は Phase 0 をスキップして生成へ。

## Phase 0: Story Elicit Phase (企画タブ専用)

ユーザーが企画タブでストーリーカットスキルを起動した時、まずこのフェーズを走らせる。

### 必須参照リファレンス

- `references/story-elicit.md`: ストーリー引き出し対話ガイド (★読み込み必須)
- `references/cut-calculator.md`: 尺からカット数を内部計算する式

### Phase 0 の絶対ルール (詳細は `references/story-elicit.md` 参照)

1. **専門用語禁止**: 起承転結、三幕構成、ロングショット、DoP 等の用語を質問に使わない。プロが知ってる前提では話さない。
2. **1メッセージ最大2つの質問**: 詰問にしない。
3. **AI が考えるべきことはユーザーに聞かない**: カット数、構図、シーン分割は AI 側で計算・提案する。ユーザーには「尺」「伝えたいこと」「主人公」「場所」「雰囲気」「感情の動き」だけを聞く。
4. **「何を伝えたいか」を必ず聞く**: これが全構成の軸になる。
5. **主人公が複数なら参照画像を全員分要求**: 一貫した見た目で生成するために必要。
6. **何度でもブラッシュアップ**: ユーザーが「確定ボタン」を押すまで、勝手に完成形を決めない。
7. **「OK」「いいね」のキーワード検知では確定しない**: ユーザーが UI 側の確定ボタンを押した瞬間にだけ最終JSON を出力する。

### Phase 0 の最終出力

ユーザーが UI 側の「確定」ボタンを押した時、対話履歴を以下のJSON 形式で1行出力する。

```json
{"kind":"storyboard_params_finalized","story_prompt":"...","intent":"...","duration_seconds":30,"aspect_ratio":"9:16","tempo":"standard","estimated_cut_count":12,"scene_groups":[...],"main_characters":[...],"atmosphere":"...","location":"..."}
```

この JSON が生成タブの `storyboardParams` に流し込まれる。

## Operating Principles (生成フェーズ)

- Character identity from fixed reference, narrative continuity from previous cut.
- Aspect ratio fixed at story-level; composition varies per cut.
- Video-motion-aware framing (e.g. wide shot for walking, close-up for facial action).
- Parallel 3-candidate generation per cut, evaluator picks the best.
- Fallback to single-candidate mode when rate limit is high.

## Inputs

Collected from PlanWorkspace (story confirmation) or programmatic call:

- story_prompt: natural language story description.
- character_reference_image: path to character anchor image (required).
- style_reference_image: path to style anchor image (optional, falls back to character image).
- aspect_ratio: "9:16" | "1:1" | "16:9" | "4:5" (fixed for entire story).
- duration_seconds: target total video length.
- tempo: "fast" | "standard" | "slow".
- candidates_per_cut: 3 | 1 (user-selectable for rate control).
- cwd: working directory for project association.

If a required input is missing, ask for it before generation. If optional values are omitted, use `standard` tempo, `3` candidates per cut, `1:1` aspect ratio, and the character reference as the style reference.

## Workflow

1. Compute cut count from duration / tempo.
   - fast: 1.5-2s per cut.
   - standard: 2-3s per cut.
   - slow: 3-5s per cut.
2. Split story into scene groups by location/time keywords (see `references/scene-grouping.md`).
3. For each cut:
   a. Build structured prompt (see `references/prompt-builder.md`).
   b. Spawn N parallel generation workers (N = `candidates_per_cut`) using the `batch_gen.rs` pattern: each worker gets an isolated `CODEX_HOME`, shared config is symlinked, `generated_images/` is private, and the finished PNG is copied into the run output directory. When the skill is already running inside `codex exec` without an external orchestrator, do not nest `codex exec`; generate candidates in the current session and keep the same stdout protocol.
   c. Each worker generates one image candidate and returns one absolute image path.
   d. Evaluator scores all candidates on 6 axes (see `references/evaluator-rubric.md`). Evaluation runs in the same Codex session; do not launch nested `codex exec` for scoring.
   e. Pick highest-scored candidate.
   f. If best score below threshold, auto-retry the cut (max 2 retries).
   g. Confirmed cut becomes previous-cut reference for next cut.
4. After 3 cuts, emit a checkpoint event for user mid-review.
5. Save final cuts to `~/.codex/generated_images/gori-storyboard-{run_id}/`.
6. Emit completion event with full manifest.

Use `codex_vision.rs` as the reliability pattern for evaluator behavior: `gpt-5.5`, low reasoning when available, 120-second upper bound, strict JSON response parsing, clear error messages, and no non-JSON progress text on stdout.

## Progress Output (stdout protocol)

The skill writes progress events to **stdout, one JSON object per line**.
The Tauri bridge (`storyboard.rs`) parses these lines and converts them
to Tauri events on the channel `codex://storyboard` (NOT `EVENT_IMAGE_BATCH`).

This design ensures the skill is **runnable standalone via `codex exec`**
without any Tauri dependency. When invoked from the app, the bridge
performs the Tauri-side translation.

### Output line format

Each line must be valid JSON with a `kind` discriminator:

```json
{"kind":"started","runId":"...","totalCuts":7,"sceneGroups":[{"id":"morningHome","cutIds":["shot_001","shot_002"]}]}
{"kind":"cutStarted","cutId":"shot_001","sceneGroupId":"morningHome","takeCount":3}
{"kind":"takeCompleted","cutId":"shot_001","takeId":"A","imagePath":"/abs/path/shot_001_take_A.png","scores":{"identity":92,"outfit":88,"prop":85,"face":94,"hand":90,"background":87}}
{"kind":"cutCheckpoint","cutId":"shot_003","reason":"midRun review at cut 3"}
{"kind":"cutConfirmed","cutId":"shot_001","selectedTakeId":"B"}
{"kind":"cutFailed","cutId":"shot_004","reason":"all takes below threshold after 2 retries"}
{"kind":"completed","runId":"...","manifestPath":"/abs/path/manifest.json"}
```

**All fields must use camelCase**. Rust receivers should use `#[serde(rename_all = "camelCase")]`.

### Payload fields

- started: `runId`, `totalCuts`, `sceneGroups`.
- cutStarted: `cutId`, `sceneGroupId`, `takeCount`.
- takeCompleted: `cutId`, `takeId`, `imagePath`, `scores`.
- cutCheckpoint: `cutId`, `reason`.
- cutConfirmed: `cutId`, `selectedTakeId`.
- cutFailed: `cutId`, `reason`.
- completed: `runId`, `manifestPath`.

### Logging guideline

- Non-progress logs (debug, info, warnings, evaluator notes) MUST go to stderr to avoid polluting the JSON stream.
- One stdout line = one event. No multi-line JSON.
- Field names use camelCase to align with TypeScript convention on the bridge side.
- Never print Markdown, prose, ANSI color, or stack traces to stdout during execution.

## References

### Phase 0 (企画フェーズ) で使うもの

- `references/story-elicit.md`: **対話ガイド (必読)**。質問テンプレート、NG/OK 例、尺別の深さ調整。
- `references/cut-calculator.md`: 尺・テンポからカット数を内部計算する式、構成比率。

### Phase 1+ (生成フェーズ) で使うもの

- `references/prompt-builder.md`: structured prompt JSON spec and field semantics.
- `references/verb-dictionary.md`: motion-verb detection and shot-type mapping.
- `references/scene-grouping.md`: location/time keyword detection and group reset rules.
- `references/evaluator-rubric.md`: 6-axis scoring (identity, outfit, prop, face, hand, background).
- `references/film-grammar.md`: A-roll/B-roll, three-act cut roles, step zoom, eyeline, and prompt detail requirements. **Mandatory** reference when building structured prompts.

Load only the reference files needed for the current task.

## Phase 切り替え判定

スキルが起動された時のコンテキストで Phase を判定する:

| 入力 | Phase |
|---|---|
| 企画タブの planChat 経由 + storyboardParams 未確定 | Phase 0 (Story Elicit) |
| storyboardParams 既に揃ってる + 生成タブの実行ボタン押下 | Phase 1+ (Generation) |
| codex exec から直接呼ばれ全パラメータが渡されている | Phase 1+ (Generation) |

Phase 0 中は **stdout に何も出さない**。Phase 1+ になってから stdout プロトコルを開始する。
