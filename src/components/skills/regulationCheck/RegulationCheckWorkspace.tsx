import { useEffect, useMemo, useState } from "react";

import { ActiveProjectSelector } from "../../ActiveProjectSelector";
import { WorkspaceTabs } from "../../WorkspaceTabs";
import { SafeImage } from "../../SafeImage";
import { SceneCompactCard } from "../../scene/SceneCompactCard";
import { SceneSectionModal } from "../../scene/SceneSectionModal";
import { useToasts } from "../../../lib/store/toasts";
import {
  useRegulationCheckRun,
  type PendingRegulationRecheck,
  type RegulationCheckResultsState,
  type RegulationRuleSetSnapshot,
} from "../../../lib/store/regulationCheckRun";
import { useRegulationRules } from "../../../lib/store/regulationRules";
import { openRedlineWithImage } from "../../../lib/regulation/openRedlineWithImage";
import {
  createPendingRegulationRecheck,
  replaceImageForRecheck,
  selectFrozenRecheckRules,
  type RegulationRecheckRuleSelection,
} from "../../../lib/regulation/recheck";
import {
  checkImage,
  formatResultsAsText,
  runMachineChecks,
  type RegulationImageResult,
} from "../../../lib/regulationCheck/check";
import type {
  MachineCheckResult,
  MachineCheckStatus,
} from "../../../lib/regulationCheck/imageSpecs";
import {
  DEFAULT_RULE_SETS,
  findRule,
  resolveRules,
  type RegulationRuleSet,
  type RegulationRuleKind,
  type RegulationSeverity,
} from "../../../lib/regulationCheck/rules";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

type RecheckRunOptions = RegulationRecheckRuleSelection & {
  pendingImagePath: string;
};

const SEVERITY_STYLE: Record<
  RegulationSeverity,
  { label: string; className: string }
