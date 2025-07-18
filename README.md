# Slack Chat Export Bot

Slackチャンネルのメッセージ履歴をエクスポートするボットアプリケーションです。

## 機能

- `/export-chat` スラッシュコマンドでチャット履歴をエクスポート
- 指定期間のメッセージを取得・整形
- テキストファイルとしてSlackチャンネルにアップロード

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Slack Appの作成

1. [Slack API](https://api.slack.com/apps) にアクセス
2. "Create New App" → "From scratch" を選択
3. App名とワークスペースを設定

### 3. 必要な権限の設定

**OAuth & Permissions** で以下のスコープを追加：

- `channels:history` - チャンネル履歴の読み取り
- `groups:history` - プライベートチャンネル履歴の読み取り
- `im:history` - ダイレクトメッセージ履歴の読み取り
- `mpim:history` - グループDM履歴の読み取り
- `files:write` - ファイルのアップロード
- `commands` - スラッシュコマンドの使用
- `users:read` - ユーザー情報の取得
- `channels:read` - チャンネル情報の取得

### 4. スラッシュコマンドの設定

**Slash Commands** で新しいコマンドを作成：

- Command: `/export-chat`
- Request URL: `https://your-domain.com/slack/events`
- Short Description: `チャット履歴をエクスポート`
- Usage Hint: `[開始日時] [終了日時]`

### 5. 環境変数の設定

`.env.example` を `.env` にコピーして設定：

```bash
cp .env.example .env
```

`.env` ファイルを編集：

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
PORT=3000
```

### 6. アプリのインストール

**Install App** でワークスペースにインストール

## 使用方法

### 開発環境での実行

```bash
# TypeScriptをコンパイル
npm run build

# アプリケーション開始
npm start

# または開発モード（ホットリロード）
npm run dev
```

### コマンドの使用

Slackで以下のコマンドを実行：

```
/export-chat 2024-01-01 2024-01-31
```

**パラメータ:**
- 開始日時: YYYY-MM-DD 形式
- 終了日時: YYYY-MM-DD 形式

## プロジェクト構成

```
slack-chat-export-bot/
├── src/
│   └── app.ts          # メインアプリケーション
├── dist/               # コンパイル済みファイル
├── exports/            # エクスポートファイル保存先
├── package.json        # 依存関係
├── tsconfig.json       # TypeScript設定
├── .env.example        # 環境変数テンプレート
├── .env                # 環境変数（要作成）
└── README.md           # このファイル
```

## エラーハンドリング

- **日時フォーマットエラー**: 正しい形式で入力してください
- **権限不足エラー**: 必要なスコープが設定されているか確認
- **API制限**: しばらく待ってから再試行
- **チャンネル未発見**: 正しいチャンネルで実行しているか確認

## 注意事項

- 大量のメッセージをエクスポートする場合、時間がかかる場合があります
- Slack APIの制限により、一度に取得できるメッセージ数に上限があります
- プライベートチャンネルの場合、ボットがチャンネルに参加している必要があります

## トラブルシューティング

### ボットが応答しない場合

1. 環境変数が正しく設定されているか確認
2. ボットがワークスペースにインストールされているか確認
3. 必要な権限が付与されているか確認

### ファイルアップロードに失敗する場合

1. `files:write` 権限が設定されているか確認
2. ボットがチャンネルに参加しているか確認

## ライセンス

MIT License
