import { NO_SELECT, type SceneOption } from "./catalog";

const none: SceneOption = { value: NO_SELECT, hint: "指定なし", visual: "none" };

export const videoCompositionOptions: SceneOption[] = [
  none,
  { value: "Close Up", hint: "顔・ディテール", visual: "frame-close" },
  { value: "Medium", hint: "胸から上", visual: "frame-medium" },
  { value: "Wide", hint: "全身・引き", visual: "frame-wide" },
  { value: "Bird's-eye", hint: "真上から", visual: "frame-aerial" },
  { value: "Dutch Angle", hint: "斜めの緊張感", visual: "frame-tilt" },
  { value: "Over-the-shoulder", hint: "肩越しの会話感", visual: "frame-shoulder" },
];

export const cameraMovementOptions: SceneOption[] = [
  none,
  { value: "静止", hint: "絵を固定して見せる", visual: "camera-cinema" },
  { value: "パン左", hint: "画面を左へ振る", visual: "camera-cinema", video: "/scene-videos/camera-pan-left.webm" },
  { value: "パン右", hint: "画面を右へ振る", visual: "camera-cinema" },
  { value: "チルトアップ", hint: "下から上へ見せる", visual: "camera-cinema", video: "/scene-videos/camera-tilt-up.webm" },
  { value: "チルトダウン", hint: "上から下へ見せる", visual: "camera-cinema", video: "/scene-videos/camera-tilt-down.webm" },
  { value: "ドリーイン", hint: "被写体へ寄る", visual: "focal" },
  { value: "ドリーアウト", hint: "被写体から離れる", visual: "focal" },
  { value: "トラッキング", hint: "被写体に並走", visual: "camera-digital" },
  { value: "クレーン", hint: "大きく上下移動", visual: "frame-aerial" },
  { value: "ハンディ手ブレ", hint: "臨場感・不安定", visual: "camera-mobile", video: "/scene-videos/camera-handheld.webm" },
  { value: "オービット", hint: "被写体の周囲を回る", visual: "lens", video: "/scene-videos/camera-orbit.webm" },
];

// カメラ自体の移動速度 (被写体の動きの速さ=motionIntensity とは別軸)。
export const cameraSpeedOptions: SceneOption[] = [
  none,
  { value: "スロー", hint: "カメラがゆっくり移動", visual: "none" },
  { value: "標準", hint: "カメラが自然な速度で移動", visual: "none" },
  { value: "高速", hint: "カメラが速く移動して勢いを出す", visual: "none" },
];

export const cameraStartPositionOptions: SceneOption[] = [
  none,
  { value: "中央", hint: "正面から開始", visual: "frame-medium" },
  { value: "左寄り", hint: "左側から開始", visual: "frame-wide" },
  { value: "右寄り", hint: "右側から開始", visual: "frame-wide" },
  { value: "上寄り", hint: "高めから開始", visual: "frame-aerial" },
  { value: "下寄り", hint: "低めから開始", visual: "frame-tilt" },
];

export const subjectMotionOptions: SceneOption[] = [
  none,
  { value: "歩く", hint: "前進系", visual: "style", video: "/scene-videos/motion-walk.webm" },
  { value: "走る", hint: "前進系", visual: "style", video: "/scene-videos/motion-run.webm" },
  { value: "近づく", hint: "前進系", visual: "style" },
  { value: "離れる", hint: "後退系", visual: "style" },
  { value: "後ずさる", hint: "後退系", visual: "style", video: "/scene-videos/motion-stepback.webm" },
  { value: "振り返る", hint: "振り返り", visual: "style", video: "/scene-videos/motion-turnaround.webm" },
  { value: "見渡す", hint: "振り返り", visual: "style" },
  { value: "見上げる", hint: "上下視線", visual: "style", video: "/scene-videos/motion-lookup.webm" },
  { value: "見下ろす", hint: "上下視線", visual: "style", video: "/scene-videos/motion-lookdown.webm" },
  { value: "フレーム侵入", hint: "入退場", visual: "style", video: "/scene-videos/motion-enter.webm" },
  { value: "フレーム退出", hint: "入退場", visual: "style", video: "/scene-videos/motion-exit.webm" },
  { value: "倒れる", hint: "落下・着地", visual: "style" },
  { value: "座る", hint: "落下・着地", visual: "style", video: "/scene-videos/motion-sit.webm" },
  { value: "跳ぶ", hint: "落下・着地", visual: "style", video: "/scene-videos/motion-jump.webm" },
  { value: "笑う", hint: "表情変化", visual: "style", video: "/scene-videos/motion-smile.webm" },
  { value: "泣く", hint: "表情変化", visual: "style", video: "/scene-videos/motion-cry.webm" },
  { value: "驚く", hint: "表情変化", visual: "style", video: "/scene-videos/motion-surprised.webm" },
];