> = {
  high: { label: "重大", className: "bg-red-500/15 text-red-300 border-red-500/40" },
  mid: { label: "要修正", className: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  low: { label: "軽微", className: "bg-sky-500/15 text-sky-300 border-sky-500/40" },
};

const RULE_KIND_LABEL: Record<RegulationRuleKind, string> = {
  machine: "機械チェック",
  ai: "AI判定",
  legal: "法務注意",
};

const MACHINE_STATUS_STYLE: Record<
  MachineCheckStatus,
  { label: string; className: string }
> = {
  pass: { label: "合格", className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
  fail: { label: "不合格", className: "bg-red-500/15 text-red-300 border-red-500/40" },
  warning: { label: "注意", className: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  "not-checked": { label: "未判定", className: "bg-neutral-500/15 text-neutral-400 border-neutral-500/40" },
};

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function fileTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

function formatReportAsMarkdown(state: RegulationCheckResultsState): string {
  const lines = [
    "# レギュレーション検査レポート",
    "",
    `- ルールセット: ${state.ruleSet.name}`,
    `- ルールセットID: ${state.ruleSet.id}`,
    "",
    "## 適用ルール",
  ];

  for (const rule of state.ruleSet.rules) {
    const metadata = [
      `種別: ${RULE_KIND_LABEL[rule.kind ?? "ai"]}`,
      rule.sourceUrl ? `出典: ${rule.sourceUrl}` : null,
      rule.checkedAt ? `確認日: ${rule.checkedAt}` : null,
      rule.confidence ? `確度: ${rule.confidence}` : null,
    ].filter((item): item is string => Boolean(item));
    lines.push("", `### ${rule.name}`, "", ...metadata.map((item) => `- ${item}`), "", rule.criteria);
  }

  lines.push(
    "",
    "## 検査結果",
    "",
    formatResultsAsText(state.results, state.ruleSet.rules),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * レギュレーション検査 Workspace（スキル一覧v2.1 #11・MVP実装）
 *
 * 入稿画像を複数選択し、媒体プリセット（+自由記述ルール）で Codex 検査する。
 * Codex は画像を実入力（codex_describe_image）してから、ルール照合で根拠付き issue を返す。
 * SkillWorkspaceRouter が activeUiMode === "regulationCheck" のとき本コンポーネントを描画する。
 */
export function RegulationCheckWorkspace() {
  const pushToast = useToasts((s) => s.push);

  const imagePaths = useRegulationCheckRun((s) => s.imagePaths);
  const setImagePaths = useRegulationCheckRun((s) => s.setImagePaths);
  const ruleSetId = useRegulationCheckRun((s) => s.ruleSetId);
  const setRuleSetId = useRegulationCheckRun((s) => s.setRuleSetId);
  const pendingRechecks = useRegulationCheckRun((s) => s.pendingRechecks);
  const queuePendingRecheck = useRegulationCheckRun((s) => s.queuePendingRecheck);
  const removeImageFromRun = useRegulationCheckRun((s) => s.removeImage);
  const clearImages = useRegulationCheckRun((s) => s.clearImages);
  const retargetPendingRecheck = useRegulationCheckRun((s) => s.retargetPendingRecheck);
  const completePendingRecheck = useRegulationCheckRun((s) => s.completePendingRecheck);
  const customRule = useRegulationRules((s) => s.draft?.customRule ?? "");
  const savedRules = useRegulationRules((s) => s.savedRules);
  const hydrateRules = useRegulationRules((s) => s.hydrate);
  const setRuleDraft = useRegulationRules((s) => s.setDraft);
  const saveRule = useRegulationRules((s) => s.saveRule);
  const applyRule = useRegulationRules((s) => s.applyRule);
  const deleteRule = useRegulationRules((s) => s.deleteRule);
  const [savedRuleName, setSavedRuleName] = useState("");
  const [open, setOpen] = useState(false);
  const running = useRegulationCheckRun((s) => s.running);
  const setRunning = useRegulationCheckRun((s) => s.setRunning);
  const resultState = useRegulationCheckRun((s) => s.resultState);
  const setResultState = useRegulationCheckRun((s) => s.setResultState);
  const beginRun = useRegulationCheckRun((s) => s.beginRun);
  const invalidateRun = useRegulationCheckRun((s) => s.invalidateRun);
  const isCurrentRun = useRegulationCheckRun((s) => s.isCurrentRun);

  const ruleSet: RegulationRuleSet = useMemo(
    () => DEFAULT_RULE_SETS.find((r) => r.id === ruleSetId) ?? DEFAULT_RULE_SETS[0],
    [ruleSetId],
  );
  const activeRules = useMemo(
    () => resolveRules(ruleSet, customRule),
    [ruleSet, customRule],
  );

  const canRun = imagePaths.length > 0 && !running;
  const results = resultState?.results ?? [];
  const resultRules = resultState?.ruleSet.rules ?? [];

  useEffect(() => {
    let disposed = false;
    const initialRuleSetId = useRegulationCheckRun.getState().ruleSetId;
    const hadDraft = useRegulationRules.getState().draft !== null;

    void hydrateRules().then(() => {
      if (disposed) return;
      const rulesState = useRegulationRules.getState();
      const runState = useRegulationCheckRun.getState();
      const draft = rulesState.draft;
      if (!draft) {
        rulesState.setDraft(runState.ruleSetId, "");
        return;
      }

      // 初期値のままなら保存済み媒体を復元する。読込中や再表示前の選択は潰さない。
      if (
        !hadDraft &&
        runState.ruleSetId === initialRuleSetId &&
        initialRuleSetId === DEFAULT_RULE_SETS[0].id
      ) {
        runState.setRuleSetId(draft.ruleSetId);
      } else if (runState.ruleSetId !== draft.ruleSetId) {
        rulesState.setDraft(runState.ruleSetId, draft.customRule);
      }
    });

    return () => {
      disposed = true;
    };
  }, [hydrateRules]);

  function changeRuleSet(nextRuleSetId: string) {
    setRuleSetId(nextRuleSetId);
    setRuleDraft(nextRuleSetId, customRule);
  }

  function changeCustomRule(nextCustomRule: string) {
    setRuleDraft(ruleSetId, nextCustomRule);
  }

  async function saveCurrentRule() {
    setRuleDraft(ruleSetId, customRule);
    const saved = await saveRule(savedRuleName);
    if (!saved) {
      pushToast({ kind: "error", text: "ルールを保存できませんでした。", ttlMs: 4000 });
      return;
    }
    setSavedRuleName("");
    pushToast({ kind: "success", text: `「${saved.name}」を保存しました。`, ttlMs: 2500 });
  }

  function applySavedRule(id: string) {
    const saved = applyRule(id);
    if (!saved) return;
    setRuleSetId(saved.ruleSetId);
    pushToast({ kind: "success", text: `「${saved.name}」を適用しました。`, ttlMs: 2500 });
  }

  async function removeSavedRule(id: string) {
    const removed = await deleteRule(id);
    pushToast({
      kind: removed ? "success" : "error",
      text: removed ? "保存済みルールを削除しました。" : "ルールを削除できませんでした。",
      ttlMs: removed ? 2500 : 4000,
    });
  }

  function sendToRedline(imagePath: string) {
    if (!resultState) return;
    queuePendingRecheck(
      createPendingRegulationRecheck(imagePath, resultState),
    );
    openRedlineWithImage(imagePath);
  }

  async function pickImages() {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const r = await openDialog({
        multiple: true,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!r) return;
      const paths = Array.isArray(r) ? r : [r];
      const merged = Array.from(new Set([...imagePaths, ...paths]));
      setImagePaths(merged);
      pushToast({
        kind: "success",
        text: `${paths.length} 枚を検査対象に追加しました。`,
        ttlMs: 2500,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `画像の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  function removeImage(path: string) {
    removeImageFromRun(path);
  }

  function clearAll() {
    invalidateRun();
    clearImages();
    setResultState(null);
  }

  async function runCheck(recheckOptions?: RecheckRunOptions) {
    const runState = useRegulationCheckRun.getState();
    const pathsForRun = [...runState.imagePaths];
    if (pathsForRun.length === 0) {
      pushToast({ kind: "info", text: "先に検査する画像を選んでください。", ttlMs: 3000 });
      return;
    }
    const ruleDraft = useRegulationRules.getState().draft;
    const ruleSelection: RegulationRecheckRuleSelection = recheckOptions ?? {
      ruleSetId: runState.ruleSetId,
      customRule: ruleDraft?.customRule ?? "",
    };
    const ruleSetForRun =
      DEFAULT_RULE_SETS.find((candidate) => candidate.id === ruleSelection.ruleSetId) ??
      DEFAULT_RULE_SETS[0];
    const rulesForRun = resolveRules(ruleSetForRun, ruleSelection.customRule);
    const runToken = beginRun();
    const ruleSnapshot: RegulationRuleSetSnapshot = {
      id: ruleSetForRun.id,
      name: ruleSetForRun.name,
      rules: rulesForRun.map((rule) => ({ ...rule })),
    };
    const resultSnapshot = {
      ruleSetId: ruleSetForRun.id,
      customRule: ruleSelection.customRule,
      ruleSet: ruleSnapshot,
    };
    setRunning(true);
    setResultState({ ...resultSnapshot, results: [] });
    try {
      const rules = ruleSnapshot.rules;
      const paths = pathsForRun;
      const collected: RegulationImageResult[] = [];
      // 画像は1枚ずつ、機械チェック→画面表示→Codex の順で進める。
      for (const path of paths) {
        let machineChecks: MachineCheckResult[];
        try {
          machineChecks = await runMachineChecks(path, ruleSnapshot.id);
        } catch (err) {
          if (!isCurrentRun(runToken)) return;
          collected.push({
            imagePath: path,
            machineChecks: [],
            aiPending: false,
            issues: [],
            description: "",
            error: `画像規格の確認に失敗しました: ${(err as Error)?.message ?? err}`,
          });
          setResultState({ ...resultSnapshot, results: [...collected] });
          continue;
        }
        if (!isCurrentRun(runToken)) return;
        collected.push({
          imagePath: path,
          machineChecks,
          aiPending: true,
          issues: [],
          description: "",
          error: null,
        });
        // ここで先に画面へ出す。Codexの応答待ちでも寸法等の結果を確認できる。
        setResultState({ ...resultSnapshot, results: [...collected] });

        const result = await checkImage(path, rules);
        if (!isCurrentRun(runToken)) return;
        collected[collected.length - 1] = {
          ...result,
          machineChecks,
          aiPending: false,
        };
        setResultState({ ...resultSnapshot, results: [...collected] });
      }
      const failed = collected.filter((r) => r.error).length;
      const flagged = collected.filter(
        (r) =>
          r.issues.length > 0 ||
          r.machineChecks?.some((check) => check.status === "fail" || check.status === "warning"),
      ).length;
      if (failed > 0) {
        pushToast({
          kind: "warn",
          text: `検査完了（${failed} 枚でエラー / ${flagged} 枚に指摘あり）。`,
          ttlMs: 5000,
        });
      } else {
        pushToast({
          kind: "success",
          text:
            flagged > 0
              ? `検査完了。${flagged} 枚に指摘があります。`
              : "検査完了。すべて問題なしです。",
          ttlMs: 4000,
        });
      }
      if (recheckOptions) {
        completePendingRecheck(
          recheckOptions.pendingImagePath,
          collected.find((result) => result.imagePath === recheckOptions.pendingImagePath),
        );
      }
    } catch (err) {
      if (!isCurrentRun(runToken)) return;
      pushToast({
        kind: "error",
        text: `検査に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 6000,
      });
    } finally {
      if (isCurrentRun(runToken)) setRunning(false);
    }
  }

  async function recheckPending(pending: PendingRegulationRecheck) {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "画像", extensions: IMAGE_EXTS }],
      });
      if (!selected) return;
      const revisedPath = Array.isArray(selected) ? selected[0] : selected;
      if (!revisedPath) return;

      const currentPaths = useRegulationCheckRun.getState().imagePaths;
      if (!currentPaths.includes(pending.imagePath)) {
        pushToast({
          kind: "warn",
          text: "元画像が検査対象から外れています。もう一度追加してください。",
          ttlMs: 4000,
        });
        return;
      }

      setImagePaths(
        replaceImageForRecheck(currentPaths, pending.imagePath, revisedPath),
      );
      retargetPendingRecheck(pending.imagePath, revisedPath);
      const frozenRules = selectFrozenRecheckRules(pending);
      setRuleSetId(frozenRules.ruleSetId);
      setRuleDraft(frozenRules.ruleSetId, frozenRules.customRule);
      await runCheck({ ...frozenRules, pendingImagePath: revisedPath });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `修正版の選択に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function copyResults() {
    if (!resultState || resultState.results.length === 0) return;
    const text = formatResultsAsText(
      resultState.results,
      resultState.ruleSet.rules,
    );
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ kind: "success", text: "検査結果をコピーしました。", ttlMs: 2500 });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `コピーに失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  async function saveReport() {
    if (!resultState || resultState.results.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destination = await save({
        defaultPath: `regulation-report-${fileTimestamp()}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!destination) return;

      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(destination, formatReportAsMarkdown(resultState));
      pushToast({
        kind: "success",
        text: "検査レポートをファイルに保存しました。",
        ttlMs: 3000,
      });
    } catch (err) {
      pushToast({
        kind: "error",
        text: `保存に失敗しました: ${(err as Error)?.message ?? err}`,
        ttlMs: 5000,
      });
    }
  }

  return (
    <section
      data-tour="regulation-workspace"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#121212]"
    >
      <div className="border-b border-[#242424] bg-[#121212] px-4 py-3">
        <div className="flex items-center gap-3">
          <WorkspaceTabs />
          <ActiveProjectSelector />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左: 設定パネル */}
        <div
          data-tour="regulation-settings"
          className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-[#242424] p-4"
        >
          <p className="rounded border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200/80">
            この検査は審査通過や適法性を保証しません。未確認項目と法務注意は、媒体の最新画面や専門家でも確認してください。
          </p>

          <SceneCompactCard
            number="01"
            title="検査ルール"
            summary={`${ruleSet.name}（${activeRules.length}件）${
              customRule.trim() ? " / 追加ルールあり" : ""
            }`}
            onClick={() => setOpen(true)}
          />

          <SceneSectionModal
            open={open}
            number="01"
            title="検査ルール"
            onClose={() => setOpen(false)}
          >
            <div className="flex flex-col gap-4">
              {/* 媒体プリセット */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-neutral-300">媒体ルールセット</label>
                <select
                  value={ruleSetId}
                  onChange={(e) => changeRuleSet(e.target.value)}
                  disabled={running}
                  className="rounded-md border border-[#2c2c2c] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-200 outline-none focus:border-neutral-500 disabled:opacity-50"
                >
                  {DEFAULT_RULE_SETS.map((rs) => (
                    <option key={rs.id} value={rs.id}>
                      {rs.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] leading-relaxed text-neutral-500">{ruleSet.description}</p>
                {ruleSet.notes.map((note) => (
                  <p
                    key={note}
                    className="rounded border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[11px] leading-relaxed text-amber-300/80"
                  >
                    {note}
                  </p>
                ))}
              </div>

              {/* 適用中ルール一覧 */}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-neutral-300">
                  適用ルール（{ruleSet.rules.length} 件）
                </span>
                <ul className="flex flex-col gap-1">
                  {ruleSet.rules.map((r) => (
                    <li
                      key={r.id}
                      className="rounded border border-[#242424] bg-[#171717] px-2 py-1.5 text-[11px]"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-neutral-300">{r.name}</span>
                        <span className="rounded border border-[#333] px-1 py-0.5 text-[9px] text-neutral-400">
                          {RULE_KIND_LABEL[r.kind ?? "ai"]}
                        </span>
                        {r.checkedAt && (
                          <span className="text-[9px] text-neutral-600">確認 {r.checkedAt}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-neutral-500">{r.description}</p>
                      {r.sourceUrl && (
                        <a
                          href={r.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-0.5 inline-block text-[10px] text-sky-400 hover:text-sky-300"
                        >
                          出典を開く（確度: {r.confidence ?? "未設定"}）
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 自由記述ルール */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-neutral-300">追加ルール（自由記述・任意）</label>
                <textarea
                  value={customRule}
                  onChange={(e) => changeCustomRule(e.target.value)}
                  disabled={running}
                  rows={3}
                  placeholder="例: 画面下部に「PR」の表記が必須。無ければ指摘してください。"
                  className="resize-none rounded-md border border-[#2c2c2c] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-50"
                />
              </div>

              {/* クライアント・案件別の保存ルール */}
              <div className="flex flex-col gap-1.5 border-t border-[#242424] pt-3">
                <span className="text-xs font-medium text-neutral-300">保存済みルール</span>
                {savedRules.length === 0 ? (
                  <p className="text-[11px] text-neutral-500">まだ保存されていません</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {savedRules.map((saved) => {
                      const mediaName =
                        DEFAULT_RULE_SETS.find((candidate) => candidate.id === saved.ruleSetId)
                          ?.name ?? saved.ruleSetId;
                      return (
                        <li
                          key={saved.id}
                          className="flex items-center gap-1 rounded border border-[#242424] bg-[#171717] p-1"
                        >
                          <button
                            type="button"
                            onClick={() => applySavedRule(saved.id)}
                            disabled={running}
                            className="min-w-0 flex-1 rounded px-1.5 py-1 text-left hover:bg-[#222] disabled:opacity-50"
                          >
                            <span className="block truncate text-[11px] font-medium text-neutral-300">
                              {saved.name}
                            </span>
                            <span className="block truncate text-[10px] text-neutral-500">
                              {mediaName}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void removeSavedRule(saved.id)}
                            disabled={running}
                            className="rounded border border-[#2c2c2c] px-1.5 py-1 text-[10px] text-neutral-500 hover:bg-[#222] hover:text-neutral-300 disabled:opacity-50"
                          >
                            削除
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="flex gap-1.5">
                  <input
                    value={savedRuleName}
                    onChange={(event) => setSavedRuleName(event.target.value)}
                    disabled={running}
                    placeholder="クライアント名・案件名"
                    className="min-w-0 flex-1 rounded-md border border-[#2c2c2c] bg-[#1a1a1a] px-2 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void saveCurrentRule()}
                    disabled={running || !savedRuleName.trim()}
                    className="rounded-md border border-[#2c2c2c] px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-[#222] disabled:opacity-40"
                  >
                    この内容を保存
                  </button>
                </div>
              </div>
            </div>
          </SceneSectionModal>

          {/* 検査対象の追加 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-neutral-300">
                検査対象（{imagePaths.length} 枚）
              </span>
              {imagePaths.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={running}
                  className="text-[11px] text-neutral-500 hover:text-neutral-300 disabled:opacity-50"
                >
                  すべて外す
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={pickImages}
              disabled={running}
              className="rounded-md border border-[#2c2c2c] bg-[#1a1a1a] px-3 py-2 text-xs text-neutral-200 hover:bg-[#222] disabled:opacity-50"
            >
              画像を選ぶ
            </button>
          </div>

          {/* サムネ一覧 */}
          {imagePaths.length > 0 && (
            <div className="grid grid-cols-3 gap-2">
              {imagePaths.map((p) => (
                <div
                  key={p}
                  className="group relative aspect-square overflow-hidden rounded border border-[#242424] bg-[#0d0d0d]"
                >
                  <SafeImage
                    path={p}
                    alt={basename(p)}
                    className="h-full w-full object-cover"
                  />
                  {!running && (
                    <button
                      type="button"
                      onClick={() => removeImage(p)}
                      className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-neutral-300 opacity-0 transition group-hover:opacity-100"
                    >
                      外す
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 実行 */}
          <button
            data-tour="regulation-run"
            type="button"
            onClick={() => void runCheck()}
            disabled={!canRun}
            className="mt-auto flex items-center justify-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
            )}
            {running ? "検査中…" : "検査を実行"}
          </button>
        </div>

        {/* 右: 結果パネル */}
        <div
          data-tour="regulation-results"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-[#242424] px-4 py-2.5">
            <span className="text-xs font-medium text-neutral-300">
              検査結果
              {resultState ? `（${resultState.ruleSet.name}）` : ""}
            </span>
            <div className="flex items-center gap-2">
              {pendingRechecks.map((pending) => (
                <button
                  key={pending.imagePath}
                  type="button"
                  onClick={() => void recheckPending(pending)}
                  disabled={running}
                  title={`${basename(pending.imagePath)} の修正版を選ぶ`}
                  className="rounded border border-[#2c2c2c] px-2 py-1 text-[11px] text-neutral-300 hover:bg-[#222] disabled:opacity-40"
                >
                  修正版を再検品
                </button>
              ))}
              <button
                type="button"
                onClick={copyResults}
                disabled={results.length === 0 || running}
                className="rounded border border-[#2c2c2c] px-2 py-1 text-[11px] text-neutral-300 hover:bg-[#222] disabled:opacity-40"
              >
                テキストでコピー
              </button>
              <button
                type="button"
                onClick={() => void saveReport()}
                disabled={results.length === 0 || running}
                className="rounded border border-[#2c2c2c] px-2 py-1 text-[11px] text-neutral-300 hover:bg-[#222] disabled:opacity-40"
              >
                レポートをファイルに保存
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {results.length === 0 && !running && (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-neutral-500">
                <p className="text-sm text-neutral-400">検査結果はここに表示されます</p>
                <p className="text-xs">左で画像とルールを設定して「検査を実行」してください</p>
              </div>
            )}

            {(results.length > 0 || running) && (
              <div className="flex flex-col gap-3">
                {results.map((result) => (
                  <ResultCard
                    key={result.imagePath}
                    result={result}
                    ruleName={(id) => findRule(resultRules, id)?.name ?? id}
                    onOpenRedline={sendToRedline}
                  />
                ))}
                {running && (
                  <p className="flex items-center gap-2 text-xs text-neutral-500">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-pink-500/30 border-t-pink-400" />
                    機械チェック後にCodexが画像を解析しています…（
                    {results.filter((result) => !result.aiPending).length}/{imagePaths.length}）
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ResultCard({
  result,
  ruleName,
  onOpenRedline,
}: {
  result: RegulationImageResult;
  ruleName: (ruleId: string) => string;
  onOpenRedline: (imagePath: string) => void;
}) {
  const hasIssues = result.issues.length > 0;
  const machineChecks = result.machineChecks ?? [];
  const machineAlerts = machineChecks.filter(
    (check) => check.status === "fail" || check.status === "warning",
  ).length;
  return (
    <div className="rounded-lg border border-[#242424] bg-[#161616] p-3">
      <div className="flex items-start gap-3">
        <SafeImage
          path={result.imagePath}
          alt={basename(result.imagePath)}
          className="h-16 w-16 shrink-0 rounded border border-[#2a2a2a] object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-neutral-200">
            {basename(result.imagePath)}
          </p>
          {result.aiPending ? (
            <p className="mt-0.5 text-[11px] text-sky-400">機械チェック完了 / Codex判定中</p>
          ) : result.error ? (
            <p className="mt-1 text-xs text-red-400">検査エラー: {result.error}</p>
          ) : hasIssues || machineAlerts > 0 ? (
            <p className="mt-0.5 text-[11px] text-amber-400">
              機械 {machineAlerts} 件 / Codex {result.issues.length} 件の注意
            </p>
          ) : (
            <p className="mt-0.5 text-[11px] text-emerald-400">確認できた範囲で問題なし</p>
          )}
        </div>
      </div>

      {machineChecks.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">
            Codex前の機械チェック
          </p>
          <ul className="flex flex-col gap-1.5">
            {machineChecks.map((check) => {
              const style = MACHINE_STATUS_STYLE[check.status];
              return (
                <li
                  key={check.id}
                  className="rounded border border-[#242424] bg-[#111] p-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${style.className}`}
                    >
                      {style.label}
                    </span>
                    <span className="text-[11px] font-medium text-neutral-300">{check.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-300">{check.message}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {result.aiPending && (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-500/30 border-t-sky-400" />
          表現と法務注意をCodexが確認しています…
        </p>
      )}

      {hasIssues && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {result.issues.map((issue, i) => {
            const sev = SEVERITY_STYLE[issue.severity];
            return (
              <li
                key={`${issue.ruleId}-${i}`}
                className="rounded border border-[#242424] bg-[#111] p-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${sev.className}`}
                  >
                    {sev.label}
                  </span>
                  <span className="text-[11px] font-medium text-neutral-300">
                    {ruleName(issue.ruleId)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-200">{issue.message}</p>
                {issue.evidence && (
                  <p className="mt-0.5 text-[11px] text-neutral-500">根拠: {issue.evidence}</p>
                )}
                <button
                  type="button"
                  onClick={() => onOpenRedline(result.imagePath)}
                  className="mt-2 rounded border border-[#2c2c2c] px-2 py-1 text-[11px] text-neutral-300 hover:bg-[#222]"
                >
                  レッドラインで直す
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
