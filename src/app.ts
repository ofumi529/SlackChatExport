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

// スレッド返信を取得（レート制限対応）
async function getThreadReplies(client: any, channelId: string, threadTs: string): Promise<any[]> {
  try {
    // API呼び出し前に遅延を追加（レート制限回避）
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5秒遅延
    
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
    
    // レート制限エラーの場合はさらに待機
    if ((error as any).code === 'slack_webapi_rate_limited') {
      const retryAfter = (error as any).retryAfter || 60;
      console.log(`Rate limited. Waiting ${retryAfter} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      
      // 再試行
      try {
        const retryResult = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 1000
        });
        
        if (retryResult.messages && retryResult.messages.length > 1) {
          return retryResult.messages.slice(1);
        }
      } catch (retryError) {
        console.error('リトライでも失敗:', retryError);
      }
    }
    
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
  
  // 即座に処理開始を通知
  await respond({
    text: 'チャット履歴をエクスポート中です... しばらくお待ちください。',
    response_type: 'ephemeral'
  });
  
  // バックグラウンドで処理を実行
  processExportAsync(command, respond, client).catch(error => {
    console.error('Async export process failed:', error);
  });
});

// 非同期エクスポート処理
async function processExportAsync(command: any, respond: any, client: any) {
  console.log('Starting async export process...');
  try {
    const args = command.text.trim().split(/\s+/);
    console.log('Command args:', args);
    
    if (args.length < 2) {
      await respond({
        text: '使用方法: `/export-chat 開始日 終了日 [オプション]`\n例: `/export-chat 2024-01-01 2024-01-31`\n例: `/export-chat 2024-01-01 2024-01-31 --no-threads` (スレッドをスキップ)\n\n日付はJST（日本時間）で指定してください。',
        response_type: 'ephemeral'
      });
      return;
    }
    
    const startDateStr = args[0];
    const endDateStr = args[1];
    const skipThreads = args.includes('--no-threads');
    
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
    
    console.log('Sending progress message...');
    await respond({
      text: 'チャット履歴をエクスポート中です... しばらくお待ちください。',
      response_type: 'ephemeral'
    });
    console.log('Progress message sent');
    
    // チャンネル履歴を取得
    console.log('Fetching channel history...');
    const channelId = command.channel_id;
    const startTs = Math.floor(startDate.getTime() / 1000).toString();
    const endTs = Math.floor(endDate.getTime() / 1000).toString();
    console.log(`Channel: ${channelId}, Start: ${startTs}, End: ${endTs}`);
    
    const messages: any[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    
    do {
      pageCount++;
      console.log(`Fetching page ${pageCount}...`);
      const result = await client.conversations.history({
        channel: channelId,
        oldest: startTs,
        latest: endTs,
        limit: 200,
        cursor: cursor
      });
      
      if (result.messages) {
        messages.push(...result.messages);
        console.log(`Got ${result.messages.length} messages, total: ${messages.length}`);
      }
      
      cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    
    console.log(`Finished fetching messages. Total: ${messages.length}`);
    
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
    console.log('Fetching user info...');
    const users = await getUsersInfo(app);
    console.log(`Got info for ${users.size} users`);
    
    // チャンネル情報を取得
    let channelName = 'unknown-channel';
    try {
      const channelInfo = await client.conversations.info({ channel: channelId });
      channelName = channelInfo.channel?.name || channelId;
    } catch (error) {
      console.error('チャンネル情報の取得に失敗:', error);
    }
    
    // スレッド返信を含めたメッセージ処理（テキスト形式）
    console.log('Processing messages and threads...');
    const allMessages: string[] = [];
    const allMessagesMarkdown: string[] = [];
    let totalMessageCount = messages.length;
    
    // スレッドを持つメッセージを特定
    const threadMessages = messages.filter(msg => msg.thread_ts && msg.thread_ts === msg.ts);
    console.log(`Found ${threadMessages.length} thread parent messages`);
    
    // メッセージを処理（スレッドは後でバッチ処理）
    for (const msg of messages) {
      // 親メッセージを追加
      allMessages.push(formatMessage(msg, users));
      allMessagesMarkdown.push(formatMessageMarkdown(msg, users));
    }
    
    // スレッド返信をバッチ処理（レート制限回避）
    if (threadMessages.length > 0 && !skipThreads) {
      console.log('Processing thread replies in batches...');
      
      // 処理時間の見積もりを通知
      const estimatedMinutes = Math.ceil((threadMessages.length * 5) / 60);
      await respond({
        text: `💬 ${threadMessages.length}個のスレッドを処理中です...　約${estimatedMinutes}分かかります。　レート制限回避のため、各スレッド間に5秒の間隔をあけています。`,
        response_type: 'ephemeral'
      });
      
      for (let i = 0; i < threadMessages.length; i++) {
        const msg = threadMessages[i];
        console.log(`Processing thread ${i + 1}/${threadMessages.length}: ${msg.thread_ts}`);
        
        const replies = await getThreadReplies(client, channelId, msg.thread_ts!);
        totalMessageCount += replies.length;
        
        // 返信をメッセージの適切な位置に挿入
        const parentIndex = allMessages.findIndex(m => m.includes(msg.ts!));
        if (parentIndex !== -1) {
          const replyTexts = replies.map(reply => formatMessage(reply, users, '  └─ '));
          const replyMarkdowns = replies.map(reply => formatMessageMarkdown(reply, users, '  '));
          
          allMessages.splice(parentIndex + 1, 0, ...replyTexts);
          allMessagesMarkdown.splice(parentIndex + 1, 0, ...replyMarkdowns);
        }
        
        // 進捗状況をログ出力とユーザー通知
        if ((i + 1) % 10 === 0 || i === threadMessages.length - 1) {
          console.log(`Processed ${i + 1}/${threadMessages.length} threads`);
          
          // 10スレッドごとに進捗を通知
          if ((i + 1) % 10 === 0 && i < threadMessages.length - 1) {
            await respond({
              text: `📊 進捗: ${i + 1}/${threadMessages.length} スレッド処理完了 (残り約${Math.ceil(((threadMessages.length - i - 1) * 5) / 60)}分)`,
              response_type: 'ephemeral'
            });
          }
        }
      }
      
      console.log('Thread processing completed');
      
      // スレッド処理完了を通知
      await respond({
        text: `✅ スレッド処理完了！ ${threadMessages.length}個のスレッドを処理しました。ファイルを生成中...`,
        response_type: 'ephemeral'
      });
    } else if (skipThreads && threadMessages.length > 0) {
      // スレッドスキップの通知
      await respond({
        text: `⚡ スレッドをスキップしました (${threadMessages.length}個のスレッドがありましたが、高速処理のためスキップ)。ファイルを生成中...`,
        response_type: 'ephemeral'
      });
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
}

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
