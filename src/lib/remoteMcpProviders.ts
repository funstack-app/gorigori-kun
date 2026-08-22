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
  description: string;
  capabilities: string;
};

const CONNECTION_NOTE =
  "接続すると GORI のAIエージェント経路からこのサービスのツールを利用できます（専用の生成UIは今後追加）。";

/**
 * 段階1のリモート MCP 表示カタログ。
 * 実ツール名や対応モデルはアカウントごとの実測前に断定しない。
 */
export const REMOTE_MCP_PROVIDERS: readonly RemoteMcpProviderCatalogEntry[] = [
  {
    id: "krea",
    label: "Krea",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成サービスとの連携",
  },
  {
    id: "runway",
    label: "Runway",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成サービスとの連携",
  },
  {
    id: "bfl",
    label: "Black Forest Labs",
    description: CONNECTION_NOTE,
    capabilities: "FLUX系の画像・動画生成サービスとの連携",
  },
  {
    id: "ideogram",
    label: "Ideogram",
    description: CONNECTION_NOTE,
    capabilities: "画像生成・編集サービスとの連携",
  },
  {
    id: "openart",
    label: "OpenArt",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成、編集サービスとの連携",
  },
  {
    id: "pika",
    label: "Pika",
    description: CONNECTION_NOTE,
    capabilities: "動画・画像・音声サービスとの連携",
  },
  {
    id: "kling",
    label: "Kling AI",
    description: `${CONNECTION_NOTE} 接続は実験的です（動作未検証）。`,
    capabilities: "画像・動画生成サービスとの連携",
  },
  {
    id: "pollo",
    label: "Pollo AI",
    description: CONNECTION_NOTE,
    capabilities: "多モデル集約の画像・動画生成サービスとの連携",
  },
  {
    id: "topview",
    label: "TopView",
    description: `${CONNECTION_NOTE} MCP利用可否はプランにより異なります。`,
    capabilities: "広告・SNS向けの動画・画像生成サービスとの連携",
  },
];
