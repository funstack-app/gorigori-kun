import { Component, type ErrorInfo, type ReactNode } from "react";

import { logError } from "../lib/store/errorLog";
import { useSkillMode } from "../lib/store/skillMode";
import type { UiMode } from "../lib/store/skillUiMode";

type SkillErrorBoundaryProps = {
  mode: UiMode | "sharedTabs";
  children: ReactNode;
};

type SkillErrorBoundaryState = {
  hasError: boolean;
  errorMessage: string;
};

function stringifyThrownValue(error: unknown): string {
  if (error === null || error === undefined) return "(詳細なし)";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export class SkillErrorBoundary extends Component<
  SkillErrorBoundaryProps,
  SkillErrorBoundaryState
> {
  state: SkillErrorBoundaryState = { hasError: false, errorMessage: "" };

  static getDerivedStateFromError(error: unknown): SkillErrorBoundaryState {
    return { hasError: true, errorMessage: stringifyThrownValue(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const { mode } = this.props;
    const errorMessage = stringifyThrownValue(error);
    const errorDetail = error instanceof Error ? (error.stack ?? errorMessage) : errorMessage;
    logError(
      "スキル画面",
      `画面の表示でエラーが起きました（${mode}）`,
      errorDetail + "\n" + (info.componentStack ?? ""),
    );
    console.error("[SkillErrorBoundary]", error, info);
  }

  private closeSkill = () => {
    useSkillMode.getState().setEnabled(false);
    this.setState({ hasError: false, errorMessage: "" });
  };

  private retry = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render(): ReactNode {
    const { children, mode } = this.props;
    const { hasError, errorMessage } = this.state;

    if (!hasError) return children;

    return (
      <section className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-[#121212] p-6 text-center">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">
            画面の表示でエラーが起きました
          </h2>
          <p className="mt-2 text-xs text-neutral-500">
            作業データは残っています。下のボタンで戻れます。
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2">
          {mode !== "default" && (
            <button
              type="button"
              onClick={this.closeSkill}
              className="rounded-md bg-pink-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-pink-600"
            >
              スキルを閉じて戻る
            </button>
          )}
          <button
            type="button"
            onClick={this.retry}
            className="rounded-md border border-[#343434] px-4 py-2 text-sm text-neutral-300 transition hover:border-[#444] hover:text-white"
          >
            この画面を再表示
          </button>
        </div>

        <details className="max-w-full text-left text-[10px] text-neutral-600">
          <summary>詳細</summary>
          <p className="mt-1 break-all whitespace-pre-wrap">
            {errorMessage.slice(0, 300)}
          </p>
        </details>
      </section>
    );
  }
}
