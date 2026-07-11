import { invoke } from "@tauri-apps/api/core";

export type CodexTextQueryArgs = {
  prompt: string;
  systemPrompt?: string;
  expectJson: boolean;
  /** タイムアウト(秒)。未指定は60。重い生成(モーション設計等)は延長する(上限300) */
  timeoutSecs?: number;
  signal?: AbortSignal;
};

export type CodexTextQueryResult = {
  text: string;
  parsedJson: unknown | null;
};

function abortError(): DOMException {
  return new DOMException("Agent request was aborted.", "AbortError");
}

export async function codexTextQuery({
  prompt,
  systemPrompt,
  expectJson,
  timeoutSecs,
  signal,
}: CodexTextQueryArgs): Promise<CodexTextQueryResult> {
  if (signal?.aborted) {
    throw abortError();
  }

  return new Promise<CodexTextQueryResult>((resolve, reject): void => {
    const onAbort = (): void => {
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    void invoke<CodexTextQueryResult>("codex_text_query", {
      prompt,
      systemPrompt: systemPrompt ?? null,
      expectJson,
      timeoutSecs: timeoutSecs ?? null,
    })
      .then((result: CodexTextQueryResult): void => {
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        resolve(result);
      })
      .catch((error: unknown): void => {
        reject(error);
      })
      .finally((): void => {
        signal?.removeEventListener("abort", onAbort);
      });
  });
}
