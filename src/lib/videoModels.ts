/**
 * P0-2 動画モデル静的定義 (2026-05-28)。
 *
 * 現在の位置づけ: モデル一覧の正本ではなく、実取得に失敗した時の明示フォールバックと、
 * models_explore に無い仕様を補う実測データ。通常表示は接続中アカウントの実取得一覧を使う。
 *
 * 新モデル追加時はこのファイルに定義を追加する。
 */

export type VideoModelId = "kling3_0" | "seedance_2_0" | "veo3_1";

/** i2v 入力フィールド名 (CLI に渡すフラグ名で識別) */
export type I2VInputField = "input_image" | "medias" | "input_images";

export type VideoModelParam =
  | { kind: "enum"; name: string; label: string; values: string[]; default: string }
  | { kind: "integer"; name: string; label: string; min: number; max: number; default: number }
  | { kind: "boolean"; name: string; label: string; default: boolean };

export type VideoDurationConstraint =
  | { kind: "enum"; values: number[]; default: number }
  | { kind: "integer"; default: number; min: number; max: number; step?: number };

/** 内蔵モデルと接続先モデルを同じ設定 UI で扱うための最小共通仕様。 */
export type VideoModelCapabilities = {
  /** null は未取得。空配列は対応値なし。 */
  duration: VideoDurationConstraint | null;
  /** null は未取得。空配列は対応値なし。 */
  aspectRatios: string[] | null;
  /** null は未取得。比較時はおすすめ値を使うため空配列に絞る。 */
  extraParams: VideoModelParam[] | null;
};

export type VideoModelDefinition = {
  id: VideoModelId;
  label: string;
  jobSetType: string;
  description: string;
  /** 利用可能な aspect_ratio (CLI の値そのまま) */
  aspectRatios: string[];
  defaultAspectRatio: string;
  /** duration の制約 */
  duration: VideoDurationConstraint;
  /** モデル固有パラメータ (mode/quality/resolution/sound/genre/model_variant 等) */
  extraParams: VideoModelParam[];
  /** i2v 入力フィールド名 (CLI フラグ名) */
  i2vInputField: I2VInputField;
  /** t2v / i2v / 両対応 */
  inputMode: "t2v" | "i2v" | "both";
  /** 1回の生成あたり概算クレジット (default param時) */
  costEstimate: number;
};

