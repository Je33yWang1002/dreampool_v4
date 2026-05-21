import fetch from 'node-fetch';
import crypto from 'crypto';

// ✅ 自動清除換行和空白，防止複製貼上時的格式問題
const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || '').replace(/[\r\n\s]/g, '');
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || '').replace(/[\r\n\s]/g, '');

export const config = { api: { bodyParser: true } };

// ✅ 推送訊息給指定的 LINE User
async function pushToLine(userId, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to: userId, messages })
  });
  const data = await res.json();
  console.log('LINE push 結果:', JSON.stringify(data));
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { lineUserId, dreamText, tags, videoPrompt, videoUrl } = req.body;

    if (!lineUserId) {
      return res.status(400).json({ success: false, error: '缺少 LINE User ID' });
    }
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, error: 'LINE_CHANNEL_ACCESS_TOKEN 未設定' });
    }

    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const tagsStr = (tags || []).map(t => `#${t}`).join('  ');

    const messages = [
      // 訊息一：夢境摘要文字
      {
        type: 'text',
        text: `🎬 你的夢境電影生成完成！\n\n📅 ${dateStr} ${timeStr}\n\n🔮 夢境原文：\n${dreamText}\n\n✨ 潛意識標籤：\n${tagsStr}`
      }
    ];

    // 訊息二：影片連結（如果有）
    if (videoUrl) {
      messages.push({
        type: 'text',
        text: `🎞️ 點此觀看你的夢境電影：\n${videoUrl}\n\n💾 請盡快儲存，連結將於 24 小時後失效。`
      });
    }

    // 訊息三：AI 導演劇本（可選，折疊顯示）
    if (videoPrompt) {
      messages.push({
        type: 'text',
        text: `📝 AI 導演劇本：\n\n${videoPrompt.substring(0, 300)}${videoPrompt.length > 300 ? '...' : ''}`
      });
    }

    const result = await pushToLine(lineUserId, messages);

    if (result.message && result.message !== 'ok') {
      return res.status(500).json({ success: false, error: `LINE 推送失敗: ${result.message}` });
    }

    return res.status(200).json({ success: true, message: '已成功推送到 LINE' });

  } catch (err) {
    console.error('line-notify 錯誤:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
