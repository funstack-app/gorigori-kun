import { useToasts } from "./store/toasts";
import { useWorkspace } from "./store/workspace";

/** MCP の OAuth 接続が切れていることを示す代表的なエラーを検出する。 */
export function isMcpAuthError(reason: unknown): boolean {
  const raw = String(reason ?? "");
  if (!raw) return false;
  return (
    /invalid_grant/i.test(raw) ||
    /issued to another client/i.test(raw) ||
    /(oauth|token)[^\n]{0,40}refresh failed/i.test(raw) ||
    /refresh token[^\n]{0,40}(invalid|expired|revoked)/i.test(raw) ||
    /unauthorized_client/i.test(raw)
  );
}

/** 認証切れ時に表示する、プロバイダ共通の再接続案内。 */
export function mcpReauthMessage(providerLabel: string): string {
  return `${providerLabel}の接続が切れています。設定から再接続してください。`;
}

/**
 * 認証切れの案内を出し、「設定 > 接続先」をワンタップで開けるようにする。
 * App.tsx が既に購読している gori:open-settings を使い、画面遷移を重複実装しない。
 */
export function pushMcpReauthToast(providerLabel: string): string {
  return useToasts.getState().push({
    kind: "error",
    text: mcpReauthMessage(providerLabel),
    ttlMs: 0,
    action: {
      label: "設定を開く",
      run: () => {
        useWorkspace.getState().requestSettingsTab("connections");
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("gori:open-settings"));
        }
      },
    },
  });
}
