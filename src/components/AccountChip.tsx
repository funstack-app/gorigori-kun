import { useState } from "react";

type Account = {
  email?: string;
  planType?: string;
  type?: "chatgpt" | "apiKey";
} | null;

/**
 * Aggressively mask an email so screenshots / screen-shares don't leak
 * any identifying info — not even whether it's gmail vs hotmail vs
 * a custom domain. Shows the first character of the local part, six
 * asterisks (fixed regardless of actual length), and the last character
 * of the domain. Click the chip to toggle the full address.
 *
 *   user.name@example.com       -> u******m
 *   ab@example.com              -> a******m
 *   x@y.io                      -> x******o
 */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) {
    // Not a recognizable email shape; mask it as a single-string token.
    const first = email[0] ?? "*";
    const last = email[email.length - 1] ?? "*";
    return `${first}******${last}`;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}******${domain[domain.length - 1]}`;
}

export function AccountChip({ account }: { account: Account }) {
  const [reveal, setReveal] = useState(false);
  if (!account) return null;
  const email = account.email;
  const display = email
    ? reveal
      ? email
      : maskEmail(email)
    : undefined;

  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2a2a2a] bg-[#0f0f0f] px-2 text-[11px] shadow-sm">
      <span className="font-medium text-neutral-300">
        {account.type === "chatgpt" ? "ChatGPT" : "API キー"}
      </span>
      {account.planType && (
        <span className="text-neutral-500">· {account.planType}</span>
      )}
      {display && (
        <button
          type="button"
          onClick={() => setReveal((v) => !v)}
          className="text-neutral-500 hover:text-neutral-200"
          title={reveal ? "クリックで隠す" : "クリックで全表示"}
          aria-label={reveal ? "メールを隠す" : "メールを全表示"}
        >
          · {display}
        </button>
      )}
    </span>
  );
}
