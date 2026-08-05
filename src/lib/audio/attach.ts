import { audio, type AudioProbeResult } from "../ipc";

/**
 * MV 用の音源添付ヘルパー (bd go4)。
 *
 * ## 不変条件
 *
 * **音声パスを `localImage` に絶対に入れない。** codex の入力モダリティは
 * Text + Image のみで、音声パスを localImage として渡すとモデルがファイルを
 * 調べようとシェル実行を試み、Windows では sandbox 準備エラーに化ける。
 * ここで渡すのは `buildAudioNote()` が作る **文字情報だけ**。
 */

/** Rust 側 `AUDIO_EXTS` (audio_probe.rs) と一致させること。 */
export const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg"] as const;

/** picker 経由は bytes を JS メモリに載せるため上限を設ける。 */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

const AUDIO_EXT_SET = new Set<string>(AUDIO_EXTS);

export function isAudioFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXT_SET.has(ext);
}

/** 添付中の音源 1 件。probe 結果 + 実ファイルパス。 */
export type AudioAttachment = AudioProbeResult & { path: string };

/** 秒 → "M:SS"。 */
export function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 秒 → "{M}分{S}秒" (トースト・注入文言用)。 */
function formatDurationJa(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}分${s}秒`;
}

export function probeAudio(path: string): Promise<AudioAttachment> {
  return audio.probe(path).then((r) => ({ ...r, path }));
}

/**
 * File → 音源ファイルの実パス。
 * native drop は `file.path` 直通 (bytes を載せない)。picker 経由は
 * bytes を audio_uploads/ へ書き出す。
 */
export async function fileToAudioPath(file: File): Promise<string> {
  const directPath = (file as unknown as { path?: string }).path;
  if (directPath) return directPath;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return audio.writeUpload(file.name || "audio.mp3", bytes);
}

/**
 * プロンプトへ注入する `[添付音源]` ブロック。
 *
 * 絵コンテ (MV) は `[STORYBOARD_PARAMS]` の `duration_seconds` 合計を全体尺に
 * 一致させる設計があるため、「長さを文字で渡す」だけで曲に合ったカット割りが成立する。
 * 「音声データそのものは渡していない」を明記して、AI が聴けたかのように振る舞うのを抑える。
 */
export function buildAudioNote(a: AudioAttachment): string {
  const lines: string[] = ["[添付音源]", `ファイル名: ${a.fileName}`];
  lines.push(
    `長さ: ${formatDurationJa(a.durationSec)}（${a.durationSec.toFixed(1)}秒）`,
  );

  const specs: string[] = [a.ext];
  if (a.sampleRate != null) specs.push(`${a.sampleRate}Hz`);
  if (a.channels != null) specs.push(`${a.channels}ch`);
  if (a.bitrateKbps != null) specs.push(`約${a.bitrateKbps}kbps`);
  lines.push(`形式: ${specs.join(" / ")}`);

  // タグが無ければ行ごと省略する (文字化けタグは Rust 側で None に落ちている)。
  if (a.title) lines.push(`タイトル: ${a.title}`);
  if (a.artist) lines.push(`アーティスト: ${a.artist}`);

  lines.push(
    "この音源はこの映像（MV）の完成尺の基準です。カット割り・構成案は duration_seconds の合計が上記の「長さ」と一致するように設計してください。音声データそのものは渡していないため、テンポ・曲調・歌詞が構成に必要な場合は推測せずユーザーに質問してください。",
  );
  return lines.join("\n");
}

/** 添付成功トースト。 */
export function audioAttachedMessage(a: AudioAttachment): string {
  return `音源を添付しました: ${a.fileName}（${formatDurationJa(a.durationSec)}）`;
}

/** 2 曲目の差し替えトースト。 */
export const AUDIO_REPLACED_MESSAGE =
  "音源を差し替えました（添付できる音源は1曲です）";

/** サイズ超過エラー。 */
export function audioTooLargeMessage(fileName: string): string {
  return `音源が大きすぎます: ${fileName}（上限 200MB）`;
}

/** 未対応形式 (画像でも対応音源でもない) のエラー。 */
export const UNSUPPORTED_ATTACHMENT_MESSAGE =
  "画像または音源（mp3 / wav / m4a / aac / flac / ogg）のファイルを選んでください。";
