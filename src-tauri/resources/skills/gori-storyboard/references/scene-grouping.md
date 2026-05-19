# Scene Grouping

Scene groups preserve continuity for adjacent cuts that share location and time. A scene group controls the 180-degree rule, lighting continuity, and background continuity.

## Keyword Dictionaries

場所キーワード辞書:

- 屋内: 部屋、家、リビング、寝室、キッチン、オフィス、カフェ、店内、車内、電車内
- 屋外: 駅、街、道、公園、ビーチ、山、空、海
- 特殊: 夢、回想、移動中

時間キーワード辞書:

- 時間帯: 朝、昼、夕、夜、深夜
- 季節: 春、夏、秋、冬
- 天候: 晴れ、雨、雪、曇り

## Split Algorithm

1. Break the story into cut-sized beats according to duration and tempo.
2. Extract location and time keywords from each cut.
3. If consecutive cuts have the same location and time, assign the same `scene_group_id`.
4. If location or time changes, create a new `scene_group_id`.
5. If a cut has no explicit keyword, inherit the previous group only when the action clearly continues from the previous cut.
6. If a cut enters a dream, flashback, memory, or montage, create a new group even if the same character appears.

## Group Id Format

- Use short camelCase ids such as `morningHome`, `cafeConversation`, `nightStreet`, or `trainInterior`.
- Keep `cutIds` in chronological order.
- Do not expose Japanese punctuation or spaces in `scene_group_id`.

## Continuity Reset Rules

When `scene_group_id` changes, reset:

- `character_layout` for 180-degree rule continuity.
- `lighting_continuity`.
- `location_consistency`.

When `scene_group_id` stays the same, keep:

- Character left/right relationship unless the action explicitly crosses the axis.
- Lighting direction and color temperature.
- Background architecture, props, weather, and time of day.

## 180-Degree Rule Guidance

- Activate the 180-degree rule for conversations, chase direction, repeated walking direction, and shot/reverse-shot scenes.
- Keep screen direction stable inside the same scene group.
- Deactivate or reset the rule when the scene group changes, when the camera crosses the axis intentionally, or when the story beat establishes a new geography.
