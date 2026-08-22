import type { TourDefinition } from "./types";

export const PAGE_TOURS = {
  planning: {
    id: "planning",
    steps: [
      {
        target: '[data-tour="planning-workspace"]',
        title: "作りたいものを相談する場所",
        body: "思いつきをAIとの会話で整理し、画像や動画を作るための指示文にまとめる画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="planning-input"]',
        title: "まず一言を書いて送る",
        body: "完成した文章でなくて大丈夫です。作りたいものを普段の言葉で書き、Enterで送ります。ShiftとEnterなら改行できます。",
        placement: "top",
      },
      {
        target: '[data-tour="planning-workspace"] button[title*="採用"]',
        title: "できた指示文を制作へ渡す",
        body: "AIが出した指示文は、画像用か動画用の「採用」から対応する生成タブへ渡せます。コピーだけすることもできます。",
        placement: "left",
      },
    ],
  },
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
  videoGeneration: {
    id: "video-generation",
    steps: [
      {
        target: '[data-tour="video-generation-workspace"]',
        title: "動画を作る場所",
        body: "場面と動きを決め、文章だけ、または元画像から動画を生成する画面です。右側で完成した動画を見返せます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="video-generation-builder"]',
        title: "まず場面を組み立てる",
        body: "左の項目から被写体やカメラの動きを選びます。画像を元にする場合は、画像生成側から送った元画像もここに表示されます。",
        placement: "right",
      },
      {
        target: '[data-tour="video-generation-prompt"]',
        title: "動きを言葉で足す",
        body: "選択内容に加えて自由な指示も書けます。i2vは、画像を元に動画へ動かす方式のことです。",
        placement: "right",
      },
      {
        target: '[data-tour="video-generation-submit"]',
        title: "接続と内容を確認して生成する",
        body: "動画生成にはHiggsfieldの接続を使います。未接続なら設定の「接続先」でつないでから、このボタンで生成します。",
        placement: "top",
      },
      {
        target: '[data-tour="video-generation-workspace"] > :nth-child(2)',
        title: "完成結果を見返す",
        body: "生成した画像や動画は右のタイムラインに並びます。ここから拡大や次の作業へ進めます。",
        placement: "left",
      },
    ],
  },
  editing: {
    id: "editing",
    steps: [
      {
        target: '[data-tour="editing-workspace"]',
        title: "画像を直す場所",
        body: "画像を選び、部分修正、文字入れ、調整、切り抜き、背景透過などを行う画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="editing-toolbar"]',
        title: "まず画像を選ぶ",
        body: "編集する画像を選ぶと、ここに名前と戻す・やり直す・保存の操作が出ます。「作品にする」はアプリ内へ、「書き出し」は選んだ保存先へ出します。",
        placement: "bottom",
      },
      {
        target: '[data-tour="editing-tools"]',
        title: "やりたい直し方を選ぶ",
        body: "画像を選んだ後、この列から操作を一つ選びます。迷ったら「ことばで直す」で、直したい場所と内容を指定してください。",
        placement: "bottom",
      },
      {
        target: '[data-tour="editing-canvas"]',
        title: "中央で場所を決める",
        body: "画像の上をドラッグすると、直す範囲を囲めます。囲まなければ画像全体が対象です。外したいときはEscで選択・移動に戻れます。",
        placement: "right",
      },
      {
        target: '[data-tour="editing-options"]',
        title: "右側で内容を指定する",
        body: "選んだ操作の詳しい設定がここに出ます。文字や色、AIへの修正指示など、今の操作に必要な項目だけが表示されます。",
        placement: "left",
      },
    ],
  },
  library: {
    id: "library",
    steps: [
      {
        target: '[data-tour="library-sidebar"]',
        title: "画像と動画を探す場所",
        body: "生成・追加した素材をまとめて見返す画面です。まず左で検索、お気に入り、画像・動画、プロジェクトのどれかに絞れます。",
        placement: "right",
      },
      {
        target: '[data-tour="library-grid"]',
        title: "日付順に素材を見る",
        body: "素材は日付ごとに並びます。クリックで参照に使い、ダブルクリックで大きく確認できます。",
        placement: "left",
      },
      {
        target: '[data-tour="library-grid"] button[aria-label$="件を一括選択"]',
        title: "同じ日の素材をまとめて選ぶ",
        body: "日付見出しのチェックを押すと、その日の素材をまとめて選択できます。不要なものだけ後から外せます。",
        placement: "right",
      },
      {
        target: 'input[aria-label="タイルサイズ"]',
        title: "見やすい大きさに変える",
        body: "上のスライダーで一覧の画像サイズを変えられます。素材そのものの大きさや画質は変わりません。",
        placement: "bottom",
      },
      {
        target: '[data-tour="library-selection-bar"]',
        title: "選んだ素材を一括操作する",
        body: "選択すると下に一括バーが出ます。保存、プロジェクト追加、お気に入り、削除をまとめて行えます。削除だけは確認してから実行されます。",
        placement: "top",
      },
    ],
  },
  projects: {
    id: "projects",
    steps: [
      {
        target: 'section:has(input[placeholder^="新しいプロジェクト名"])',
        title: "案件ごとに作品をまとめる場所",
        body: "画像と企画チャットを、案件や用途ごとの箱にまとめる画面です。チャット履歴とは別に、完成素材を整理できます。",
        placement: "bottom",
      },
      {
        target: 'input[placeholder^="新しいプロジェクト名"]',
        title: "まず箱の名前を付ける",
        body: "商品名や案件名など、後から見て分かる名前を書き、右の「作成」を押します。",
        placement: "bottom",
      },
      {
        target: 'input[placeholder^="新しいプロジェクト名"] + button',
        title: "作った箱を開く",
        body: "作成後はカードから中身を開けます。名前の変更や削除もカードから行えます。",
        placement: "left",
      },
      {
        target: 'section:has(input[placeholder^="新しいプロジェクト名"]) > div.grid, button[title^="画像・プロンプト・企画チャット"]',
        title: "記録と画像を確認する",
        body: "詳細では企画チャットと生成画像がまとまります。必要なら、どの指示で何を作ったかをCSVという表形式の記録で書き出せます。",
        placement: "top",
      },
    ],
  },
  presets: {
    id: "presets",
    steps: [
      {
        target: '[data-tour="preset-categories"]',
        title: "繰り返し使う設定を整理する",
        body: "よく使う指示文や登録キャラを保存しておく画面です。左のカテゴリで用途ごとに分けられます。",
        placement: "right",
      },
      {
        target: '[data-tour="preset-list"]',
        title: "保存した内容を見る",
        body: "右側に選んだカテゴリのプリセットが並びます。表示方法や並び順も上部で変更できます。",
        placement: "left",
      },
      {
        target: '[data-tour="preset-search"]',
        title: "名前や本文から探す",
        body: "名前、指示文の本文、メモで検索できます。「キャラ」を押すとキャラクター登録だけに絞れます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="preset-new"]',
        title: "新しいプリセットを作る",
        body: "ここから名前と内容を登録します。サムネイルやタグを付けておくと、後で見つけやすくなります。",
        placement: "left",
      },
    ],
  },
  chatHistory: {
    id: "chat-history",
    steps: [
      {
        target: 'section:has(input[placeholder^="履歴を検索"])',
        title: "過去の会話を開き直す場所",
        body: "未保存の企画、案件の企画、画像・動画の制作チャットをまとめて見返す画面です。",
        placement: "bottom",
      },
      {
        target: 'input[placeholder^="履歴を検索"]',
        title: "まず言葉で探す",
        body: "タイトルや企画チャットの本文から検索できます。探す言葉を消すと全履歴へ戻ります。",
        placement: "bottom",
      },
      {
        target: 'button[aria-label="セッションを開く"], section:has(input[placeholder^="履歴を検索"])',
        title: "選ぶと当時の状態を開ける",
        body: "制作チャットを開くと、当時の会話と生成結果を一緒に表示します。未保存や案件の企画チャットも、それぞれの続きを開けます。",
        placement: "left",
      },
      {
        target: 'button[title="名前を変更"], button[title="このチャット履歴を削除"]',
        title: "名前変更と削除は行ごとに行う",
        body: "行に触れると名前変更と削除が出ます。履歴を削除しても、すでに生成した画像ファイルはライブラリに残ります。",
        placement: "left",
      },
    ],
  },
  errorLog: {
    id: "error-log",
    steps: [
      {
        target: '[data-tour="error-log-dialog"]',
        title: "困った記録を後から確認する",
        body: "一時表示が消えた後でも、いつ・どこで・何が起きたかを見返す画面です。新しいものから順に並びます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="error-log-list"]',
        title: "項目を開いて詳しく見る",
        body: "項目を押すと、詳しい内容がある場合だけ展開します。問い合わせ時は一件ずつコピーできます。",
        placement: "right",
      },
      {
        target: '[data-tour="error-log-actions"]',
        title: "まとめてコピーか整理をする",
        body: "「すべてコピー」で報告用にまとめられます。「クリア」は記録を消す操作なので、必要な内容をコピーしてから使ってください。",
        placement: "left",
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
        target: 'nav[aria-label="フィルム制作工程"] button:nth-of-type(1)',
        title: "まず目的をAIと決める",
        body: "①企画では、作りたい映像をAIアドバイザーへ一言ずつ伝えます。AIが次の一歩を提案するので、OKか短い修正で進められます。",
        placement: "right",
      },
      {
        target: 'nav[aria-label="フィルム制作工程"] button:nth-of-type(2)',
        title: "②脚本も会話で進める",
        body: "一文のあらすじから場面一覧、動画生成一回ごとの脚本まで、AIと話しながら順番に決めます。成果物は確認してから承認します。",
        placement: "right",
      },
      {
        target: 'nav[aria-label="フィルム制作工程"] button:nth-of-type(3)',
        title: "③見た目と素材の設計を固める",
        body: "アセット台帳、伏線、全体の見た目を先に整理します。後の生成で人物や小物が途中から変わるのを防ぐ工程です。",
        placement: "right",
      },
      {
        target: 'nav[aria-label="フィルム制作工程"] button:nth-of-type(4)',
        title: "④アセット工場で素材をそろえる",
        body: "台帳にある人物や小物ごとに指示文を作り、候補を3枚生成して人の目で選びます。採用した素材を固定してから先へ進みます。",
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
  storyboard: {
    id: "storyboard",
    steps: [
      {
        target: '[data-tour="storyboard-workspace"]',
        title: "話から連続カットを作る",
        body: "AIとの相談、絵コンテ確認、画像生成、完成確認の4段階で、同じ人物と絵柄のカットを続けて作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="storyboard-phases"]',
        title: "左で今の段階を確認する",
        body: "目的、絵コンテ、生成、確認の順に進みます。前の段階へ戻って内容を直すこともできます。",
        placement: "right",
      },
      {
        target: '[data-tour="storyboard-content"]',
        title: "まず作りたい映像を話す",
        body: "最初はAIが質問しながら、誰が何をする映像かを整理します。短い答えでも大丈夫です。",
        placement: "left",
      },
      {
        target: '[data-tour="storyboard-workspace"] [data-tour="workspace-tabs"]',
        title: "動画や編集へそのまま進める",
        body: "生成したカットは上の動画生成や編集タブへ渡せます。画像生成へ戻ると、この4段階の作業を続けられます。",
        placement: "bottom",
      },
    ],
  },
  comic: {
    id: "comic",
    steps: [
      {
        target: '[data-tour="comic-workspace"]',
        title: "話から漫画ページを作る",
        body: "あらすじを渡し、ページ構成とコマ割りを確認してから漫画ページを生成する画面です。複数ページの物語にも対応します。",
        placement: "bottom",
      },
      {
        target: '[data-tour="comic-phases"]',
        title: "左の3段階で進む",
        body: "話とキャラ、構成確認、ページ生成の順です。まずは一番上の入力から始めます。",
        placement: "right",
      },
      {
        target: '[data-tour="comic-content"]',
        title: "最初にあらすじと登場人物を決める",
        body: "作りたい話を書き、ページ数、コマ割り、読み方向、登場キャラを選びます。環境の参考画像も必要なときだけ追加できます。",
        placement: "left",
      },
      {
        target: '[data-tour="comic-workspace"] textarea',
        title: "文字は最後に目で確認する",
        body: "吹き出しや擬音は漫画の絵として生成されるため、文字が崩れることがあります。完成後にページごと確認してください。",
        placement: "top",
      },
    ],
  },
  sticker: {
    id: "sticker",
    steps: [
      {
        target: '[data-tour="sticker-workspace"]',
        title: "画像からLINEスタンプ一式を作る",
        body: "キャラや画像を一枚選び、挨拶や返事の絵をまとめて生成し、使うものを選んで書き出す画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="sticker-phases"]',
        title: "4段階で進む",
        body: "素材と内容、生成、採用、点検と書き出しの順です。上の表示で今いる段階が分かります。",
        placement: "bottom",
      },
      {
        target: '[data-tour="sticker-setup"]',
        title: "まず元画像と枚数を決める",
        body: "登録キャラか手元の画像を選び、作る枚数と内容の方向を決めます。セリフ文字は入れず、絵だけを生成します。",
        placement: "right",
      },
      {
        target: '[data-tour="sticker-pick"]',
        title: "使う絵だけを選ぶ",
        body: "生成後は一覧で採用を決めます。気になる一枚だけを直したり、採用した絵へ後から文字を置いたりできます。",
        placement: "top",
      },
      {
        target: '[data-tour="sticker-export"]',
        title: "画像規格を点検して書き出す",
        body: "サイズ、透過、余白、容量を機械で点検します。審査に通るかはLINE側の判断なので、公式ガイドラインも確認してください。",
        placement: "top",
      },
    ],
  },
  multiAngle: {
    id: "multi-angle",
    steps: [
      {
        target: '[data-tour="multi-angle-workspace"]',
        title: "一枚から別アングルをまとめて作る",
        body: "被写体と周りの位置関係を保ちながら、選んだ向きや距離の画像を一度に作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="multi-angle-settings"]',
        title: "まず元画像を選ぶ",
        body: "左で被写体の画像を一枚選び、必要な構図、環境、縦横比を設定します。構図は最大30個まで選べます。",
        placement: "right",
      },
      {
        target: '[data-tour="multi-angle-results"]',
        title: "右に結果が並ぶ",
        body: "選んだ構図ごとの画像が、終わったものから表示されます。拡大、個別の作り直し、プロジェクト保存ができます。",
        placement: "left",
      },
      {
        target: '[data-tour="multi-angle-workspace"] button[title*="最初から"]',
        title: "別の被写体は新規開始する",
        body: "前の被写体や結果を残したくないときは「新規開始」を使います。生成中は結果の置き場を失わないよう押せません。",
        placement: "left",
      },
    ],
  },
  productSet: {
    id: "product-set",
    steps: [
      {
        target: '[data-tour="product-set-workspace"]',
        title: "商品写真からEC用の一式を作る",
        body: "一枚の商品写真から、白背景、使用場面、細部の寄りなど、販売ページに使う画像をまとめて作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="product-set-settings"]',
        title: "まず商品写真を選ぶ",
        body: "左で写真を選び、商品説明と必要な納品カットを決めます。品番を入れると、書き出すファイル名にも使われます。",
        placement: "right",
      },
      {
        target: '[data-tour="product-set-results"]',
        title: "右で結果を確認する",
        body: "各カットは終わった順に並びます。個別の作り直し、プロジェクト保存、パソコンへの保存ができます。",
        placement: "left",
      },
      {
        target: '[data-tour="product-set-results"] input[aria-label="出力タイルのサイズ"]',
        title: "一覧の大きさだけ変えられる",
        body: "スライダーは結果の見た目の大きさを調整します。書き出す画像の画質や寸法は変わりません。",
        placement: "bottom",
      },
    ],
  },
  characterRegister: {
    id: "character-register",
    steps: [
      {
        target: '[data-tour="character-register-workspace"]',
        title: "同じキャラを繰り返し使えるようにする",
        body: "キャラの絵を一枚から六枚渡し、いろいろな向きが入ったシートを作って登録する画面です。登録後は他のスキルから呼び出せます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="character-register-steps"]',
        title: "入力、生成、登録の順に進む",
        body: "上の三段階で今の位置を確認できます。生成中のキャラは仕込み中の列に残るため、別のキャラの準備もできます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="character-register-input"]',
        title: "まず参照画像を選ぶ",
        body: "一枚目が見た目の基準です。二枚目以降は別角度や衣装の資料として使い、最大六枚まで追加できます。",
        placement: "right",
      },
      {
        target: '[data-tour="character-sheet-type"]',
        title: "シートの種類を選ぶ",
        body: "「種類を変更する」から、必要な見せ方のシートを選べます。背景色や変えたくない外見の特徴もここで指定します。",
        placement: "right",
      },
      {
        target: '[data-tour="character-register-result"]',
        title: "結果を確認して登録する",
        body: "完成したシートを目で確認して登録します。登録先はプリセットの「キャラクター」で、登録後は次に使えるスキルも表示されます。",
        placement: "left",
      },
    ],
  },
  expressionSet: {
    id: "expression-set",
    steps: [
      {
        target: '[data-tour="expression-set-workspace"]',
        title: "登録キャラの表情だけを変える",
        body: "登録済みの顔を保ちながら、笑顔や怒りなど選んだ表情の画像をまとめて作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="expression-set-steps"]',
        title: "選択してから結果を確認する",
        body: "キャラと表情を選ぶ段階、生成結果を見る段階の順です。まずは一段目から始めます。",
        placement: "bottom",
      },
      {
        target: '[data-tour="expression-set-settings"]',
        title: "まずキャラと表情を選ぶ",
        body: "左で登録キャラを一体選び、必要な表情へチェックを入れます。先にキャラクター登録が必要です。",
        placement: "right",
      },
      {
        target: '[data-tour="expression-set-results"]',
        title: "似ているか最後に目で確認する",
        body: "右に完成した表情が並びます。自動で作り直さないため、同じキャラに見えるか確認して必要な一枚だけ再生成します。",
        placement: "left",
      },
    ],
  },
  scene3d: {
    id: "scene-3d",
    steps: [
      {
        target: '[data-tour="scene-3d-workspace"]',
        title: "3D空間で画面の動きを設計する",
        body: "人物や小物を置き、カメラを動かして、画像・動画生成に使う開始画像と動きの見本を作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="scene-3d-assets"]',
        title: "左は素材を置く場所",
        body: "まず「シーンに置く」から人物か小物を追加します。手元の画像から自動配置を始めることもできます。",
        placement: "right",
      },
      {
        target: '[data-tour="scene-3d-camera"]',
        title: "中央はカメラと舞台",
        body: "中央で物の位置とカメラの見え方を確認します。下の時間の列では、カメラの動く順番を調整できます。",
        placement: "top",
      },
      {
        target: '[data-tour="scene-3d-director"]',
        title: "右は監督チャット",
        body: "やりたい演出を普段の言葉で相談する場所です。AIの提案を確認してから、カメラや動きへ反映します。",
        placement: "left",
      },
      {
        target: '[data-tour="scene-3d-camera"]',
        title: "完成物は動画そのものではない",
        body: "ここで出すのは動画生成に渡す開始画像と動きの見本です。最終動画は動画生成タブで作ります。",
        placement: "top",
      },
    ],
  },
  sceneRecreate: {
    id: "scene-recreate",
    steps: [
      {
        target: '[data-tour="scene-recreate-workspace"]',
        title: "参考映像の画作りを読み解く",
        body: "映像のスクリーンショットから構図、光、カメラの動きを言葉にし、自分のキャラや商品で再現する指示文を作る画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="scene-recreate-input"]',
        title: "まず場面を時間順に入れる",
        body: "左へ画像を数枚追加するか、動画ファイルから場面を切り出します。YouTubeなどのURLは直接読めません。",
        placement: "right",
      },
      {
        target: '[data-tour="scene-recreate-run"]',
        title: "映像文法で分析する",
        body: "場面がそろったら分析を実行します。参考動画のどこが良いかを補足すると、意図に近い読み解きになります。",
        placement: "right",
      },
      {
        target: '[data-tour="scene-recreate-results"]',
        title: "右に再現用の指示が出る",
        body: "ショットごとのカメラワークと演出意図、再現用の指示文を確認できます。必要なら3Dシーン演出へ送れます。",
        placement: "left",
      },
    ],
  },
  redline: {
    id: "redline",
    steps: [
      {
        target: '[data-tour="redline-workspace"]',
        title: "赤入れを直しの指示に変える",
        body: "赤ペンや注釈が入った画像を読み、どこをどう直すかを日本語の一覧にする画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="redline-inputs"]',
        title: "左に元画像、右に赤入れを入れる",
        body: "元画像があると変更前後の差を説明できます。赤入れだけでも読めますが、差分の説明は付きません。",
        placement: "bottom",
      },
      {
        target: '[data-tour="redline-run"]',
        title: "読み取りを実行する",
        body: "画像を確認してからこのボタンを押します。複数ページのPDFは、使う一ページを選んでから読み取ります。",
        placement: "top",
      },
      {
        target: '[data-tour="redline-results"]',
        title: "曖昧な指示は人が確認する",
        body: "読み取った指示が一覧になります。「要確認」はAIが推測で埋めていない箇所です。修正後の自動検品はまだ未対応です。",
        placement: "top",
      },
    ],
  },
  regulationCheck: {
    id: "regulation-check",
    steps: [
      {
        target: '[data-tour="regulation-workspace"]',
        title: "入稿前の画像を点検する",
        body: "媒体の画像規格を機械で測り、表現上の注意をAIが理由付きで示す画面です。",
        placement: "bottom",
      },
      {
        target: '[data-tour="regulation-settings"]',
        title: "まず媒体と画像を選ぶ",
        body: "左で出す先のルールを選び、検査したい画像を追加します。必要なら案件だけの追加ルールも書けます。",
        placement: "right",
      },
      {
        target: '[data-tour="regulation-run"]',
        title: "検査を実行する",
        body: "機械で寸法などを確認した後、AIが画像の見た目と文字を確認します。処理が終わるまで左の設定は変更できません。",
        placement: "right",
      },
      {
        target: '[data-tour="regulation-results"]',
        title: "結果を保存して人でも確認する",
        body: "右に指摘が並び、文章のコピーや報告ファイルの保存ができます。審査通過や適法性の保証ではないため、最新の媒体画面も確認してください。",
        placement: "left",
      },
    ],
  },
  settingsConnections: {
    id: "settings-connections",
    steps: [
      {
        target: "section:has(> div > nav button) > div > nav",
        title: "設定する内容を左から選ぶ",
        body: "基本、保存先、アカウント、接続先を切り替える場所です。診断が表示されている版では、動かない原因の確認もここから行えます。",
        placement: "right",
      },
      {
        target: 'nav button:nth-of-type(1)[class*="bg-[#303030]"]',
        title: "基本設定を整える",
        body: "文字サイズ、既定のAIモデル、作業フォルダなどを決めます。文字サイズ以外は、変更後に保存ボタンを押してください。",
        placement: "right",
      },
      {
        target: 'section:has(> div > nav button:nth-of-type(2)[class*="bg-[#303030]"]) > div > div:last-child',
        title: "保存先と容量を確認する",
        body: "生成画像などの保存場所と、種類ごとの使用量を確認する画面です。保存先を変える前は、画面の説明とバックアップ状態を確認してください。",
        placement: "left",
      },
      {
        target: 'section:has(> div > nav button:nth-of-type(2)[class*="bg-[#303030]"]) button',
        title: "一時データだけを選んで削除する",
        body: "容量の内訳から消す項目を選び、「選んだものを削除」で整理します。作品、画像、登録データは削除対象に含まれないと画面で確認してから実行します。",
        placement: "left",
      },
      {
        target: 'section:has(> div > nav button:nth-of-type(3)[class*="bg-[#303030]"]) > div > div:last-child',
        title: "アカウントの状態を確認する",
        body: "まずCodexのログイン状態を確認します。HiggsfieldやMagnificは必要な機能を使うときだけ接続し、問題があればテスト接続で確かめます。",
        placement: "left",
      },
      {
        target: 'section:has(> div > nav button:nth-of-type(4)[class*="bg-[#303030]"]) > div > div:last-child',
        title: "外部サービスを接続する",
        body: "MCPという共通の窓口から、画像・動画などの外部サービスを追加する画面です。使うサービスだけ接続すれば大丈夫です。",
        placement: "left",
      },
      {
        target: 'section:has(> div > nav button:nth-of-type(5)[class*="bg-[#303030]"]) > div > div:last-child',
        title: "動かない原因をまとめて診断する",
        body: "「診断を実行」でアプリ、Codex、通信、接続先、一時データを確認します。診断だけでは設定や作品を変更せず、報告用の情報をコピーできます。",
        placement: "left",
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