export const VIDEO_MODELS: VideoModelDefinition[] = [
  {
    id: "kling3_0",
    // 公式仕様 実測 (CLI 0.1.35, 2026-06-06): aspect[16:9,9:16,1:1] /
    // duration integer 2-10 / medias(i2v) / mode[pro,std,4k] / sound[on,off].
    label: "Kling 3.0",
    jobSetType: "kling3_0",
    description: "コスパ最強の定番。迷ったらこれ。",
    aspectRatios: ["16:9", "9:16", "1:1"],
    defaultAspectRatio: "16:9",
    duration: { kind: "integer", default: 5, min: 2, max: 10 },
    extraParams: [
      { kind: "enum", name: "mode", label: "モード", values: ["pro", "std", "4k"], default: "std" },
      { kind: "enum", name: "sound", label: "音声", values: ["on", "off"], default: "on" },
    ],
    i2vInputField: "medias",
    inputMode: "both",
    // 実測代表値: mode=std 2.0cr/秒。default duration=5 → 10cr。
    costEstimate: 10,
  },
  {
    id: "seedance_2_0",
    // 公式仕様 実測 (CLI 0.1.35, 2026-06-06): aspect 7種 / duration integer 2-15 /
    // medias(i2v) / genre 7種 / mode[std,fast] / resolution[480p,720p,1080p]。
    label: "Seedance 2.0",
    jobSetType: "seedance_2_0",
    description: "対応比率が最も多く、長めの動画やジャンル・解像度の調整に強い。",
    aspectRatios: ["auto", "16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
    defaultAspectRatio: "16:9",
    // CLI 実測 (2026-06-06): duration=15 まで通る (15秒=67.5cr)。SHOTLIST も15秒前提。
    duration: { kind: "integer", default: 5, min: 2, max: 15 },
    extraParams: [
      {
        kind: "enum",
        name: "genre",
        label: "ジャンル",
        values: ["auto", "action", "horror", "comedy", "noir", "drama", "epic"],
        default: "auto",
      },
      { kind: "enum", name: "mode", label: "モード", values: ["std", "fast"], default: "std" },
      {
        kind: "enum",
        name: "resolution",
        label: "解像度",
        values: ["480p", "720p", "1080p"],
        default: "720p",
      },
    ],
    i2vInputField: "medias",
    inputMode: "both",
    // 実測代表値: resolution=720p mode=std 4.5cr/秒。default duration=5 → 22.5cr (表示 22)。
    costEstimate: 22,
  },
  {
    id: "veo3_1",
    // 公式仕様 実測 (CLI 0.1.35, 2026-06-06): aspect[16:9,9:16] (1:1 なし) /
    // duration string enum["4","6","8"] default "8" / input_image(i2v, object) /
    // model[veo-3-1-preview,veo-3-1-fast] / quality[basic,high,ultra]。
    label: "Google Veo 3.1",
    jobSetType: "veo3_1",
    description: "Google品質。クオリティ重視の生成向けで、品質を3段階から選べる。",
    aspectRatios: ["16:9", "9:16"],
    defaultAspectRatio: "16:9",
    // 実測修正 (2026-06-06): API spec は string enum ["4","6","8"] default "8"。
    // 旧 [8] 固定はバグ。UI/store は number 表現で保持し、CLI へは --duration <秒> で渡す。
    duration: { kind: "enum", values: [4, 6, 8], default: 8 },
    extraParams: [
      {
        kind: "enum",
        name: "model",
        label: "モデル variant",
        values: ["veo-3-1-preview", "veo-3-1-fast"],
        default: "veo-3-1-fast",
      },
      { kind: "enum", name: "quality", label: "品質", values: ["basic", "high", "ultra"], default: "basic" },
    ],
    i2vInputField: "input_image",
    inputMode: "both",
    // 実測代表値: fast basic/high 8s=22 (4s=11, 6s=16.5)。
    costEstimate: 22,
  },
];

export function findVideoModel(id: VideoModelId | string): VideoModelDefinition | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** 実取得した HiggsField の job_set_type と実測補完データを結び付ける。 */
export function findVideoModelByJobSetType(
  jobSetType: string,
): VideoModelDefinition | undefined {
  return VIDEO_MODELS.find(
    (model) => model.jobSetType === jobSetType || model.id === jobSetType,
  );
}

/**
 * 尺 (秒) をモデルの制約に丸める。
 *
 * uy6 (2026-08-03): videoGen ストアの私的関数だったものを正本としてここへ移した。
 * ストーリー動画キューは絵コンテの尺 (2.5 秒等) をカットごとにモデル制約へ
 * 丸める必要があり、ストアの外から同じ規則を使えないと丸め方が二重定義になるため。
 *
 * enum duration (veo3_1 の 4/6/8) は **最近傍の許容値** を選ぶ。旧実装は
 * 「許容値に含まれなければ default」だったため、絵コンテの 2.5 秒カットが
 * 8 秒 (default) へ飛んでいた。同値距離のときはより短い方を採る
 * (総尺が絵コンテより伸びる側に倒さない)。
 */
export function clampDurationForModel(id: VideoModelId, value: number): number {
  const model = findVideoModel(id);
  if (!model) return Math.max(1, Math.round(value));
  if (model.duration.kind === "enum") {
    const values = model.duration.values;
    if (values.length === 0) return model.duration.default;
    if (values.includes(value)) return value;
    let best = values[0];
    for (const candidate of values) {
      const d = Math.abs(candidate - value);
      const bestD = Math.abs(best - value);
      // 同値距離は短い方を採用する
      if (d < bestD || (d === bestD && candidate < best)) best = candidate;
    }
    return best;
  }
  const rounded = Math.round(value);
  return Math.min(model.duration.max, Math.max(model.duration.min, rounded));
}

/** モデルが対応する比率に収まらなければモデルのデフォルト比率へ寄せる */
export function clampAspectForModel(id: VideoModelId, value: string): string {
  const model = findVideoModel(id);
  if (!model) return value;
  return model.aspectRatios.includes(value) ? value : model.defaultAspectRatio;
}

/**
 * 全動画モデルが対応する aspect_ratio の和集合 (表示順を保った重複なしリスト)。
 *
 * アスペクト比セレクタで「未対応の比率もグレーアウトして見せる」ために使う。
 * 各モデルの aspectRatios は "公式仕様 実測" (VIDEO_MODELS 定義のコメント参照) が正で、
 * どの比率がどのモデルで使えるかはこの和集合と model.aspectRatios の差分で決まる。
 *
 * 表示順は「代表的な横長 → 縦長 → 特殊」の直感順になるよう、seedance_2_0 (7種) の
 * 並びを基準に、他モデルにしか無い値があれば末尾へ足す。現状は seedance_2_0 が
 * 全比率を包含する (auto/16:9/9:16/4:3/3:4/1:1/21:9) ため差分は生じないが、
 * 将来モデル追加で新比率が来ても取りこぼさない。
 */
export const ALL_VIDEO_ASPECT_RATIOS: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of VIDEO_MODELS) {
    for (const ratio of model.aspectRatios) {
      if (seen.has(ratio)) continue;
      seen.add(ratio);
      out.push(ratio);
    }
  }
  return out;
})();

