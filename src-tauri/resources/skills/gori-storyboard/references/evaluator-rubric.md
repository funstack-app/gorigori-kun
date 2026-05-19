# Evaluator Rubric

Evaluate every generated candidate before confirming a cut. The evaluator runs inside the same Codex session and must not launch nested `codex exec` processes. Use attached image paths and references directly in the current workflow.

## Scoring Axes

| 軸 | 評価対象 | 0-100スコア基準 | 重視度 |
|----|--------|-------------|------|
| Identity Score | キャラの顔・髪型・体型 | 100=参照画像と完全一致、50=同一人物だがブレ、0=別人 | ★★★ |
| Outfit Consistency | 服装・色 | 100=完全一致、50=同系統だが変化、0=別の服 | ★★★ |
| Prop Consistency | 持ち物・装飾 | 100=維持、50=変化あるが文脈OK、0=不自然な消失 | ★★ |
| Face Quality | 目・口・鼻の歪み | 100=破綻なし、50=軽微な歪み、0=明らかな破綻 | ★★★ |
| Hand Quality | 指の本数・形 | 100=破綻なし、50=軽微、0=指の数が違う等 | ★★★ |
| Background Continuity | 場所・時間帯・光 | 100=シーングループ内で連続、50=軽微なズレ、0=不連続 | ★★ |

## Decision Rules

- All scores 80 or higher: adoptable candidate.
- Any score below 50: failed candidate; regenerate automatically.
- Scores from 50 to 79: usable only with a warning; prefer a cleaner candidate if available.
- If all takes fail after the initial attempt, retry the cut.
- Retry at most 2 times per cut.
- If all takes remain below threshold after 2 retries, emit `cutFailed` with a concise `reason`.

## Evaluator Implementation Policy

- Use the same Codex session for vision evaluation; do not call nested `codex exec` for scoring.
- Attach or inspect the generated candidate image, the character reference image, the style reference image, and the previous confirmed cut when available.
- Use GPT-5.5 vision capability according to the active Codex model configuration.
- Keep a 120-second upper bound for each evaluator call, matching the reliability expectation of `codex_vision.rs`.
- Require strict JSON output from the evaluator before writing `takeCompleted` to stdout.
- Send evaluator reasoning, warnings, and parse-retry diagnostics to stderr only.

## Required Evaluator JSON

```json
{
  "scores": {
    "identity": 92,
    "outfit": 88,
    "prop": 85,
    "face": 94,
    "hand": 90,
    "background": 87
  },
  "warnings": [],
  "decision": "adoptable",
  "reason": "Character identity and scene continuity are stable."
}
```

## takeCompleted Event Mapping

After parsing evaluator JSON, emit one stdout line per take:

```json
{"kind":"takeCompleted","cutId":"shot_001","takeId":"A","imagePath":"/abs/path/shot_001_take_A.png","scores":{"identity":92,"outfit":88,"prop":85,"face":94,"hand":90,"background":87}}
```

The event must include only machine-readable progress fields. Do not include evaluator prose on stdout.

## Candidate Selection

1. Reject candidates with any score below 50.
2. Among remaining candidates, sort by weighted total: identity, outfit, face, and hand are strongest; prop and background are secondary.
3. If two candidates tie, prefer the one with better background continuity inside the same scene group.
4. If still tied, prefer the one with more visible motion room from `references/verb-dictionary.md`.
5. Emit `cutConfirmed` for the selected take and use it as the previous-cut reference for the next cut.
