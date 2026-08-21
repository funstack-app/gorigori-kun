export type RemoteMcpProviderCatalogEntry = {
  id: "krea" | "runway" | "bfl" | "ideogram" | "openart" | "pika" | "kling";
  label: string;
  initials: string;
  description: string;
  capabilities: string;
  accentClasses: {
    card: string;
    icon: string;
    title: string;
    button: string;
  };
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
    initials: "K",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成サービスとの連携",
    accentClasses: {
      card: "border-cyan-400/30 bg-cyan-500/5",
      icon: "border-cyan-400/20 text-cyan-200",
      title: "text-cyan-100",
      button: "bg-cyan-500 hover:bg-cyan-400",
    },
  },
  {
    id: "runway",
    label: "Runway",
    initials: "R",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成サービスとの連携",
    accentClasses: {
      card: "border-lime-400/30 bg-lime-500/5",
      icon: "border-lime-400/20 text-lime-200",
      title: "text-lime-100",
      button: "bg-lime-600 hover:bg-lime-500",
    },
  },
  {
    id: "bfl",
    label: "Black Forest Labs",
    initials: "BFL",
    description: CONNECTION_NOTE,
    capabilities: "FLUX系の画像・動画生成サービスとの連携",
    accentClasses: {
      card: "border-amber-400/30 bg-amber-500/5",
      icon: "border-amber-400/20 text-amber-200",
      title: "text-amber-100",
      button: "bg-amber-600 hover:bg-amber-500",
    },
  },
  {
    id: "ideogram",
    label: "Ideogram",
    initials: "I",
    description: CONNECTION_NOTE,
    capabilities: "画像生成・編集サービスとの連携",
    accentClasses: {
      card: "border-blue-400/30 bg-blue-500/5",
      icon: "border-blue-400/20 text-blue-200",
      title: "text-blue-100",
      button: "bg-blue-500 hover:bg-blue-400",
    },
  },
  {
    id: "openart",
    label: "OpenArt",
    initials: "O",
    description: CONNECTION_NOTE,
    capabilities: "画像・動画生成、編集サービスとの連携",
    accentClasses: {
      card: "border-fuchsia-400/30 bg-fuchsia-500/5",
      icon: "border-fuchsia-400/20 text-fuchsia-200",
      title: "text-fuchsia-100",
      button: "bg-fuchsia-500 hover:bg-fuchsia-400",
    },
  },
  {
    id: "pika",
    label: "Pika",
    initials: "P",
    description: CONNECTION_NOTE,
    capabilities: "動画・画像・音声サービスとの連携",
    accentClasses: {
      card: "border-orange-400/30 bg-orange-500/5",
      icon: "border-orange-400/20 text-orange-200",
      title: "text-orange-100",
      button: "bg-orange-500 hover:bg-orange-400",
    },
  },
  {
    id: "kling",
    label: "Kling AI",
    initials: "K",
    description: `${CONNECTION_NOTE} 接続は実験的です（動作未検証）。`,
    capabilities: "画像・動画生成サービスとの連携",
    accentClasses: {
      card: "border-violet-400/30 bg-violet-500/5",
      icon: "border-violet-400/20 text-violet-200",
      title: "text-violet-100",
      button: "bg-violet-500 hover:bg-violet-400",
    },
  },
];
