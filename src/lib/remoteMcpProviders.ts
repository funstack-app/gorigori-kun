export type RemoteMcpProviderCatalogEntry = {
  id:
    | "krea"
    | "runway"
    | "bfl"
    | "ideogram"
    | "openart"
    | "pika"
    | "kling"
    | "pollo"
    | "topview";
  label: string;
  /** サービスが何をしてくれるかの1行（説明の長文は置かない。2026-08-22 STΛCK指定）。 */
  capabilities: string;
  /** 名前の横に出す短い注記バッジ（未検証・プラン条件など）。 */
  note?: string;
};

/**
 * 段階1のリモート MCP 表示カタログ。
 * 実ツール名や対応モデルはアカウントごとの実測前に断定しない。
 */
export const REMOTE_MCP_PROVIDERS: readonly RemoteMcpProviderCatalogEntry[] = [
  {
    id: "krea",
    label: "Krea",
    capabilities: "画像・動画生成（多モデル集約）",
  },
  {
    id: "runway",
    label: "Runway",
    capabilities: "画像・動画生成",
  },
  {
    id: "bfl",
    label: "Black Forest Labs",
    capabilities: "FLUX系の画像・動画生成",
  },
  {
    id: "ideogram",
    label: "Ideogram",
    capabilities: "画像生成・編集",
  },
  {
    id: "openart",
    label: "OpenArt",
    capabilities: "画像・動画生成、編集",
  },
  {
    id: "pika",
    label: "Pika",
    capabilities: "動画・画像・音声生成",
  },
  {
    id: "kling",
    label: "Kling AI",
    capabilities: "画像・動画生成",
    note: "動作未検証",
  },
  {
    id: "pollo",
    label: "Pollo AI",
    capabilities: "画像・動画生成（多モデル集約）",
  },
  {
    id: "topview",
    label: "TopView",
    capabilities: "広告・SNS向けの動画・画像生成",
    note: "プランによる",
  },
];
