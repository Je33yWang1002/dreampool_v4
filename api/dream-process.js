import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY;

export const config = { api: { bodyParser: true } };

// ✅ 產生 Kling JWT 認證 token
function getKlingAuthHeader(apiKey) {
  if (!apiKey) return '';
  try {
    let cleanKey = apiKey.trim().replace(/[\r\n]/g, '');
    
    // 支援 "AccessKey.SecretKey" 格式
    let accessKeyId, secretAccessKey;
    if (cleanKey.includes('.')) {
      const parts = cleanKey.split('.');
      accessKeyId = parts[0].trim();
      secretAccessKey = parts[1].trim();
    } else {
      // 不包含點的話，直接當 Bearer token 用
      return `Bearer ${cleanKey}`;
    }

    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: accessKeyId,
      exp: now + 1800,
      nbf: now - 60
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const signature = crypto
      .createHmac('sha256', secretAccessKey)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const encodedSignature = signature.toString('base64url');

    return `Bearer ${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  } catch (e) {
    console.error("Kling 金鑰演算失敗:", e);
    return '';
  }
}

// ✅ System Prompt：將模糊夢境轉化為 Kling 專業影片指令
const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director specializing in transforming abstract dream descriptions into precise, vivid video generation prompts for Kling AI.

Your task is to convert the user's raw dream description (which may be in any language, fragmented, or emotional) into a structured, high-quality English video prompt.

## PROMPT ENGINEERING RULES FOR KLING:

1. **Shot Type** — Always specify: Wide shot / Medium shot / Close-up / POV / Aerial
2. **Camera Movement** — Use exact terms: dolly push-in, lateral tracking, crane up, 360-degree orbit, slow zoom, handheld shake
3. **Lighting** — Be specific: golden hour, moonlit, neon-lit, bioluminescent glow, foggy diffused light
4. **Atmosphere** — Use sensory language: heavy silence, distant thunder, warm humid air, ethereal mist
5. **Subject & Action** — Name subjects clearly (Character_Alpha, the glowing jellyfish), describe physics-based motion
6. **Style Reference** — e.g., 35mm cinematic, Studio Ghibli palette, noir aesthetic, surrealist dreamscape
7. **Negative elements** — End with: [Negative: blurry, distorted limbs, text overlays, low quality, flickering]

## OUTPUT FORMAT (JSON only, no markdown):
{
  "prompt": "Your full English video prompt here (2-4 sentences, rich visual detail)",
  "tags": ["情緒標籤1", "元素標籤2", "氛圍標籤3", "場景標籤4"],
  "style": "brief style description in English"
}

## EXAMPLE:
Input: "我夢見自己在海底飛翔，身旁有發光水母"
Output: {
  "prompt": "Wide shot: A human figure drifts weightlessly through a deep ocean dreamscape, arms outstretched like wings. Bioluminescent jellyfish with trailing tendrils float in slow motion around Character_Alpha, pulsing with soft violet and cyan light. Camera performs a slow crane-up as the figure ascends through layers of glowing plankton. Cinematic 35mm aesthetic, ethereal underwater ambiance, complete silence broken only by distant whale song. [Negative: blurry, distorted limbs, text overlays, low quality, flickering]",
  "tags": ["自由", "深海", "超現實", "寂靜"],
  "style": "bioluminescent dreamscape, 35mm cinematic"
}`;

export default async function handler(req, res) {
  // ✅ 設定 CORS headers（允許跨域請求）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = req.body;
    const mode = body?.mode;

    // ============= 階段一：生成任務 =============
    if (!mode || mode === 'generate') {
      const dreamText = body?.dream;
      if (!dreamText) {
        return res.status(400).json({ success: false, error: '請輸入夢境內容' });
      }

      // --- 步驟一：呼叫 OpenAI GPT 轉化夢境為 Kling 專業 Prompt ---
      let prompt = `Wide shot: A surreal dreamscape inspired by: "${dreamText}". Soft ethereal lighting, cinematic 35mm aesthetic, slow dolly movement. [Negative: blurry, distorted limbs, text overlays, low quality]`;
      let tags = ["夢境", "潛意識", "超現實"];
      let style = "cinematic dreamscape";

      if (OPENAI_API_KEY) {
        try {
          const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: DREAM_SYSTEM_PROMPT },
                { role: "user", content: dreamText }
              ],
              temperature: 0.75
            })
          });

          const gptData = await gptResponse.json();
          if (gptData.choices?.[0]?.message?.content) {
            const parsed = JSON.parse(gptData.choices[0].message.content);
            if (parsed.prompt) prompt = parsed.prompt;
            if (parsed.tags) tags = parsed.tags;
            if (parsed.style) style = parsed.style;
          }
        } catch (gptErr) {
          console.error("OpenAI 連線異常，使用備用 Prompt:", gptErr);
        }
      }

      // --- 步驟二：呼叫 Kling AI 建立影片生成任務 ---
      const klingAuth = getKlingAuthHeader(KLING_API_KEY);
      if (!klingAuth) {
        throw new Error("Kling 金鑰未設定或解密失敗，請在 Vercel 環境變數中設定 KLING_API_KEY");
      }

      console.log("正在呼叫 Kling API...");
      const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': klingAuth
        },
        body: JSON.stringify({
          model: "kling-v1-6",       // ✅ 使用 v1.6 穩定版
          prompt: prompt,
          aspect_ratio: "9:16",      // 手機直式
          duration: "5",             // 5 秒
          negative_prompt: "blurry, distorted limbs, text overlays, low quality, flickering, watermark"
        })
      });

      const klingData = await klingRes.json();
      console.log("Kling API 回應:", JSON.stringify(klingData));

      if (klingData.code !== 0) {
        let errorMsg = klingData.message || "未知錯誤";
        if (klingData.code === 1102) errorMsg = "Kling 帳戶餘額不足，請至官網儲值！";
        if (klingData.code === 1000) errorMsg = "Kling 金鑰認證失敗，請檢查 API Key 格式";
        throw new Error(`Kling 錯誤 [${klingData.code}]: ${errorMsg}`);
      }

      const taskId = klingData.data?.task_id;
      if (!taskId) throw new Error("Kling AI 連線成功但未取得任務 ID");

      return res.status(200).json({
        success: true,
        videoPrompt: prompt,
        tags: tags,
        style: style,
        taskId: taskId
      });
    }

    // ============= 階段二：查詢影片進度 =============
    else if (mode === 'check_status') {
      const taskId = body?.taskId;
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少任務 ID' });
      }

      const klingAuth = getKlingAuthHeader(KLING_API_KEY);

      const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
        method: 'GET',
        headers: { 'Authorization': klingAuth }
      });
      const checkData = await checkRes.json();

      const status = checkData.data?.task_status;
      let videoUrl = "";

      if (checkData.data?.task_result?.videos?.length > 0) {
        videoUrl = checkData.data.task_result.videos[0].url || "";
      }

      return res.status(200).json({
        success: true,
        status: status,
        videoUrl: videoUrl
      });
    }

    return res.status(400).json({ success: false, error: '未知的 mode 參數' });

  } catch (finalError) {
    console.error("後端發生錯誤:", finalError.message);
    return res.status(500).json({ success: false, error: finalError.message });
  }
}
