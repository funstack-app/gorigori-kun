/**
 * 「素材を重ねる」の右パネル。
 *
 * やることは1つ (画像を1枚選ぶ) で、選び先が2つある:
 *   - PCから選ぶ    … OS のファイル選択 (アプリの外にある画像)
 *   - ライブラリから選ぶ … アプリの中で作った/保存した画像
 * この2つは「どこを探すか」が違うだけなので、道具を分けずに1つのパネルへ並べる。
 *
 * 選んだあとの操作 (動かす・大きさを変える) はキャンバス側の仕事なので、
 * ここには何も置かない。置いた瞬間に「選択・移動」へ戻る動線を呼び出し側が持つ。
 */

type PlaceImagePanelProps = {
  onPickFromDisk: () => void;
  onPickFromLibrary: () => void;
  busy: boolean;
};

export function PlaceImagePanel({
  onPickFromDisk,
  onPickFromLibrary,
  busy,
}: PlaceImagePanelProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      <h3 className="text-xs font-black text-white">素材を重ねる</h3>
      <p className="mt-1 text-[10px] font-bold leading-4 text-neutral-500">
        ロゴ・キャラクター・小物などを、この画像の上に置きます。
      </p>

      <button
        type="button"
        onClick={onPickFromDisk}
        disabled={busy}
        className="mt-3 h-10 w-full rounded-lg bg-pink-500 text-xs font-black text-white hover:bg-pink-600 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
      >
        PCから選ぶ
      </button>
      <button
        type="button"
        onClick={onPickFromLibrary}
        disabled={busy}
        className="mt-2 h-10 w-full rounded-lg border border-[#3a3a3a] bg-[#1a1a1a] text-xs font-black text-neutral-200 hover:border-pink-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        ライブラリから選ぶ
      </button>

      <div className="mt-4 rounded-lg border border-[#333] bg-[#1c1c1c] p-2.5">
        <p className="text-[10px] font-black text-neutral-400">置いたあと</p>
        <ul className="mt-1.5 space-y-1 text-[10px] font-bold leading-4 text-neutral-500">
          <li>・そのままドラッグで動かせます</li>
          <li>・四隅をつまんで大きさを変えられます</li>
          <li>・上のつまみで回せます</li>
          <li>・気に入らなければ「戻す」で消えます</li>
        </ul>
      </div>
    </div>
  );
}

export default PlaceImagePanel;
