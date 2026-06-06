# Angle Dictionary — マルチアングル生成の構図語彙

> 世界標準のカメラ用語 → AI画像生成プロンプト英語表現の対応辞書。
> マルチアングル生成は「ショット距離 × 垂直アングル × 水平方向」の3軸で構図を指定する。
> 出典: StudioBinder / Wikipedia Camera Angle / 各AI生成プロンプトガイド（2026-06-06 調査）。

## 軸1: ショット距離（shot size）— 被写体との距離

| key | 日本語 | 英語プロンプト | 切れる位置 |
|---|---|---|---|
| `ews` | エクストリームワイド | `extreme wide shot, establishing shot` | 人物がほぼ点。環境主体 |
| `ws` | ワイド/ロング | `wide shot, long shot` | 全身＋周囲環境 |
| `fs` | フルショット | `full body shot, head to toe` | 全身。衣装・姿勢 |
| `mls` | ミディアムロング | `medium long shot, knees up` | 膝から上 |
| `ms` | ミディアム | `medium shot, waist up` | 腰から上。対話の定番 |
| `mcu` | ミディアムCU | `medium close-up, chest up, bust shot` | 胸・肩から上 |
| `cu` | クローズアップ | `close-up shot, face close-up` | 顔全体 |
| `ecu` | エクストリームCU | `extreme close-up, macro detail` | 目・口・手など一部 |

## 軸2: 垂直アングル（camera height / pitch）

| key | 日本語 | 英語プロンプト | 心理効果 |
|---|---|---|---|
| `birdseye` | バーズアイ（鳥瞰） | `bird's eye view, top-down view, overhead` | 俯瞰・配置・監視感 |
| `high` | ハイアングル | `high angle shot, looking down at subject` | 脆弱・小さく見せる |
| `eye` | アイレベル | `eye level shot, eye-level angle` | 中立・自然（基本） |
| `low` | ローアングル | `low angle shot, looking up at subject` | 力強さ・英雄的 |
| `wormseye` | ワームズアイ（虫瞰） | `worm's eye view, extreme low angle` | 誇張・非現実感 |
| `dutch` | ダッチアングル（傾き） | `dutch angle, canted angle, tilted camera` | 不安・緊張 |
| `overhead` | 真上 | `overhead shot, directly overhead, flat lay` | 真真上90度 |
| `aerial` | エリアル/ドローン | `aerial shot, drone view, high altitude` | スケール・叙事詩 |

## 軸3: 水平方向（yaw / orientation）

| key | 度数 | 日本語 | 英語プロンプト |
|---|---|---|---|
| `front` | 0° | 正面 | `front view, front-facing, straight-on` |
| `front_r34` | 315° | 右斜め前3/4 | `front right three-quarter view, 3/4 view` |
| `side_r` | 270° | 右サイド（横顔） | `right side profile view, lateral view` |
| `rear_r34` | 225° | 右斜め後3/4 | `rear right three-quarter view` |
| `back` | 180° | 背面 | `back view, rear view, from behind` |
| `rear_l34` | 135° | 左斜め後3/4 | `rear left three-quarter view` |
| `side_l` | 90° | 左サイド（横顔） | `left side profile view` |
| `front_l34` | 45° | 左斜め前3/4 | `front left three-quarter view` |

## 特殊ショット（軸に乗らない演出単体カット）

| key | 日本語 | 英語プロンプト |
|---|---|---|
| `eyes_ecu` | 目のECU | `extreme close-up of eyes, Italian shot, eye detail` |
| `hands_ecu` | 手のECU | `extreme close-up of hands, hand detail shot` |
| `hero_low` | ヒーローショット | `low-angle hero shot, powerful stance, dramatic` |
| `ots` | 肩越し | `over-the-shoulder shot, OTS` |
| `pov` | 主観 | `POV shot, first-person perspective` |
| `isometric` | アイソメトリック | `isometric view, 3D game style angle` |

## プロンプト合成ルール

各カットは **距離 + 垂直 + 水平 を3語で連結**するとAI生成が安定する（調査示唆）:
```
{distance英語}, {vertical英語}, {horizontal英語}
例: "full body shot, eye level, front view"
例: "close-up shot, low angle, three-quarter view"
```
特殊ショットは単体で使う（3軸合成しない）。

被写体同一性・環境固定の固定句（全カット共通で付与）:
```
consistent character identity from reference image, same outfit, same environment and lighting, only camera angle changes
```

## プリセット（キュレート済みカット集 — 全掛け算しない）

全軸の掛け算は組合せ爆発（8×8×8）するので、意味あるカットだけをキュレートする。
ユーザーは選んだカットだけ生成される（リミット事故防止）。

### preset_8 — 最小（キャラ確認）
fs/front, fs/side_r, fs/back, fs/front_r34, cu/front, cu/front_r34,
ms/front(low), ms/front(high)  ← 8カット

### preset_16 — 標準（映像/コミック）
ews/front, fs/front, fs/front_r34, fs/side_r, fs/back, ms/front, ms/front_r34,
ms/front(low=hero), ms/front(high), mcu/front, mcu/front_r34, cu/front,
cu/front_r34, cu/front(low), eyes_ecu, fs/front(dutch)  ← 16カット

### preset_30 — 網羅（全方位リファレンス）
基本グリッド20（fs/ms/mcu/cu × 垂直3〜5 × 水平4の意味ある組合せ）
+ 特殊10（eyes_ecu, hands_ecu, hero_low, ots, dutch, aerial, pov,
fs/rear_r34, fs/rear_l34, isometric）  ← 30カット

> 実装上、preset は「(distance, vertical, horizontal | special) の配列」として持つ。
> ユーザーはプリセット選択 → 個別チェックで増減 → 選んだカットだけ生成。
