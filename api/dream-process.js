import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

// bodyParser: false 是為了處理語音檔案上傳（multipart）
export const config = { api: { bodyParser: false } };

// ✅ 產生 Kling JWT
function generateKlingJWT() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    throw new Error('Kling API Key 未設定，請在 Vercel 環境變數中設定 KLING_ACCESS_KEY 和 KLING_SECRET_KEY');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', KLING_SECRET_KEY)
    .update(`${encodedHeader}.${encodedPayload}`).digest();
  return `Bearer ${encodedHeader}.${encodedPayload}.${signature.toString('base64url')}`;
}

// ✅ 手動解析 multipart body（不依賴 formidable）
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try { resolve({ fields: JSON.parse(buf.toString()), files: {} }); }
        catch(e) { reject(e); }
      } else if (contentType.includes('multipart/form-data')) {
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) return reject(new Error('No boundary'));
        const parts = buf.toString('binary').split('--' + boundary);
        const fields = {};
        const files = {};
        for (const part of parts) {
          if (part === '' || part === '--\r\n' || part.trim() === '--') continue;
          const [rawHeaders, ...bodyParts] = part.split('\r\n\r\n');
          if (!rawHeaders) continue;
          const bodyStr = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');
          const nameMatch = rawHeaders.match(/name="([^"]+)"/);
          const filenameMatch = rawHeaders.match(/filename="([^"]+)"/);
          if (!nameMatch) continue;
          const name = nameMatch[1];
          if (filenameMatch) {
            files[name] = {
              filename: filenameMatch[1],
              data: Buffer.from(bodyStr, 'binary'),
              contentType: (rawHeaders.match(/Content-Type:\s*([^\r\n]+)/) || [])[1] || 'application/octet-stream'
            };
          } else {
            fields[name] = bodyStr;
          }
        }
        resolve({ fields, files });
      } else {
        try { resolve({ fields: JSON.parse(buf.toString()), files: {} }); }
        catch(e) { resolve({ fields: {}, files: {} }); }
      }
    });
    req.on('error', reject);
  });
}

// ✅ System Prompt
const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director specializing in transforming abstract dream descriptions into precise, vivid video generation prompts for Kling AI.

Convert the user's raw dream description into a structured English video prompt.

RULES:
1. Shot Type: Always specify (Wide shot / Medium shot / Close-up / POV / Aerial)
2. Camera Movement: dolly push-in, lateral tracking, crane up, slow zoom
3. Lighting: golden hour, moonlit, neon-lit, bioluminescent glow
4. Atmosphere: sensory language (heavy silence, ethereal mist)
5. Subject & Action: name subjects clearly, physics-based motion
6. Style: 35mm cinematic, surrealist dreamscape
7. End with: [Negative: blurry, distorted limbs, text overlays, low quality, flickering]

OUTPUT (JSON only, no extra text):
{"prompt": "Full English video prompt", "tags": ["中文標籤1", "中文標籤2", "中文標籤3", "中文標籤4"]}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { fields, files } = await parseBody(req);
    const mode = fields?.mode;

    // ============= 語音轉文字 =============
    if (mode === 'transcribe') {
      const audioFile = files?.audio;
      if (!audioFile) return res.status(400).json({ success: false, error: '沒有收到音訊檔案' });
      if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'OpenAI Key 未設定' });

      // 用 FormData 送給 Whisper
      const { FormData, Blob } = await import('node-fetch');
      const formData = new FormData();
      const blob = new Blob([audioFile.data], { type: audioFile.contentType });
      formData.append('file', blob, audioFile.filename || 'audio.webm');
      formData.append('model', 'whisper-1');
      formData.append('language', 'zh');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: formData
      });
      const whisperData = await whisperRes.json();
      if (!whisperData.text) return res.status(500).json({ success: false, error: '語音辨識失敗，請再試一次' });

      return res.status(200).json({ success: true, transcript: whisperData.text });
    }

    // ============= 生成影片任務 =============
    if (!mode || mode === 'generate') {
      const dreamText = fields?.dream;
      if (!dreamText) return res.status(400).json({ success: false, error: '請輸入夢境內容' });

      let prompt = `Wide shot: A surreal dreamscape: "${dreamText}". 35mm cinematic, slow dolly, ethereal lighting. [Negative: blurry, distorted limbs, text overlays, low quality]`;
      let tags = ["夢境", "潛意識", "超現實"];

      if (OPENAI_API_KEY) {
        try {
          const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
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
          const gptData = await gptRes.json();
          if (gptData.choices?.[0]?.message?.content) {
            const parsed = JSON.parse(gptData.choices[0].message.content);
            if (parsed.prompt) prompt = parsed.prompt;
            if (parsed.tags) tags = parsed.tags;
          }
        } catch(e) { console.error("GPT 失敗:", e.message); }
      }

      const klingAuth = generateKlingJWT();
      const klingBody = {
        model_name: "kling-v2-1-master", // ✅ 升級到最高畫質
        prompt: prompt,
        negative_prompt: "blurry, distorted limbs, text overlays, low quality, flickering, watermark",
        aspect_ratio: "16:9",            // ✅ 電影寬幅比例
        duration: "5",
        mode: "pro"                      // ✅ pro 模式配合 v2.1
      };

      console.log("Kling body:", JSON.stringify(klingBody));
      const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': klingAuth },
        body: JSON.stringify(klingBody)
      });
      const klingData = await klingRes.json();
      console.log("Kling 回應:", JSON.stringify(klingData));

      if (klingData.code !== 0) {
        let errorMsg = klingData.message || "Kling API 錯誤";
        if (klingData.code === 1102) errorMsg = "Kling 帳戶餘額不足！";
        if (klingData.code === 1000) errorMsg = "Kling 金鑰認證失敗";
        return res.status(500).json({ success: false, error: `Kling [${klingData.code}]: ${errorMsg}` });
      }

      const taskId = klingData.data?.task_id;
      if (!taskId) return res.status(500).json({ success: false, error: "未取得 task_id" });

      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    // ============= 查詢進度 =============
    if (mode === 'check_status') {
      const taskId = fields?.taskId;
      if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });

      const klingAuth = generateKlingJWT();
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
      return res.status(200).json({ success: true, status, videoUrl });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch(err) {
    console.error("後端錯誤:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
