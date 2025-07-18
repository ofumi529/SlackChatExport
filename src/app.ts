import { App, ExpressReceiver } from '@slack/bolt';
import { config } from 'dotenv';
import { format, parseISO, isValid, addHours } from 'date-fns';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Request, Response } from 'express';

require('dotenv').config();

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

// 日時文字列をパース（日本時間として扱う）
function parseDateTime(dateStr: string): Date | null {
  try {
    // YYYY-MM-DD または YYYY-MM-DD HH:mm 形式をサポート
    let isoString = dateStr;
    if (!dateStr.includes('T')) {
      isoString = `${dateStr}T00:00:00`;
    }
    const date = parseISO(isoString);
    if (!isValid(date)) return null;
    
    // 日本時間として扱うため、UTCから9時間引く（入力を日本時間として解釈）
    return addHours(date, -9);
  } catch {
    return null;
  }
}

// メッセージを整形（テキスト形式）
function formatMessage(message: any, users: Map<string, string>, indent: string = ''): string {
  const timestamp = new Date(parseFloat(message.ts) * 1000);
  const jstTimestamp = addHours(timestamp, 9);
  const formattedTime = format(jstTimestamp, 'yyyy-MM-dd HH:mm:ss');
  const userName = users.get(message.user) || message.user || 'Unknown User';
  const text = message.text || '';
  
  return `${indent}[${formattedTime}] ${userName}: ${text}`;
}

// メッセージをMarkdown形式で整形
function formatMessageMarkdown(message: any, users: Map<string, string>, indent: string = ''): string {
  const timestamp = new Date(parseFloat(message.ts) * 1000);
  const jstTimestamp = addHours(timestamp, 9);
  const formattedTime = format(jstTimestamp, 'yyyy-MM-dd HH:mm:ss');
  const userName = users.get(message.user) || message.user || 'Unknown User';
  const text = message.text || '';
  
  // Markdownフォーマット
  if (indent) {
    return `${indent}> **${userName}** \`${formattedTime}\`\n${indent}> ${text}\n`;
  } else {
    return `### ${userName} \`${formattedTime}\`\n\n${text}\n`;
  }
}

// スレッド返信を取得
async function getThreadReplies(client: any, channelId: string, threadTs: string): Promise<any[]> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 1000
    });
    
    if (result.messages && result.messages.length > 1) {
      // 最初のメッセージ（親メッセージ）を除く
      return result.messages.slice(1);
    }
    return [];
  } catch (error) {
    console.error('スレッド返信の取得に失敗:', error);
    return [];
  }
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

// ファイルダウンロードエンドポイント
receiver.router.get('/download/:filename', (req: Request, res: Response) => {
  const filename = req.params.filename;
  const filePath = path.join(EXPORTS_DIR, filename);
  
  // ファイルの存在確認
  if (!filename || !filename.match(/^[a-zA-Z0-9_-]+\.(txt|md)$/)) {
    res.status(400).send('Invalid filename');
    return;
  }
  
  res.download(filePath, (err) => {
    if (err) {
      console.error('File download error:', err);
      res.status(404).send('File not found');
    }
  });
});