/** モデルがその比率に対応しているか。未対応ならセレクタで disabled 表示する。 */
export function modelSupportsAspect(model: VideoModelDefinition, ratio: string): boolean {
  return model.aspectRatios.includes(ratio);
}

/** 内蔵モデルの定義を、統一設定 UI 用の仕様へ変換する。 */
export function videoModelCapabilities(
  model: VideoModelDefinition,
): VideoModelCapabilities {
  return {
    duration: model.duration,
    aspectRatios: [...model.aspectRatios],
    extraParams: [...model.extraParams],
  };
}

/**
 * 尺の制約を、画面で実際に選べる秒数へ展開する。
 * integer は step 未指定なら1秒刻み。壊れた範囲は空配列にして偽の値を作らない。
 */
export function durationValuesForConstraint(
  constraint: VideoDurationConstraint,
): number[] {
  if (constraint.kind === "enum") {
    return [...new Set(constraint.values)]
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
  }
  const step = constraint.step ?? 1;
  if (
    !Number.isFinite(constraint.min) ||
    !Number.isFinite(constraint.max) ||
    !Number.isFinite(step) ||
    step <= 0 ||
    constraint.max < constraint.min
  ) {
    return [];
  }
  const values: number[] = [];
  // 外部 schema の異常値で UI を固めないため、最大300候補で止める。
  for (let value = constraint.min; value <= constraint.max && values.length < 300; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
}

/** 仕様を取得できないモデルでだけ使う、明示された汎用候補。 */
export const GENERIC_VIDEO_DURATION_VALUES = Array.from(
  { length: 14 },
  (_, index) => index + 2,
);

export function durationValuesForConstraintOrGeneric(
  constraint: VideoDurationConstraint | null,
): number[] {
  return constraint
    ? durationValuesForConstraint(constraint)
    : [...GENERIC_VIDEO_DURATION_VALUES];
}

/**
 * 選択中モデルすべてが使える設定だけを返す。
 * 1件でも仕様未取得なら、その項目は null のままにして汎用 UI + 注意書きへ回す。
 */
export function intersectVideoModelCapabilities(
  capabilities: readonly VideoModelCapabilities[],
): VideoModelCapabilities {
  if (capabilities.length === 0) {
    return { duration: null, aspectRatios: null, extraParams: null };
  }

  const duration = capabilities.some((item) => item.duration === null)
    ? null
    : (() => {
        const lists = capabilities.map((item) =>
          durationValuesForConstraint(item.duration as VideoDurationConstraint),
        );
        const common = lists[0].filter((value) =>
          lists.slice(1).every((values) => values.includes(value)),
        );
        const target = capabilities[0].duration?.default ?? common[0] ?? 1;
        const preferred = common.reduce(
          (best, value) => {
            const distance = Math.abs(value - target);
            const bestDistance = Math.abs(best - target);
            return distance < bestDistance || (distance === bestDistance && value < best)
              ? value
              : best;
          },
          common[0] ?? 1,
        );
        return { kind: "enum" as const, values: common, default: preferred };
      })();

  const aspectRatios = capabilities.some((item) => item.aspectRatios === null)
    ? null
    : (capabilities[0].aspectRatios ?? []).filter((ratio) =>
        capabilities.slice(1).every((item) => item.aspectRatios?.includes(ratio)),
      );

  return {
    duration,
    aspectRatios,
    // 比較生成はモデル固有項目を各モデルのおすすめ値へ任せる。
    extraParams:
      capabilities.length === 1
        ? capabilities[0].extraParams === null
          ? null
          : [...capabilities[0].extraParams]
        : [],
  };
}

/**
 * 6cn (B-7 追補): モデルの対応状況を UI 表示用に決定論で導出する。
 * 手書き description に仕様値を書かない (定義とズレて嘘になるため)。
 */
export function videoModelSpecItems(
  model: VideoModelDefinition,
): { label: string; value: string }[] {
  const i2v =
    model.inputMode === "both"
      ? "対応（画像なしでも生成可）"
      : model.inputMode === "i2v"
        ? "対応（元画像が必要）"
        : "未対応（テキストのみ）";
  const ratios = model.aspectRatios.map((r) => (r === "auto" ? "自動" : r)).join(" / ");
  const duration =
    model.duration.kind === "enum"
      ? `${model.duration.values.join(" / ")}秒`
      : `${model.duration.min}〜${model.duration.max}秒`;
  return [
    { label: "画像から動画", value: i2v },
    { label: "対応比率", value: ratios },
    { label: "尺", value: duration },
  ];
}
