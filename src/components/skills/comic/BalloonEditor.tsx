/**
 * 吹き出し・擬音の編集行（ネーム確認とページ編集のインスペクタで共用）。
 *
 * 更新はすべて呼び出し側の updatePanel を通す（新規経路を作らない）。
 * 1行 = 1吹き出し / 1擬音。どちらも最大2個（漫画の1コマに入る量の上限）。
 */

import { SFX_INTENT } from "../../../lib/comic/balloonLayout";
import type {
  ComicBalloon,
  ComicBalloonKind,
  ComicSfx,
  ComicSfxIntent,
} from "../../../lib/comic/types";

/** kind select の表示ラベル（値は kind 英字）。 */
const KIND_OPTIONS: Array<{ value: ComicBalloonKind; label: string }> = [
  { value: "normal", label: "通常" },
  { value: "shout", label: "叫び" },
  { value: "monologue", label: "心の声" },
  { value: "narration", label: "ナレーション" },
];

/** intent select の表示ラベル（値は intent 英字）。 */
const INTENT_OPTIONS: Array<{ value: ComicSfxIntent; label: string }> = [
  { value: "impact", label: "衝撃" },
  { value: "motion", label: "動き" },
  { value: "quiet", label: "静寂" },
  { value: "emotion", label: "感情" },
];

const INPUT_CLASS =
  "rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-100 focus:border-pink-500/50 focus:outline-none";

/** 吹き出しの追加時の初期値。 */
export function newBalloon(): ComicBalloon {
  return {
    id: crypto.randomUUID(),
    speaker: "",
    text: "",
    kind: "normal",
    pos: null,
    visible: true,
  };
}

/** 擬音の追加時の初期値（rotation / scale は intent 表から採る）。 */
export function newSfx(): ComicSfx {
  return {
    id: crypto.randomUUID(),
    text: "",
    intent: "motion",
    pos: null,
    rotation: SFX_INTENT.motion.rotation,
    scale: SFX_INTENT.motion.scale,
    visible: true,
  };
}

export function BalloonEditor({
  balloons,
  onChange,
}: {
  balloons: ComicBalloon[];
  onChange: (next: ComicBalloon[]) => void;
}) {
  const update = (id: string, patch: Partial<ComicBalloon>) => {
    onChange(balloons.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };
  const remove = (id: string) => {
    onChange(balloons.filter((b) => b.id !== id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="block text-[11px] font-medium text-neutral-500">
        吹き出し（最大2個・話す順）
      </span>
      {balloons.map((balloon) => (
        <div key={balloon.id} className="flex items-center gap-1.5">
          <select
            value={balloon.kind}
            onChange={(e) =>
              update(balloon.id, { kind: e.target.value as ComicBalloonKind })
            }
            className={INPUT_CLASS}
            aria-label="吹き出しの種類"
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            value={balloon.speaker}
            onChange={(e) => update(balloon.id, { speaker: e.target.value })}
            placeholder="話者"
            className={`w-24 shrink-0 ${INPUT_CLASS}`}
            aria-label="話者"
          />
          <input
            value={balloon.text}
            onChange={(e) => update(balloon.id, { text: e.target.value })}
            className={`min-w-0 flex-1 ${INPUT_CLASS}`}
            aria-label="セリフ"
          />
          <button
            type="button"
            onClick={() => remove(balloon.id)}
            className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
            title="吹き出しを削除"
            aria-label="吹き出しを削除"
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...balloons, newBalloon()])}
          disabled={balloons.length >= 2}
          className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋吹き出しを追加
        </button>
      </div>
    </div>
  );
}

/**
 * 擬音の編集行。
 *
 * intent を変えたら rotation / scale も intent 表の値へ揃える。
 * 手で回転・倍率をいじる UI は v1 では出さない（型は保持済み）ので、
 * ここで揃えないと「静寂にしたのに大きく傾いたまま」という不一致が残る。
 */
export function SfxEditor({
  sfx,
  onChange,
}: {
  sfx: ComicSfx[];
  onChange: (next: ComicSfx[]) => void;
}) {
  const update = (id: string, patch: Partial<ComicSfx>) => {
    onChange(sfx.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };
  const remove = (id: string) => {
    onChange(sfx.filter((s) => s.id !== id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="block text-[11px] font-medium text-neutral-500">
        擬音（最大2個）
      </span>
      {sfx.map((item) => (
        <div key={item.id} className="flex items-center gap-1.5">
          <input
            value={item.text}
            onChange={(e) => update(item.id, { text: e.target.value })}
            placeholder="擬音（例: ガタッ）"
            className={`min-w-0 flex-1 ${INPUT_CLASS}`}
            aria-label="擬音"
          />
          <select
            value={item.intent}
            onChange={(e) => {
              const intent = e.target.value as ComicSfxIntent;
              update(item.id, {
                intent,
                rotation: SFX_INTENT[intent].rotation,
                scale: SFX_INTENT[intent].scale,
              });
            }}
            className={INPUT_CLASS}
            aria-label="擬音の種類"
          >
            {INTENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => remove(item.id)}
            className="rounded px-1 text-neutral-500 transition hover:text-rose-400"
            title="擬音を削除"
            aria-label="擬音を削除"
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => onChange([...sfx, newSfx()])}
          disabled={sfx.length >= 2}
          className="rounded border border-[#2a2a2a] bg-[#1a1a1a] px-2 py-1 text-[11px] font-medium text-neutral-300 transition hover:border-pink-500/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          ＋擬音を追加
        </button>
      </div>
    </div>
  );
}
