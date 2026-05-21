import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ 同時支援新舊兩種格式
let KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
let KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

if ((!KLING_ACCESS_KEY || !KLING_SECRET_KEY) && process.env.KLING_API_KEY) {
  const raw = process.env.KLING_API_KEY.trim();
  if (raw.includes('.')) {
    const parts = raw.split('.');
    KLING_ACCESS_KEY = parts[0].trim();
    KLING_SECRET_KEY = parts[1].trim();
  }
}

export const config = { api: { bodyParser: false } };

// ✅ 產生 Kling JWT
function generateKlingJWT() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    throw new Error('Kling API Key 未設定');
  }
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: KLING_ACCESS_KEY, exp: now + 1800, nbf: now - 5 };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', KLING_SECRET_KEY)
    .update(`${encodedHeader}.${encodedPayload}`).digest('base64url');
  return `Bearer ${encodedHeader}.${encodedPayload}.${sig}`;
}

// ✅ 解析 multipart body
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { resolve({ fields: JSON.parse(buf.toString()) }); } catch(e) { reject(e); }
        return;
      }
      if (ct.includes('multipart/form-data')) {
        const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
        if (!boundaryMatch) return resolve({ fields: {} });
        const boundary = boundaryMatch[1];
        const fields = {};
        const sep = Buffer.from(`\r\n--${boundary}`);
        let pos = buf.indexOf(`--${boundary}\r\n`);
        if (pos === -1) return resolve({ fields });
        pos += `--${boundary}\r\n`.length;
        while (pos < buf.length) {
          const nextSep = buf.indexOf(sep, pos);
          const partEnd = nextSep === -1 ? buf.indexOf(`\r\n--${boundary}--`, pos) : nextSep;
          if (partEnd === -1) break;
          const part = buf.slice(pos, partEnd);
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) { pos = partEnd + sep.length + 2; continue; }
          const headerStr = part.slice(0, headerEnd).toString();
          const bodyBuf = part.slice(headerEnd + 4);
          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          if (nameMatch && !filenameMatch) fields[nameMatch[1]] = bodyBuf.toString();
          pos = partEnd + sep.length + 2;
          if (nextSep === -1) break;
        }
        return resolve({ fields });
      }
      try { resolve({ fields: JSON.parse(buf.toString()) }); } catch(e) { resolve({ fields: {} }); }
    });
    req.on('error', reject);
  });
}

const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director. Convert the user's dream description into a structured English video prompt for Kling AI.

RULES:
1. Shot Type: Wide shot / Medium shot / Close-up / POV / Aerial
2. Camera: dolly push-in, lateral tracking, crane up, slow zoom
3. Lighting: golden hour, moonlit, neon-lit, bioluminescent
4. Atmosphere: sensory language, ethereal mist, silence
5. Subject: refer to main character as "Character_A"
6. Style: 35mm cinematic, surrealist dreamscape
7. End with: [Negative: blurry, distorted limbs, text overlays, low quality, flickering]

OUTPUT (JSON only):
{"prompt": "Full English video prompt", "tags": ["中文標籤1", "中文標籤2", "中文標籤3", "中文標籤4"]}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { fields } = await parseBody(req);
    const mode = fields?.mode;

    // ── 生成影片 ──
    if (!mode || mode === 'generate') {
      const dreamText = fields?.dream;
      const userPhotoUrl = fields?.userPhotoUrl || '';
      if (!dreamText) return res.status(400).json({ success: false, error: '請輸入夢境內容' });

      let prompt = `Wide shot: A surreal dreamscape where Character_A experiences: "${dreamText}". 35mm cinematic, slow dolly, ethereal lighting. [Negative: blurry, distorted limbs, text overlays, low quality]`;
      let tags = ["夢境", "潛意識", "超現實"];

      if (OPENAI_API_KEY) {
        try {
          const gptRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              response_format: { type: "json_object" },
              messages: [{ role: "system", content: DREAM_SYSTEM_PROMPT }, { role: "user", content: dreamText }],
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

      // ✅ 呼叫 Kling API
      const klingAuth = generateKlingJWT();
      const klingBody = {
        model_name: "kling-v1-6",
        prompt,
        negative_prompt: "blurry, distorted limbs, text overlays, low quality, flickering, watermark",
        aspect_ratio: "9:16",
        duration: "5",
        mode: "std"
      };

      // 如果有照片，加入 image_reference
      if (userPhotoUrl) {
        klingBody.image_reference = userPhotoUrl;
        klingBody.image_reference_strength = 0.8;
      }

      console.log("呼叫 Kling API:", JSON.stringify(klingBody));
      const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': klingAuth },
        body: JSON.stringify(klingBody)
      });
      const klingData = await klingRes.json();
      console.log("Kling 回應:", JSON.stringify(klingData));

      if (klingData.code !== 0) {
        let msg = klingData.message || "Kling API 錯誤";
        if (klingData.code === 1102) msg = "Kling 帳戶餘額不足！";
        if (klingData.code === 1000) msg = "Kling 金鑰認證失敗";
        return res.status(500).json({ success: false, error: `Kling [${klingData.code}]: ${msg}` });
      }

      const taskId = klingData.data?.task_id;
      if (!taskId) return res.status(500).json({ success: false, error: "未取得 task_id" });
      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    // ── 查詢進度 ──
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
