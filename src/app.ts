import { App, ExpressReceiver } from '@slack/bolt';
import { config } from 'dotenv';
import { promises as fs } from 'fs';
import { format, parseISO, isValid } from 'date-fns';
import { ja } from 'date-fns/locale';
import path from 'path';
import { Request, Response } from 'express';

// 環境変数を読み込み
config();

// ExpressReceiverを作成
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
});

// Slack Appインスタンスを作成
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// エクスポートディレクトリを作成
const EXPORTS_DIR = path.join(__dirname, '..', 'exports');

// ディレクトリが存在しない場合は作成
async function ensureExportsDir() {
  try {
    await fs.access(EXPORTS_DIR);
  } catch {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  }
}

// 日時文字列をパース
function parseDateTime(dateStr: string): Date | null {
  try {
    // YYYY-MM-DD または YYYY-MM-DD HH:mm 形式をサポート
    const date = parseISO(dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`);
    return isValid(date) ? date : null;
  } catch {
    return null;
  }
}

// メッセージを整形
function formatMessage(message: any, users: Map<string, string>): string {
  const timestamp = new Date(parseFloat(message.ts) * 1000);
  const formattedTime = format(timestamp, 'yyyy-MM-dd HH:mm:ss', { locale: ja });
  const userName = users.get(message.user) || message.user || 'Unknown User';
  const text = message.text || '';
  
  return `[${formattedTime}] ${userName}: ${text}`;
}

// ユーザー情報を取得
async function getUsersInfo(app: App): Promise<Map<string, string>> {
  const users = new Map<string, string>();
  
  try {
    const result = await app.client.users.list();
    if (result.members) {
      result.members.forEach((member: any) => {
        users.set(member.id, member.real_name || member.name || member.id);
      });
    }
  } catch (error) {
    console.error('ユーザー情報の取得に失敗:', error);
  }
  
  return users;
}

// ヘルスチェックエンドポイント（Railway用）
receiver.router.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// スラッシュコマンド: /export-chat
app.command('/export-chat', async ({ command, ack, respond, client }) => {
  await ack();
  
  try {
    const args = command.text.trim().split(/\s+/);
    
    if (args.length < 2) {
      await respond({
        text: '使用方法: `/export-chat [開始日時] [終了日時]`\n例: `/export-chat 2024-01-01 2024-01-31`',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const startDateStr = args[0];
    const endDateStr = args[1];
    
    const startDate = parseDateTime(startDateStr);
    const endDate = parseDateTime(endDateStr);
    
    if (!startDate || !endDate) {
      await respond({
        text: '日時の形式が正しくありません。YYYY-MM-DD または YYYY-MM-DD HH:mm の形式で入力してください。',
        response_type: 'ephemeral'
      });
      return;
    }
    
    if (startDate >= endDate) {
      await respond({
        text: '開始日時は終了日時より前である必要があります。',
        response_type: 'ephemeral'
      });
      return;
    }
    
    await respond({
      text: 'チャット履歴をエクスポート中です... しばらくお待ちください。',
      response_type: 'ephemeral'
    });
    
    // チャンネル履歴を取得
    const channelId = command.channel_id;
    const startTs = Math.floor(startDate.getTime() / 1000).toString();
    const endTs = Math.floor(endDate.getTime() / 1000).toString();
    
    const messages: any[] = [];
    let cursor: string | undefined;
    
    do {
      const result = await client.conversations.history({
        channel: channelId,
        oldest: startTs,
        latest: endTs,
        limit: 200,
        cursor: cursor
      });
      
      if (result.messages) {
        messages.push(...result.messages);
      }
      
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    
    if (messages.length === 0) {
      await respond({
        text: '指定された期間にメッセージが見つかりませんでした。',
        response_type: 'ephemeral'
      });
      return;
    }
    
    // メッセージを時系列順にソート
    messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    
    // ユーザー情報を取得
    const users = await getUsersInfo(app);
    
    // チャンネル情報を取得
    let channelName = 'unknown-channel';
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      channelName = channelInfo.channel?.name || channelId;
    } catch (error) {
      console.error('チャンネル情報の取得に失敗:', error);
    }
    
    // ファイル内容を生成
    const header = `# ${channelName} チャット履歴\n` +
                  `エクスポート期間: ${format(startDate, 'yyyy-MM-dd')} ～ ${format(endDate, 'yyyy-MM-dd')}\n` +
                  `エクスポート日時: ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}\n` +
                  `メッセージ数: ${messages.length}\n\n` +
                  `${'='.repeat(50)}\n\n`;
    
    const messageLines = messages.map(msg => formatMessage(msg, users));
    const content = header + messageLines.join('\n');
    
    // ファイルを保存
    await ensureExportsDir();
    const fileName = `${channelName}_${format(startDate, 'yyyyMMdd')}-${format(endDate, 'yyyyMMdd')}.txt`;
    const filePath = path.join(EXPORTS_DIR, fileName);
    
    await fs.writeFile(filePath, content, 'utf-8');
    
    // Slackにファイルをアップロード
    await client.files.uploadV2({
      channels: channelId,
      file: await fs.readFile(filePath),
      filename: fileName,
      title: `${channelName} チャット履歴 (${format(startDate, 'yyyy-MM-dd')} ～ ${format(endDate, 'yyyy-MM-dd')})`,
      initial_comment: `チャット履歴のエクスポートが完了しました！\n期間: ${format(startDate, 'yyyy-MM-dd')} ～ ${format(endDate, 'yyyy-MM-dd')}\nメッセージ数: ${messages.length}件`
    });
    
  } catch (error) {
    console.error('エクスポート処理でエラーが発生:', error);
    
    let errorMessage = 'チャット履歴のエクスポート中にエラーが発生しました。';
    
    if (error instanceof Error) {
      if (error.message.includes('missing_scope')) {
        errorMessage += '\nボットに必要な権限が不足しています。管理者に権限の確認を依頼してください。';
      } else if (error.message.includes('channel_not_found')) {
        errorMessage += '\nチャンネルが見つかりません。';
      } else if (error.message.includes('rate_limited')) {
        errorMessage += '\nAPI制限に達しました。しばらく待ってから再試行してください。';
      }
    }
    
    await respond({
      text: errorMessage,
      response_type: 'ephemeral'
    });
  }
});

// アプリケーション開始
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(Number(port));
  console.log(`⚡️ Slack Bot が ポート ${port} で起動しました`);
})();
