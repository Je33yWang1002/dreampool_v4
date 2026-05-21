import fetch from 'node-fetch';

const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;           // Login channel 的 ID
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;   // Login channel 的 secret
const BASE_URL = process.env.VERCEL_URL 
  ? `https://${process.env.VERCEL_URL}` 
  : 'https://dreampool-v4.vercel.app';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, code, state } = req.method === 'GET' 
    ? req.query 
    : req.body;

  // ── 步驟一：產生 LINE 登入網址，前端跳轉用 ──
  if (action === 'get_url' || !action) {
    if (!LINE_CHANNEL_ID) {
      return res.status(500).json({ success: false, error: 'LINE_CHANNEL_ID 未設定' });
    }
    const redirectUri = encodeURIComponent(`${BASE_URL}/api/line-login`);
    const state = Math.random().toString(36).substring(2, 10);
    const loginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile`;
    
    return res.status(200).json({ success: true, loginUrl });
  }

  // ── 步驟二：LINE 登入後的 callback，用 code 換 token 再換 profile ──
  if (code) {
    try {
      const redirectUri = `${BASE_URL}/api/line-login`;
      
      // 用 code 換 access token
      const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: LINE_CHANNEL_ID,
          client_secret: LINE_CHANNEL_SECRET
        })
      });
      const tokenData = await tokenRes.json();
      
      if (!tokenData.access_token) {
        return res.redirect(`/?line_error=token_failed`);
      }

      // 用 access token 取得用戶 profile
      const profileRes = await fetch('https://api.line.me/v2/profile', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const profile = await profileRes.json();

      // 把 userId 和 displayName 帶回前端（用 URL query）
      return res.redirect(
        `/?line_user_id=${profile.userId}&line_display_name=${encodeURIComponent(profile.displayName)}&line_picture=${encodeURIComponent(profile.pictureUrl || '')}`
      );

    } catch (err) {
      console.error('LINE login callback 錯誤:', err);
      return res.redirect(`/?line_error=callback_failed`);
    }
  }

  return res.status(400).json({ success: false, error: '未知的 action' });
}