export const lightingSourceOptions: SceneOption[] = [
  none,
  { value: "自然光", hint: "屋外・窓辺", visual: "light-natural" },
  { value: "スタジオ", hint: "制御された光", visual: "light-studio" },
  { value: "逆光", hint: "輪郭を強調", visual: "light-back" },
  { value: "夕暮れ", hint: "温かい低い光", visual: "light-blue-hour" },
  { value: "キャンドル", hint: "小さな暖色光", visual: "light-candle" },
  { value: "ネオン", hint: "色光・夜", visual: "light-blue-hour" },
  { value: "フラッシュ", hint: "瞬間的で硬い光", visual: "light-softbox" },
];

export const timeOfDayOptions: SceneOption[] = [
  none,
  { value: "朝", hint: "清潔・始まり", visual: "light-natural" },
  { value: "昼", hint: "明るく明瞭", visual: "light-natural" },
  { value: "夕", hint: "感情的・暖色", visual: "light-blue-hour" },
  { value: "夜", hint: "暗部と光源", visual: "light-back" },
  { value: "マジックアワー", hint: "映画的な薄明", visual: "light-blue-hour" },
];

export const weatherOptions: SceneOption[] = [
  none,
  { value: "晴れ", hint: "クリア", visual: "light-natural" },
  { value: "曇り", hint: "柔らかい拡散光", visual: "light-softbox" },
  { value: "雨", hint: "反射・湿度", visual: "light-back" },
  { value: "雪", hint: "白く静か", visual: "light-softbox" },
  { value: "霧", hint: "奥行き・ミステリアス", visual: "light-blue-hour" },
];

export const videoStyleOptions: SceneOption[] = [
  none,
  { value: "シネマティック", hint: "映画的な質感", visual: "style" },
  { value: "ドキュメンタリー", hint: "自然・観察的", visual: "style" },
  { value: "ミュージックビデオ", hint: "リズムと色", visual: "style" },
  { value: "CM", hint: "商品が映える", visual: "style" },
  { value: "雑誌", hint: "エディトリアル", visual: "style" },
  { value: "アニメ", hint: "線と色を強調", visual: "style" },
  { value: "フィルム", hint: "粒子と余韻", visual: "film-stock" },
  { value: "VHS", hint: "ローファイ映像", visual: "camera-retro" },
];

export const tempoOptions: SceneOption[] = [
  { value: "速め", hint: "短いカットで展開", visual: "none" },
  { value: "標準", hint: "自然なテンポ", visual: "none" },
  { value: "ゆっくり", hint: "余韻を残す", visual: "none" },
];

export const targetDurationOptions: SceneOption[] = [
  { value: "5秒", hint: "超短尺", visual: "aspect" },
  { value: "10秒", hint: "SNS向け", visual: "aspect" },
  { value: "15秒", hint: "標準ショート", visual: "aspect" },
  { value: "30秒", hint: "広告・物語", visual: "aspect" },
  { value: "カスタム", hint: "秒数を直接入力", visual: "aspect" },
];

export const cutDurationOptions: SceneOption[] = [
  { value: "自動", hint: "尺とテンポから自動", visual: "none" },
  { value: "1.5秒", hint: "かなり速い", visual: "none" },
  { value: "2秒", hint: "速め", visual: "none" },
  { value: "3秒", hint: "標準", visual: "none" },
  { value: "5秒", hint: "ゆっくり", visual: "none" },
];

// i2v再設計 (2026-05-29): 動きの強度。旧「テンポ」の置換。
// i2v では動作の速度・強度が品質を左右する (Codexクロスレビューより)。
// これは「被写体の動き」の強さ。カメラの移動速度=cameraSpeed とは別軸。
export const motionIntensityOptions: SceneOption[] = [
  none,
  { value: "ゆっくり", hint: "被写体が穏やかにゆっくり動く", visual: "none" },
  { value: "繊細に", hint: "被写体がごくわずかに動く", visual: "none" },
  { value: "標準", hint: "被写体が自然な速さで動く", visual: "none" },
  { value: "力強く", hint: "被写体が勢いよく動く", visual: "none" },
  { value: "速め", hint: "被写体が素早く動く", visual: "none" },
];

// i2v再設計 (2026-05-29): 環境の動き。背景の動きが i2v の品質感を作る。
export const environmentMotionOptions: SceneOption[] = [
  none,
  { value: "風で草が揺れる", hint: "草原・髪・布が揺れる", visual: "none" },
  { value: "煙が立ち込める", hint: "煙・湯気が漂う", visual: "none" },
  { value: "水面の反射", hint: "濡れた路面・水面の揺らぎ", visual: "none" },
  { value: "木の葉が舞う", hint: "落ち葉・花びらが舞う", visual: "none" },
  { value: "光が揺らぐ", hint: "炎・木漏れ日のちらつき", visual: "none" },
];
