import { useState } from "react";

import {
  BUILT_IN_SHEET_TEMPLATES,
  IDENTITY_5VIEW_PROMPT_TEMPLATE,
  type UserSheetTemplate,
} from "../../../lib/character/sheetTemplates";
import { usePresets } from "../../../lib/store/presets";
import { useToasts } from "../../../lib/store/toasts";

type Props = {
  selectedId: string;
  onSelect: (template: { id: string; name: string; prompt: string | null }) => void;
  onClose: () => void;
};

function sampleSrc(id: string): string {
  return `/sheet-samples/${id}.png`;
}

export function SheetTemplatePickerModal({ selectedId, onSelect, onClose }: Props) {
  const sheetTemplates = usePresets((s) => s.sheetTemplates);
  const addSheetTemplate = usePresets((s) => s.addSheetTemplate);
  const removeSheetTemplate = usePresets((s) => s.removeSheetTemplate);
  const pushToast = useToasts((s) => s.push);
  const [brokenSamples, setBrokenSamples] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templatePrompt, setTemplatePrompt] = useState(IDENTITY_5VIEW_PROMPT_TEMPLATE);

  function selectTemplate(template: { id: string; name: string; prompt: string | null }) {
    onSelect(template);
    onClose();
  }

  function saveTemplate() {
    const name = templateName.trim();
    const prompt = templatePrompt.trim();
    if (!name || !prompt) {
      pushToast({
        kind: "info",
        text: "テンプレート名とプロンプトを両方入力してください。",
        ttlMs: 3500,
      });
      return;
    }
    const saved = addSheetTemplate({ name, prompt });
    pushToast({
      kind: "success",
      text: `テンプレート「${saved.name}」を保存しました。`,
      ttlMs: 3000,
    });
    selectTemplate(saved);
  }

  function deleteTemplate(template: UserSheetTemplate) {
    if (!window.confirm(`テンプレート「${template.name}」を削除しますか？`)) return;
    removeSheetTemplate(template.id);
    if (selectedId === template.id) {
      onSelect(BUILT_IN_SHEET_TEMPLATES[0]);
    }
    pushToast({
      kind: "success",
      text: `テンプレート「${template.name}」を削除しました。`,
      ttlMs: 3000,
    });
  }

  const cards = [
    ...BUILT_IN_SHEET_TEMPLATES,
    ...sheetTemplates.map((template) => ({
      ...template,
      description: template.name,
    })),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#242424] px-5 py-4">
          <div>
            <h2 className="text-base font-black text-white">
              {creating ? "新しいテンプレートを作る" : "シートの種類を選ぶ"}
            </h2>
            <p className="mt-0.5 text-[11px] text-neutral-400">
              {creating
                ? "名前と、画像生成へ渡すプロンプト全文を保存します。"
                : "見本から、今回作るキャラクターシートを1つ選びます。"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#343434] px-3 py-1.5 text-[12px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
          >
            閉じる
          </button>
        </div>

        {creating ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-neutral-500">
                テンプレート名
              </span>
              <input
                type="text"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="例: アニメ用3面図"
                className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 text-[13px] text-neutral-200 placeholder:text-neutral-600 focus:border-pink-400/60 focus:outline-none"
              />
            </label>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-neutral-500">
                シート生成プロンプト
              </span>
              <textarea
                value={templatePrompt}
                onChange={(event) => setTemplatePrompt(event.target.value)}
                rows={20}
                className="w-full resize-y rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-200 focus:border-pink-400/60 focus:outline-none"
              />
            </label>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-neutral-600">
                首なし5面図の全文を雛形として入れています。必要な部分を書き換えて保存できます。
              </p>
              <button
                type="button"
                onClick={() => setTemplatePrompt(IDENTITY_5VIEW_PROMPT_TEMPLATE)}
                className="rounded-lg border border-[#343434] px-3 py-1.5 text-[11px] font-bold text-neutral-300 hover:border-pink-400 hover:text-white"
              >
                首なし5面図の雛形へ戻す
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {cards.map((template) => {
                const selected = selectedId === template.id;
                const broken = brokenSamples.has(template.id);
                const userTemplate = !BUILT_IN_SHEET_TEMPLATES.some(
                  (builtIn) => builtIn.id === template.id,
                );
                return (
                  <div
                    key={template.id}
                    className={`relative overflow-hidden rounded-xl border transition ${
                      selected
                        ? "border-pink-400 ring-2 ring-pink-400/50"
                        : "border-[#2a2a2a] hover:border-pink-400/60"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => selectTemplate(template)}
                      className="flex h-full w-full flex-col text-left"
                    >
                      <div className="relative aspect-video w-full bg-black">
                        {!broken ? (
                          <img
                            src={sampleSrc(template.id)}
                            alt={`${template.name}の見本`}
                            className="h-full w-full object-contain"
                            onError={() =>
                              setBrokenSamples((previous) =>
                                new Set(previous).add(template.id),
                              )
                            }
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center px-2 text-center text-[10px] text-neutral-600">
                            見本準備中
                          </div>
                        )}
                        {selected && (
                          <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-pink-500 text-[12px] font-black text-white">
                            ✓
                          </div>
                        )}
                      </div>
                      <div className="flex-1 px-3 py-2.5">
                        <div className="text-[12px] font-black text-neutral-100">
                          {template.name}
                        </div>
                        <div className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                          {template.description}
                        </div>
                      </div>
                    </button>
                    {userTemplate && (
                      <button
                        type="button"
                        onClick={() => deleteTemplate(template as UserSheetTemplate)}
                        className="absolute bottom-2 right-2 rounded border border-red-500/30 bg-[#161616]/90 px-2 py-1 text-[9px] font-bold text-red-300 hover:bg-red-500/15"
                      >
                        削除
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-[#242424] px-5 py-4">
          {creating ? (
            <>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-xl border border-[#343434] px-4 py-2.5 text-[12px] font-bold text-neutral-300 hover:border-neutral-500 hover:text-white"
              >
                一覧へ戻る
              </button>
              <button
                type="button"
                onClick={saveTemplate}
                className="rounded-xl bg-pink-500 px-5 py-2.5 text-[13px] font-black text-white hover:bg-pink-400"
              >
                保存して選ぶ
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-xl bg-pink-500 px-5 py-2.5 text-[13px] font-black text-white hover:bg-pink-400"
            >
              ＋ 新しいテンプレートを作る
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
