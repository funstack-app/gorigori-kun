import { useEffect, useMemo, useState } from "react";
import { supabaseCloud, type SupabaseConfig } from "../lib/ipc";
import { useCloudSupabase } from "../lib/store/cloudSupabase";
import { useToasts } from "../lib/store/toasts";

const PRIMARY_BUTTON = "rounded-md bg-pink-500 font-bold text-white hover:bg-pink-600 disabled:opacity-40";
const MUTED_BUTTON =
  "rounded-md border border-[#343434] bg-[#1e1e1e] font-bold text-neutral-300 hover:border-[#555] hover:text-white disabled:opacity-40";
const DANGER_BUTTON =
  "rounded-md border border-rose-500/40 bg-rose-500/10 font-bold text-rose-200 hover:border-rose-300 disabled:opacity-40";

export function SettingsCloudSection() {
  const { config, usage, loading, lastSync, refresh, syncNow, disconnect } = useCloudSupabase();
  const push = useToasts((s) => s.push);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh().catch((err) => {
      push({ kind: "error", text: `クラウド設定の読み込みに失敗: ${String(err)}` });
    });
  }, [push, refresh]);

  const usageRatio = usage && usage.limitBytes > 0 ? usage.usedBytes / usage.limitBytes : 0;

  if (loading && !config) {
    return (
      <Panel title="クラウドストレージ連携">
        <p className="text-xs text-neutral-500">読み込み中…</p>
      </Panel>
    );
  }

  if (!config) {
    return <SetupWizard />;
  }

  const runSync = async () => {
    setBusy(true);
    try {
      const result = await syncNow();
      push({
        kind: result.failedCount > 0 ? "error" : "success",
        text: `同期完了: アップロード ${result.uploadedCount} 件 / 失敗 ${result.failedCount} 件`,
        ttlMs: 3600,
      });
    } catch (err) {
      push({ kind: "error", text: `同期に失敗: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const doDisconnect = async () => {
    if (!window.confirm("Supabase 連携を解除します。クラウド上の画像は削除されません。よろしいですか？")) return;
    setBusy(true);
    try {
      await disconnect();
      push({ kind: "success", text: "Supabase 連携を解除しました", ttlMs: 2400 });
    } catch (err) {
      push({ kind: "error", text: `解除に失敗: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="クラウドストレージ連携">
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-black text-emerald-100">☁️ 連携済み</h3>
            <p className="mt-1 text-xs text-neutral-500">生成画像をあなたの Supabase Storage に同期します。</p>
          </div>
          <button type="button" onClick={() => void refresh()} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
            更新
          </button>
        </div>
      </section>

      <Field label="プロジェクト URL">
        <TextInput value={config.projectUrl} onChange={() => undefined} mono disabled />
      </Field>
      <Field label="バケット">
        <TextInput value={config.bucketName} onChange={() => undefined} disabled />
      </Field>
      <Field label="使用容量">
        <div className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-3">
          <div className="h-2 overflow-hidden rounded-full bg-[#262626]">
            <div
              className={`h-full rounded-full ${usageRatio > 0.8 ? "bg-amber-400" : "bg-sky-400"}`}
              style={{ width: `${Math.min(100, usageRatio * 100)}%` }}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="font-bold text-neutral-200">
              {formatBytes(usage?.usedBytes ?? 0)} / {formatBytes(usage?.limitBytes ?? 1024 * 1024 * 1024)}
            </span>
            <span className="text-neutral-500">{usage?.fileCount ?? 0} ファイル</span>
          </div>
          {usageRatio > 0.8 && <p className="mt-1 text-[11px] text-amber-300">⚠️ 無料枠の残りが少なめです。</p>}
        </div>
      </Field>

      {lastSync && (
        <div className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-3 text-xs text-neutral-400">
          直近の同期: アップロード {lastSync.uploadedCount} 件 / 失敗 {lastSync.failedCount} 件
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void runSync()} disabled={busy} className={`${PRIMARY_BUTTON} h-9 px-4 text-xs`}>
          {busy ? "処理中…" : "今すぐ同期"}
        </button>
        <button type="button" onClick={() => void doDisconnect()} disabled={busy} className={`${DANGER_BUTTON} h-9 px-4 text-xs`}>
          連携を解除
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-neutral-500">
        α版では5分ごとのバックグラウンド同期と手動同期に対応しています。30日保持の自動削除は Supabase 側の bucket ポリシーで設定してください。
      </p>
    </Panel>
  );
}

function SetupWizard() {
  const saveConfig = useCloudSupabase((s) => s.saveConfig);
  const push = useToasts((s) => s.push);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [projectUrl, setProjectUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [bucketName, setBucketName] = useState("gori-images");
  const [testing, setTesting] = useState(false);

  const config = useMemo<SupabaseConfig>(
    () => ({ projectUrl: projectUrl.trim(), anonKey: anonKey.trim(), bucketName: bucketName.trim() || "gori-images" }),
    [projectUrl, anonKey, bucketName],
  );

  const openDashboard = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://supabase.com/dashboard");
    } catch (err) {
      push({ kind: "error", text: `ブラウザを開けません: ${String(err)}` });
    }
  };

  const testAndSave = async () => {
    setTesting(true);
    try {
      await supabaseCloud.testConnection(config);
      await saveConfig(config);
      push({ kind: "success", text: "Supabase 連携が完了しました", ttlMs: 3000 });
    } catch (err) {
      push({ kind: "error", text: `接続テストに失敗: ${String(err)}` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel title="クラウドストレージ連携">
      <section className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
        <h3 className="text-sm font-black text-sky-100">セットアップウィザード</h3>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          STΛCK 側のクラウド費用を使わず、あなた自身の Supabase 無料枠へ画像を保存します。目安は10〜15分です。
        </p>
        <div className="mt-3 grid grid-cols-4 gap-1">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setStep(n as 1 | 2 | 3 | 4)}
              className={`h-8 rounded-md text-[11px] font-black ${step === n ? "bg-sky-400 text-[#061018]" : "bg-[#202020] text-neutral-400"}`}
            >
              Step {n}
            </button>
          ))}
        </div>
      </section>

      {step === 1 && (
        <GuideCard
          title="1. Supabase アカウントを作成"
          bullets={["Supabase ダッシュボードを開く", "GitHubで登録がおすすめ", "ログイン後、Projects 画面を表示"]}
          actionLabel="Supabase を開く"
          onAction={() => void openDashboard()}
        />
      )}
      {step === 2 && (
        <GuideCard
          title="2. 新しいプロジェクトを作る"
          bullets={["+ New Project をクリック", "リージョンは Tokyo 推奨", "データベースパスワードを保存して作成完了まで待つ"]}
        />
      )}
      {step === 3 && (
        <GuideCard
          title="3. Storage バケットを作る"
          bullets={["左メニュー Storage → + New bucket", "バケット名は gori-images", "Public bucket を ON（公開URLで画像確認するため）"]}
        />
      )}
      {step === 4 && (
        <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
          <h3 className="text-sm font-black text-white">4. 接続情報を入力</h3>
          <p className="mt-1 text-xs text-neutral-500">Settings → API から Project URL と anon public key をコピーしてください。</p>
          <div className="mt-4 space-y-3">
            <Field label="Project URL">
              <TextInput value={projectUrl} onChange={setProjectUrl} placeholder="https://xxxx.supabase.co" mono />
            </Field>
            <Field label="anon key（Keychain に保存）">
              <TextInput value={anonKey} onChange={setAnonKey} placeholder="eyJhbGciOi..." mono />
            </Field>
            <Field label="Bucket name">
              <TextInput value={bucketName} onChange={setBucketName} placeholder="gori-images" />
            </Field>
          </div>
          <button
            type="button"
            onClick={() => void testAndSave()}
            disabled={testing || !config.projectUrl || !config.anonKey || !config.bucketName}
            className={`${PRIMARY_BUTTON} mt-4 h-9 px-4 text-xs`}
          >
            {testing ? "接続テスト中…" : "接続テストして保存"}
          </button>
        </section>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={() => setStep((Math.max(1, step - 1) as 1 | 2 | 3 | 4))} disabled={step === 1} className={`${MUTED_BUTTON} h-9 px-3 text-xs`}>
          戻る
        </button>
        <button type="button" onClick={() => setStep((Math.min(4, step + 1) as 1 | 2 | 3 | 4))} disabled={step === 4} className={`${PRIMARY_BUTTON} h-9 px-3 text-xs`}>
          次へ
        </button>
      </div>
    </Panel>
  );
}

function GuideCard({
  title,
  bullets,
  actionLabel,
  onAction,
}: {
  title: string;
  bullets: string[];
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="rounded-lg border border-[#2a2a2a] bg-[#151515] p-4">
      <h3 className="text-sm font-black text-white">{title}</h3>
      <div className="mt-3 rounded-lg border border-dashed border-[#3a3a3a] bg-[#101010] p-4 text-center text-xs text-neutral-500">
        スクリーンショットの代替ガイド: 画面上のボタン名を確認しながら進めてください。
      </div>
      <ul className="mt-3 space-y-2 text-xs text-neutral-300">
        {bullets.map((bullet) => (
          <li key={bullet} className="flex gap-2">
            <span className="text-sky-300">✓</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className={`${PRIMARY_BUTTON} mt-4 h-9 px-4 text-xs`}>
          {actionLabel}
        </button>
      )}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h2 className="text-lg font-black text-white">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellCheck={false}
      className={`h-9 w-full rounded-md border border-[#343434] bg-[#101010] px-3 text-xs text-neutral-100 outline-none focus:border-pink-500 disabled:text-neutral-500 ${props.mono ? "font-mono" : ""}`}
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