// ファイル一覧表示エンドポイント
receiver.router.get('/files', async (req: Request, res: Response) => {
  try {
    await ensureExportsDir();
    const files = await fs.readdir(EXPORTS_DIR);
    const fileList = files.filter(f => f.endsWith('.txt') || f.endsWith('.md'));
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Slack Chat Export Files</title>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .file-item { margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
        .download-btn { background: #007cba; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px; }
        .download-btn:hover { background: #005a87; }
      </style>
    </head>
    <body>
      <h1>📄 Slack Chat Export Files</h1>
      <p>エクスポートされたチャット履歴ファイル一覧</p>
      ${fileList.length === 0 ? '<p>ファイルがありません</p>' : 
        fileList.map(file => `
          <div class="file-item">
            <strong>${file}</strong><br>
            <a href="/download/${file}" class="download-btn">📥 ダウンロード</a>
          </div>
        `).join('')
      }
      <hr>
      <p><small>ファイルは一定期間後に自動削除されます</small></p>
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    console.error('Files list error:', error);
    res.status(500).send('Error loading files');
  }
});

// Event Subscriptions URL検証処理
receiver.router.post('/slack/events', (req: Request, res: Response, next) => {
  // URL検証チャレンジ
  if (req.body && req.body.challenge) {
    res.status(200).send(req.body.challenge);
    return;
  }
  next();
});

// スラッシュコマンド: /export-chat
app.command('/export-chat', async ({ command, ack, respond, client }) => {
  console.log('Received /export-chat command:', command);
  await ack();
  console.log('Command acknowledged');
  
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
    
    // スレッド返信を含めたメッセージ処理（テキスト形式）
    const allMessages: string[] = [];
    const allMessagesMarkdown: string[] = [];
    let totalMessageCount = messages.length;
    
    for (const msg of messages) {
      // 親メッセージを追加
      allMessages.push(formatMessage(msg, users));
      allMessagesMarkdown.push(formatMessageMarkdown(msg, users));
      
      // スレッド返信があるかチェック
      if (msg.thread_ts && msg.thread_ts === msg.ts) {
        const replies = await getThreadReplies(client, channelId, msg.thread_ts);
        totalMessageCount += replies.length;
        
        // 返信をインデント付きで追加
        for (const reply of replies) {
          allMessages.push(formatMessage(reply, users, '  └─ '));
          allMessagesMarkdown.push(formatMessageMarkdown(reply, users, '  '));
        }
      }
    }
    
    // ファイル内容を生成（日本時間で表示）
    const now = new Date();
    const jstNow = addHours(now, 9);
    const jstStartDate = addHours(startDate, 9);
    const jstEndDate = addHours(endDate, 9);
    
    // テキスト形式のヘッダー
    const headerText = `# ${channelName} チャット履歴\n` +
                      `エクスポート期間: ${format(jstStartDate, 'yyyy-MM-dd')} ～ ${format(jstEndDate, 'yyyy-MM-dd')} (JST)\n` +
                      `エクスポート日時: ${format(jstNow, 'yyyy-MM-dd HH:mm:ss')} (JST)\n` +
                      `メッセージ数: ${totalMessageCount}件 (スレッド返信含む)\n\n` +
                      `${'='.repeat(50)}\n\n`;
    
    // Markdown形式のヘッダー
    const headerMarkdown = `# ${channelName} チャット履歴\n\n` +
                          `**エクスポート期間**: ${format(jstStartDate, 'yyyy-MM-dd')} ～ ${format(jstEndDate, 'yyyy-MM-dd')} (JST)\n` +
                          `**エクスポート日時**: ${format(jstNow, 'yyyy-MM-dd HH:mm:ss')} (JST)\n` +
                          `**メッセージ数**: ${totalMessageCount}件 (スレッド返信含む)\n\n` +
                          `---\n\n`;
    
    const contentText = headerText + allMessages.join('\n');
    const contentMarkdown = headerMarkdown + allMessagesMarkdown.join('\n');
    
    // ファイルを保存
    await ensureExportsDir();
    const baseFileName = `${channelName}_${format(jstStartDate, 'yyyyMMdd')}-${format(jstEndDate, 'yyyyMMdd')}`;
    const txtFileName = `${baseFileName}.txt`;
    const mdFileName = `${baseFileName}.md`;
    const txtFilePath = path.join(EXPORTS_DIR, txtFileName);
    const mdFilePath = path.join(EXPORTS_DIR, mdFileName);
    
    await fs.writeFile(txtFilePath, contentText, 'utf-8');
    await fs.writeFile(mdFilePath, contentMarkdown, 'utf-8');
    
    // Railwayのドメインを取得（環境変数またはデフォルト）
    const domain = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app-domain.up.railway.app';
    
    // Slackにファイルをアップロード（テキスト形式）
    await client.files.uploadV2({
      channels: channelId,
      file: await fs.readFile(txtFilePath),
      filename: txtFileName,
      title: `${channelName} チャット履歴 (${format(jstStartDate, 'yyyy-MM-dd')} ～ ${format(jstEndDate, 'yyyy-MM-dd')} JST)`,
      initial_comment: `チャット履歴のエクスポートが完了しました！\n\n` +
                      `📅 **期間**: ${format(jstStartDate, 'yyyy-MM-dd')} ～ ${format(jstEndDate, 'yyyy-MM-dd')} (JST)\n` +
                      `💬 **メッセージ数**: ${totalMessageCount}件 (スレッド返信含む)\n\n` +
                      `📥 **ダウンロードリンク**:\n` +
                      `・ テキスト形式: https://${domain}/download/${txtFileName}\n` +
                      `・ Markdown形式: https://${domain}/download/${mdFileName}\n` +
                      `・ ファイル一覧: https://${domain}/files`
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

// グローバルエラーハンドリング
app.error(async (error) => {
  console.error('Global error occurred:', error);
});

// アプリケーション開始
(async () => {
  try {
    const port = process.env.PORT || 3000;
    console.log('Starting Slack Bot...');
    console.log('Environment variables check:');
    console.log('- SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'Set' : 'Not set');
    console.log('- SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'Set' : 'Not set');
    console.log('- PORT:', port);
    
    await app.start(Number(port));
    console.log(`⚡️ Slack Bot が ポート ${port} で起動しました`);
  } catch (error) {
    console.error('Failed to start app:', error);
    process.exit(1);
  }
})();
