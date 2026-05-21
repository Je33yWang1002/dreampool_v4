import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ✅ 同時支援新舊兩種環境變數格式
// 新格式：KLING_ACCESS_KEY + KLING_SECRET_KEY（分開設定）
// 舊格式：KLING_API_KEY = "AccessKey.SecretKey"（合在一起）
let KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
let KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

if ((!KLING_ACCESS_KEY || !KLING_SECRET_KEY) && process.env.KLING_API_KEY) {
  const raw = process.env.KLING_API_KEY.trim();
  // 支援 "AmnTC8...E.DH3Qy...8" 格式
  if (raw.includes('.')) {
    const parts = raw.split('.');
    KLING_ACCESS_KEY = parts[0].trim();
    KLING_SECRET_KEY = parts[1].trim();
  }
  // 支援 "Access Key: xxx\nSecret Key: yyy" 格式
  const accessMatch = raw.match(/Access\s*Key[:\s]+([A-Za-z0-9]+)/i);
  const secretMatch = raw.match(/Secret\s*Key[:\s]+([A-Za-z0-9]+)/i);
  if (accessMatch) KLING_ACCESS_KEY = accessMatch[1];
  if (secretMatch) KLING_SECRET_KEY = secretMatch[1];
}

// bodyParser false = 支援 multipart 語音上傳
export const config = { api: { bodyParser: false } };

// ✅ 產生 Kling JWT
function generateKlingJWT() {
  if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
    throw new Error('Kling API Key 未設定！請在 Vercel 環境變數中設定 KLING_ACCESS_KEY 和 KLING_SECRET_KEY（或舊版的 KLING_API_KEY）');
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

// ✅ 手動解析 multipart / JSON body
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';

      if (ct.includes('application/json')) {
        try { resolve({ fields: JSON.parse(buf.toString()), files: {} }); }
        catch(e) { reject(e); }
        return;
      }

      if (ct.includes('multipart/form-data')) {
        const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
        if (!boundaryMatch) return reject(new Error('No multipart boundary'));
        const boundary = boundaryMatch[1];
        const fields = {}, files = {};

        // 用 Buffer 切割，避免 binary 字串問題
        const sep = Buffer.from(`\r\n--${boundary}`);
        const end = Buffer.from(`\r\n--${boundary}--`);
        let pos = buf.indexOf(`--${boundary}\r\n`);
        if (pos === -1) return resolve({ fields, files });
        pos += `--${boundary}\r\n`.length;

        while (pos < buf.length) {
          const nextSep = buf.indexOf(sep, pos);
          const partEnd = nextSep === -1 ? buf.indexOf(end, pos) : nextSep;
          if (partEnd === -1) break;

          const part = buf.slice(pos, partEnd);
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd === -1) { pos = partEnd + sep.length + 2; continue; }

          const headerStr = part.slice(0, headerEnd).toString();
          const bodyBuf = part.slice(headerEnd + 4);

          const nameMatch = headerStr.match(/name="([^"]+)"/);
          const filenameMatch = headerStr.match(/filename="([^"]+)"/);
          const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/);

          if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
              files[name] = {
                filename: filenameMatch[1],
                data: bodyBuf,
                contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream'
              };
            } else {
              fields[name] = bodyBuf.toString();
            }
          }
          pos = partEnd + sep.length + 2;
          if (nextSep === -1) break;
        }
        return resolve({ fields, files });
      }

      // fallback: try JSON
      try { resolve({ fields: JSON.parse(buf.toString()), files: {} }); }
      catch(e) { resolve({ fields: {}, files: {} }); }
    });
    req.on('error', reject);
  });
}

// ✅ System Prompt
const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director. Convert the user's dream description into a structured English video prompt for Kling AI.

RULES FOR PROMPT:
1. Shot Type: Wide shot / Medium shot / Close-up / POV / Aerial
2. Camera: dolly push-in, lateral tracking, crane up, slow zoom
3. Lighting: golden hour, moonlit, neon-lit, bioluminescent
4. Atmosphere: sensory language, ethereal mist, silence
5. Subject & Action: clear names, physics-based motion
6. Style: 35mm cinematic, surrealist dreamscape
7. End with: [Negative: blurry, distorted limbs, text overlays, low quality, flickering]

RULES FOR TAGS (very important):
- Extract 3-5 keywords DIRECTLY from the user's original text
- Use the EXACT words/phrases the user actually said — do NOT invent new words
- Tags must be short noun or verb phrases (1-4 characters each)
- Tags should be in the same language the user wrote in (Chinese if they wrote Chinese)
- Example: if user says "我夢見一隻貓追著狗跑", tags should be ["貓", "狗", "追跑"] NOT ["動物", "活力", "奔跑"]

OUTPUT (JSON only):
{"prompt": "Full English video prompt", "tags": ["原文關鍵詞1", "原文關鍵詞2", "原文關鍵詞3"]}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { fields, files } = await parseBody(req);
    const mode = fields?.mode;

    // ───── 語音轉文字 ─────
    if (mode === 'transcribe') {
      const audioFile = files?.audio;
      if (!audioFile) return res.status(400).json({ success: false, error: '沒有收到音訊檔案' });
      if (!OPENAI_API_KEY) return res.status(500).json({ success: false, error: 'OpenAI Key 未設定' });

      // 用 FormData 送給 Whisper API
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      formData.append('file', audioFile.data, {
        filename: audioFile.filename || 'dream.webm',
        contentType: audioFile.contentType || 'audio/webm'
      });
      formData.append('model', 'whisper-1');
      formData.append('language', 'zh');

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          ...formData.getHeaders()
        },
        body: formData
      });

      const whisperData = await whisperRes.json();
      console.log('Whisper 回應:', JSON.stringify(whisperData));

      if (!whisperData.text) {
        return res.status(500).json({ success: false, error: `語音辨識失敗: ${whisperData.error?.message || '未知錯誤'}` });
      }
      return res.status(200).json({ success: true, transcript: whisperData.text });
    }

    // ───── 生成影片任務 ─────
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
      // 取得前端傳來的使用者照片 URL（選填）
      const userPhotoUrl = fields?.userPhotoUrl || '';

      const klingBody = {
        model_name: "kling-v1-6",
        prompt: prompt,
        negative_prompt: "blurry, distorted limbs, text overlays, low quality, flickering, watermark",
        aspect_ratio: "9:16",
        duration: "5",
        mode: "std"
      };

      // ✅ 如果有使用者照片，加入 image_reference 讓 AI 參考外貌特徵
      if (userPhotoUrl) {
        klingBody.image_reference = userPhotoUrl;
        klingBody.image_reference_strength = 0.8;
        console.log("帶入使用者照片參考:", userPhotoUrl);
      }

      console.log("KLING_ACCESS_KEY 前4碼:", KLING_ACCESS_KEY?.slice(0,4));
      console.log("Kling body:", JSON.stringify(klingBody));

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
        if (klingData.code === 1000) msg = "Kling 金鑰認證失敗，請確認 Access Key / Secret Key 正確";
        return res.status(500).json({ success: false, error: `Kling [${klingData.code}]: ${msg}` });
      }

      const taskId = klingData.data?.task_id;
      if (!taskId) return res.status(500).json({ success: false, error: "未取得 task_id" });
      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    // ───── 查詢進度 ─────
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
