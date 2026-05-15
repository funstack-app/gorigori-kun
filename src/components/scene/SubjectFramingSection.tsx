import type { ChangeEvent } from "react";
import { compositionOptions } from "../../lib/scene/catalog";
import { useSceneStore } from "../../lib/store/scene";
import { OptionPickerButton } from "./OptionPickerButton";

export function SubjectFramingSection() {
  const subject = useSceneStore((state) => state.subjectFraming.subject);
  const composition = useSceneStore((state) => state.subjectFraming.composition);
  const environment = useSceneStore((state) => state.subjectFraming.environment);
  const setSubjectFramingField = useSceneStore((state) => state.setSubjectFramingField);

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

      <OptionPickerButton
        label="構図"
        options={compositionOptions}
        value={composition}
        onPick={(value) => setSubjectFramingField("composition", value)}
        modalTitle="構図を選ぶ"
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
