import fetch from 'node-fetch';

// LINE Login 頻道（新建的）
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;       // 2010158403
const LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET; // 637b8ef7df8a2cb780a811fc7e006e9d

const REDIRECT_URI = 'https://dreampool-v4.vercel.app/api/line-login';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET：LINE 登入完後的 callback（帶著 code 回來）──
  if (req.method === 'GET') {
    const { code, state, error } = req.query;

    // 使用者拒絕授權
    if (error) {
      return res.redirect('/?line_error=denied');
    }

    // 產生登入網址（前端呼叫）
    if (!code) {
      const state = Math.random().toString(36).substring(2, 10);
      const loginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${LINE_LOGIN_CHANNEL_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&scope=profile`;
      return res.status(200).json({ success: true, loginUrl });
    }

    // 用 code 換 access token
    try {
      const tokenRes = await fetch('https://api.line.me/oauth2/v2.1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: LINE_LOGIN_CHANNEL_ID,
          client_secret: LINE_LOGIN_CHANNEL_SECRET
        })
      });
      const tokenData = await tokenRes.json();
      console.log('token 回應:', JSON.stringify(tokenData));

      if (!tokenData.access_token) {
        return res.redirect('/?line_error=token_failed');
      }

      // 用 token 取得用戶 profile
      const profileRes = await fetch('https://api.line.me/v2/profile', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const profile = await profileRes.json();
      console.log('profile:', JSON.stringify(profile));

      // 帶著用戶資料跳回首頁
      const params = new URLSearchParams({
        line_user_id: profile.userId,
        line_display_name: profile.displayName || '',
        line_picture: profile.pictureUrl || ''
      });
      return res.redirect(`/?${params.toString()}`);

    } catch (err) {
      console.error('LINE login 錯誤:', err.message);
      return res.redirect('/?line_error=callback_failed');
    }
  }

  // ── POST：前端請求登入網址 ──
  if (req.method === 'POST') {
    if (!LINE_LOGIN_CHANNEL_ID) {
      return res.status(500).json({ success: false, error: 'LINE_LOGIN_CHANNEL_ID 未設定' });
    }
    const state = Math.random().toString(36).substring(2, 10);
    const loginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${LINE_LOGIN_CHANNEL_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}&scope=profile`;
    return res.status(200).json({ success: true, loginUrl });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
