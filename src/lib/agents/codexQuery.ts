import { invoke } from "@tauri-apps/api/core";

export type CodexTextQueryArgs = {
  prompt: string;
  systemPrompt?: string;
  expectJson: boolean;
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
