import type { ChangeEvent } from "react";
import { compositionOptionsFor, shotOptions } from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { OptionPickerButton } from "./OptionPickerButton";

export function SubjectFramingSection() {
  const subject = useSceneStore((state) => state.subjectFraming.subject);
  const composition = useSceneStore((state) => state.subjectFraming.composition);
  const cameraAngle = useSceneStore((state) => state.subjectFraming.cameraAngle);
  const framing = useSceneStore((state) => state.subjectFraming.framing);
  const environment = useSceneStore((state) => state.subjectFraming.environment);
  const setSubjectFramingField = useSceneStore((state) => state.setSubjectFramingField);
  // ショット幅は保存先が camera.focalLength のまま (表示位置だけをここへ移した)
  const focalLength = useSceneStore((state) => state.camera.focalLength);
  const setCameraField = useSceneStore((state) => state.setCameraField);

  const onSubjectChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSubjectFramingField("subject", event.target.value);
  };

  const onEnvironmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSubjectFramingField("environment", event.target.value);
  };

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">主役</span>
        <input
          value={subject}
          onChange={onSubjectChange}
          placeholder="例: 30代女性、青いジャケット"
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
        />
      </label>

      {/*
        2026-07-27: 旧「構図」(34件を1つの一覧から1つだけ選ぶ形) を役割で4つに割った。
        以前は「胸上まで寄って・下から見上げて・左に寄せる」という実際の撮影で普通に
        併用する指定が、1つのフィールドを奪い合うため同時にできなかった (STΛCK 指摘)。
        4つは互いに独立していて、すべて「指定なし」のままにもできる。
      */}
      <OptionPickerButton
        label="どこまで写す"
        options={compositionOptionsFor("distance")}
        value={composition}
        onPick={(value) => setSubjectFramingField("composition", value)}
        modalTitle="どこまで写すかを選ぶ"
      />

      <OptionPickerButton
        label="どこから撮る"
        options={compositionOptionsFor("angle")}
        value={cameraAngle}
        onPick={(value) => setSubjectFramingField("cameraAngle", value)}
        modalTitle="どこから撮るかを選ぶ"
      />

      <OptionPickerButton
        label="どう見せる"
        options={compositionOptionsFor("framing")}
        value={framing}
        onPick={(value) => setSubjectFramingField("framing", value)}
        modalTitle="どう見せるかを選ぶ"
      />

      {/*
        「ショット幅」を「カメラ」からここへ移設。レンズが決めるのは機材ではなく
        背景の見え方 (広角=周りが広く入る / 望遠=背景が壁のように迫る) なので、
        構図と同じ場所で選べる方が迷わない。
        保存先は camera.focalLength のまま。
      */}
      <OptionPickerButton
        label="背景の見え方（レンズ）"
        options={shotOptions}
        value={focalLength}
        onPick={(value) => setCameraField("focalLength", value)}
        modalTitle="背景の見え方を選ぶ"
      />

      {/*
        アスペクト比はシーン構築の見た目要素ではなく「生成パラメータ」なので、
        右ペインの ConstructedPromptPanel (生成枚数の隣) に移動した (2026-05-12)。
        store には subjectFraming.aspectRatio のまま残し、ここでは UI を出さない。
      */}

      <label className="block">
        <span className="mb-1.5 block text-xs font-semibold text-neutral-300">環境</span>
        <input
          value={environment}
          onChange={onEnvironmentChange}
          placeholder="例: 雨のロンドンのバス停"
          className="w-full rounded-md border border-[#343434] bg-[#101010] px-3 py-2 text-sm text-white placeholder:text-neutral-600 outline-none transition focus:border-pink-500"
        />
      </label>
    </div>
  );
}
