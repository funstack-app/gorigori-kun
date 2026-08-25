import { useEffect, useState } from "react";
import { onServerRequest, resolveServerRequest, type ServerRequest } from "../lib/ipc";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
]);

type Pending = { req: ServerRequest };

export function ApprovalDialog() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    let unlisten: undefined | (() => void);
    onServerRequest((req) => {
      if (APPROVAL_METHODS.has(req.method)) {
        setPending({ req });
      } else {
        // Unknown server requests get a polite negative acknowledgment so the
        // server doesn't hang. Use the same field name (`decision: decline`)
        // accepted by all the new approval responses.
        resolveServerRequest(req.id, { decision: "decline" });
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  if (!pending) return null;
  const { req } = pending;
  const params = req.params as any;
  const close = () => setPending(null);

  if (req.method === "item/tool/requestUserInput") {
    return (
      <Frame
        title="ユーザー入力"
        onCancel={() => {
          // No clean "cancel" response — answer empty strings so the agent
          // can fall back gracefully.
          const answers: Record<string, { answers: string[] }> = {};
          for (const q of params?.questions ?? []) {
            answers[q.id] = { answers: [""] };
          }
          resolveServerRequest(req.id, { answers });
          close();
        }}
      >
        <UserInputForm
          params={params}
          onAnswer={(answers) => {
            resolveServerRequest(req.id, { answers });
            close();
          }}
        />
      </Frame>
    );
  }

  // commandExecution / fileChange — share the same decision enum.
  const isCmd = req.method === "item/commandExecution/requestApproval";
  const decide = (decision: "accept" | "acceptForSession" | "decline" | "cancel") => {
    resolveServerRequest(req.id, { decision });
    close();
  };

  return (
    <Frame
      title={isCmd ? "コマンド実行の承認" : "ファイル変更の承認"}
      onCancel={() => decide("decline")}
    >
      {params?.command && (
        <pre className="mt-3 max-h-40 overflow-auto rounded bg-black/60 p-2 font-mono text-xs text-neutral-300">
          {Array.isArray(params.command) ? params.command.join(" ") : String(params.command)}
        </pre>
      )}
      {params?.changes && Array.isArray(params.changes) && (
        <ul className="mt-3 max-h-40 overflow-auto rounded bg-black/60 p-2 font-mono text-xs text-neutral-300">
          {params.changes.map((c: any, i: number) => (
            <li key={i}>
              [{c.kind}] {c.path}
            </li>
          ))}
        </ul>
      )}
      {params?.reason && (
        <p className="mt-2 text-xs text-neutral-400">{params.reason}</p>
      )}
      <div className="mt-5 flex shrink-0 justify-between gap-2">
        <button
          onClick={() => decide("cancel")}
          className="rounded-md border border-rose-700/60 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-700/20"
          title="このターンを中断します"
        >
          中止 (ターン停止)
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => decide("decline")}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-500"
          >
            拒否
          </button>
          <button
            onClick={() => decide("acceptForSession")}
            className="rounded-md border border-emerald-700/60 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-700/15"
          >
            セッション中許可
          </button>
          <button
            onClick={() => decide("accept")}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white shadow-md hover:bg-emerald-500"
          >
            1 回許可
          </button>
        </div>
      </div>
    </Frame>
  );
}

function Frame({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex max-h-[calc(100vh-80px)] min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-2xl">
        <div className="flex shrink-0 items-start justify-between">
          <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
          <button
            onClick={onCancel}
            aria-label="閉じる"
            className="text-neutral-500 hover:text-neutral-300"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

type Question = {
  id: string;
  header?: string;
  question: string;
  isSecret?: boolean;
};

function UserInputForm({
  params,
  onAnswer,
}: {
  params: any;
  onAnswer: (answers: Record<string, { answers: string[] }>) => void;
}) {
  const questions: Question[] = params?.questions ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <form
      className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto"
      onSubmit={(e) => {
        e.preventDefault();
        const out: Record<string, { answers: string[] }> = {};
        for (const q of questions) {
          out[q.id] = { answers: [values[q.id] ?? ""] };
        }
        onAnswer(out);
      }}
    >
      {questions.map((q) => (
        <label key={q.id} className="block text-xs text-neutral-300">
          <span className="font-medium">{q.header ?? q.question}</span>
          {q.header && <p className="text-neutral-500">{q.question}</p>}
          <input
            type={q.isSecret ? "password" : "text"}
            value={values[q.id] ?? ""}
            onChange={(e) =>
              setValues((prev) => ({ ...prev, [q.id]: e.target.value }))
            }
            className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-emerald-500"
          />
        </label>
      ))}
      <div className="sticky bottom-0 flex shrink-0 justify-end gap-2 bg-neutral-900 pt-2">
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500"
        >
          回答
        </button>
      </div>
    </form>
  );
}
