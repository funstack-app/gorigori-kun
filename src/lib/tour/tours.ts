import type { TourDefinition } from "./types";

export const PAGE_TOURS = {
  artworkGeneration: {
    id: "artwork-generation",
    steps: [
      {
        target: '[data-tour="generation-prompt"]',
        title: "作りたい絵を書く",
        body: "選んだ要素がここにまとまります。自分の言葉で書き足しても、その内容で画像を作れます。",
        placement: "right",
      },
      {
        target: '[data-tour="generation-model"]',
        title: "作り方を選ぶ",
        body: "まずは既定のモデルで大丈夫です。接続済みのサービスがあると、ここから切り替えられます。",
        placement: "right",
      },
      {
        target: '[data-tour="generation-submit"]',
        title: "画像を作る",
        body: "内容を確認したら、ここを押します。作った画像は右側の生成タイムラインに並びます。",
        placement: "right",
      },
      {
        target: '[data-tour="generation-library"]',
        title: "作った画像を見返す",
        body: "生成や追加をした画像はライブラリに集まります。後から参照画像として使うこともできます。",
        placement: "right",
      },
    ],
  },
  skills: {
    id: "skills",
    steps: [
      {
        target: "article",
        title: "スキルとは",
        body: "目的ごとの作り方をまとめた手順です。やりたいことに近いカードを一つ選べば、専用の画面に切り替わります。",
        placement: "bottom",
      },
      {
        target: "article button[aria-pressed]",
        title: "スキルを起動する",
        body: "まず使いたいカードの「使う」を押します。必要な入力と手順が、そのスキル向けに切り替わります。",
        placement: "top",
      },
      {
        target: '[data-tour="workspace-tabs"], section',
        title: "作品モードに戻る",
        body: "起動中は上のタブ列にスキル名と停止ボタンが出ます。停止しても、作成済みの内容や履歴は消えません。",
        placement: "bottom",
      },
    ],
  },
  film: {
    id: "film",
    steps: [
      {
        target: 'nav[aria-label="フィルム制作工程"]',
        title: "6工程で一本にする",
        body: "企画、脚本、設計、アセット、生成、仕上げの順です。左の工程を見ると、今どこにいるか分かります。",
        placement: "right",
      },
      {
        target: 'nav[aria-label="フィルム制作工程"] + main',
        title: "確認してから次へ進む",
        body: "各工程で内容を確認し、承認して次へ進みます。先に設計を固定することで、途中で作品の軸がずれるのを防ぎます。",
        placement: "left",
      },
    ],
  },
  settingsConnections: {
    id: "settings-connections",
    steps: [
      {
        target: "nav button:nth-of-type(3)",
        title: "最初にCodexへログインする",
        body: "画像生成の基本機能を使う入口です。まず「アカウント」を開き、Codexのログイン状態を確認してください。",
        placement: "right",
      },
      {
        target: "nav button:nth-of-type(4)",
        title: "MCPで機能を増やす",
        body: "外部サービスは「接続先」から追加します。MCPは、別のサービスと安全につなぐための共通の窓口です。",
        placement: "right",
      },
      {
        target: "nav button:nth-of-type(3)",
        title: "困ったら接続状態を確認する",
        body: "生成できないときは「アカウント」に戻り、ログイン表示とテスト接続を確認します。原因を一つずつ切り分けられます。",
        placement: "right",
      },
    ],
  },
} satisfies Record<string, TourDefinition>;

export const WELCOME_TOUR: TourDefinition = {
  id: "welcome",
  steps: [
    {
      target: '[data-tour="app-shell"]',
      title: "GORI GORI KUNへようこそ",
      body: "考える、画像を作る、素材を整理する作業を、一つの場所で進めるための制作アプリです。",
      placement: "bottom",
    },
    {
      target: '[data-tour="workspace-tabs"]',
      title: "作業はタブで分かれています",
      body: "企画で考え、画像生成で作り、動画生成や編集へ進みます。まずは画像生成を開けば大丈夫です。",
      placement: "bottom",
    },
    {
      target: '[data-tour="generation-prompt"], [data-tour="workspace-tabs"]',
      title: "最初の1枚を作る",
      body: "作りたい絵をここに書き、下の「この内容で生成」を押します。完成した画像は右側に並びます。",
      placement: "right",
    },
    {
      target: '[data-tour="help-button"]',
      title: "迷ったら左下の「?」",
      body: "今開いている画面の案内を、いつでも見直せます。はじめてガイドもここから再表示できます。",
      placement: "right",
    },
  ],
};
