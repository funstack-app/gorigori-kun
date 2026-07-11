/**
 * モーションクリップの移動速度(m/s)の解決。
 *
 * クリップ自体はその場再生(ルートモーションなし)のため、移動系クリップは
 * ここで決めた速度でパスに沿って平行移動させる。速度はクリップ割り当て時に
 * project データへ焼き込む(ライブラリ未ロードでも evaluateScene が決定論で動くように)。
 * 0 = その場再生(移動しない)。
 */

/** 同梱標準ライブラリ(Quaternius UAL)の移動系クリップ速度 */
const BUILTIN_SPEEDS: Record<string, number> = {
  Walk_Loop: 1.4,
  Walk_Formal_Loop: 1.2,
  Jog_Fwd_Loop: 2.4,
  Sprint_Loop: 4.6,
  Crouch_Fwd_Loop: 0.8,
  Swim_Fwd_Loop: 1.1,
};

/** インポートしたクリップ(Mixamo等)の名前からの推定。上から順に優先 */
const NAME_HEURISTICS: [RegExp, number][] = [
  [/sprint|dash|全力/i, 4.6],
  [/run|jog|走|ジョグ/i, 2.6],
  [/sneak|crouch|忍び|しゃがみ歩/i, 0.9],
  [/crawl|匍匐/i, 0.7],
  [/swim|泳/i, 1.1],
  [/walk|歩/i, 1.4],
];

/** クリップの移動速度(m/s)を返す。0 = その場再生 */
export function resolveClipSpeed(clipId: string, name?: string): number {
  if (clipId.startsWith("builtin-")) {
    return BUILTIN_SPEEDS[clipId.slice("builtin-".length)] ?? 0;
  }
  if (!name) return 0;
  for (const [re, speed] of NAME_HEURISTICS) {
    if (re.test(name)) return speed;
  }
  return 0;
}
