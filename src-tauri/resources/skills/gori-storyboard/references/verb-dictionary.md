# Verb Dictionary

Use this reference to infer the motion space a cut needs from `narrative.current_action`. The goal is not only a pretty still image; the frame must leave enough visual room for the implied video motion.

## Motion Mapping

| 動詞カテゴリ | 例 | 必要な余白 | 推奨ショット |
|------------|-----|---------|----------|
| 前進 | 歩く、走る、近づく | 奥行き（手前空間） | wide shot、被写体は奥側 |
| 後退 | 離れる、後ずさる | 奥行き（背後空間） | wide shot、被写体は手前 |
| 振り返り | 振り返る、見渡す | 左右の空間 | medium shot、片側余白 |
| 上下視線 | 見上げる、見下ろす | 縦方向 | low/high angle、縦余白 |
| 入退場 | 入る、出る | フレーム端の空間 | wide shot、端から侵入 |
| 落下・着地 | 倒れる、座る、跳ぶ | 下方/上方の空間 | 構図に応じて余白 |

## Detection Policy (Mandatory)

- The `shot_type` MUST be one of: `extreme close-up` | `close-up` | `medium close-up` | `medium` | `medium-wide` | `wide` | `extreme wide`.
- The chosen value is REQUIRED to come from the verb mapping below, not from a generic safe default.
- If the action does not match any verb category, fall back to one of the narrative-emphasis rules in `prompt-builder.md` "Justification Requirement".
- "medium close-up" is the most common LLM fallback. Do NOT pick it unless the verb clearly maps to it (e.g. operating something at desk distance).
- Extract verbs from `current_action` before choosing `framing.shot_type`.
- If several verbs appear, prioritize the verb that changes body position most strongly.
- If a facial expression verb and a body movement verb conflict, use the body movement for spatial room and reserve facial readability with camera distance.

## Verb → Shot Type Hard Mapping (Override Generic Defaults)

| 動詞例 | 強制 shot_type | 強制 camera_angle (推奨) |
|--------|--------------|------------------------|
| 見つめる、凝視する | close-up | eye-level |
| 反射する、光る、輝く（目や顔への光） | extreme close-up | eye-level |
| 起動する、点灯する（装置側を見せる） | close-up | high angle on the device |
| 操作する、レバーを動かす、配線をいじる | extreme close-up (手元) | top-down or high angle |
| 揺れる、震える、広がる（環境の異変） | medium-wide | dutch angle (不安・異変) |
| 驚く、息を呑む、目を見開く | close-up (顔) | eye-level |
| 微笑む、安堵する | close-up or medium close-up | eye-level |
| 全体が包まれる、満たされる | wide / extreme wide | low angle (壮大さ) |
| 振り返る | medium | eye-level, with side room |
| 歩く、走る、近づく | wide | eye-level or low angle |
| 倒れる、座る、跳ぶ | medium-wide or wide | depends on emphasis |

## Prompt Injection Rules

- Forward motion: set `shot_type` to `wide shot` or `medium-wide`; place the subject deeper in frame and keep lead room in the movement direction.
- Backward motion: set `shot_type` to `wide shot`; place the subject closer to camera and preserve background depth.
- Turn/look-around motion: set `shot_type` to `medium shot`; keep left/right room around the head and shoulders.
- Looking up/down: use `low angle` or `high angle`; keep vertical head room or lower-frame space according to gaze direction.
- Entry/exit: use `wide shot`; leave usable negative space near the relevant frame edge.
- Falling/sitting/jumping: reserve vertical space; avoid tight crops that cut off feet, hands, or landing area.

## Evaluator Link

The evaluator must check whether `spatial_room_for_motion` is visible. If a cut scores well on identity but lacks the required motion space, mark the relevant axis warning and prefer a candidate with better video staging.
