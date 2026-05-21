import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VIDU_API_KEY = (process.env.VIDU_API_KEY || '').trim();

// bodyParser false = 支援 multipart 表單
export const config = { api: { bodyParser: false } };

// 解析 multipart / JSON body
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
        if (!boundaryMatch) return reject(new Error('No boundary'));
        const boundary = boundaryMatch[1];
        const fields = {}, files = {};
        const sep = Buffer.from(`\r\n--${boundary}`);
        let pos = buf.indexOf(`--${boundary}\r\n`);
        if (pos === -1) return resolve({ fields, files });
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
          const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/);
          if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
              files[name] = { filename: filenameMatch[1], data: bodyBuf, contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream' };
            } else {
              fields[name] = bodyBuf.toString();
            }
          }
          pos = partEnd + sep.length + 2;
          if (nextSep === -1) break;
        }
        return resolve({ fields, files });
      }

      try { resolve({ fields: JSON.parse(buf.toString()), files: {} }); }
      catch(e) { resolve({ fields: {}, files: {} }); }
    });
    req.on('error', reject);
  });
}

// System Prompt
const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director. Convert the user's dream description into a structured English video prompt for Vidu AI.

RULES:
1. Shot Type: Wide shot / Medium shot / Close-up / POV / Aerial
2. Camera: dolly push-in, lateral tracking, crane up, slow zoom
3. Lighting: golden hour, moonlit, neon-lit, bioluminescent
4. Atmosphere: sensory language, ethereal mist, silence
5. Subject: Always refer to the main character as "the person" or "Character_A" — the system will inject a real face reference image
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

      // GPT 轉換 prompt
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

      if (!VIDU_API_KEY) {
        return res.status(500).json({ success: false, error: 'VIDU_API_KEY 未設定' });
      }

      // ✅ 根據是否有照片，決定用哪個 API
      let viduRes, viduData;

      if (userPhotoUrl) {
        // 有照片 → 用 Reference-to-Video（使用者臉當主角參考）
        console.log("使用 Reference-to-Video，照片:", userPhotoUrl);
        viduRes = await fetch('https://api.vidu.com/ent/v2/reference2video', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${VIDU_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "viduq1",
            images: [userPhotoUrl],   // 使用者照片作為角色參考
            prompt: prompt,
            duration: "5",
            aspect_ratio: "9:16",
            resolution: "720p",
            movement_amplitude: "auto",
            off_peak: false
          })
        });
      } else {
        // 沒有照片 → 用一般 Text-to-Video
        console.log("使用 Text-to-Video");
        viduRes = await fetch('https://api.vidu.com/ent/v2/text2video', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${VIDU_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: "viduq1",
            prompt: prompt,
            duration: "5",
            aspect_ratio: "9:16",
            resolution: "720p",
            movement_amplitude: "auto",
            off_peak: false
          })
        });
      }

      viduData = await viduRes.json();
      console.log("Vidu API 回應:", JSON.stringify(viduData));

      if (viduData.code && viduData.code !== 0) {
        return res.status(500).json({ success: false, error: `Vidu 錯誤: ${viduData.message || JSON.stringify(viduData)}` });
      }

      const taskId = viduData.task_id || viduData.id;
      if (!taskId) {
        return res.status(500).json({ success: false, error: `Vidu 未回傳 task_id: ${JSON.stringify(viduData)}` });
      }

      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    // ── 查詢進度 ──
    if (mode === 'check_status') {
      const taskId = fields?.taskId;
      if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });

      const checkRes = await fetch(`https://api.vidu.com/ent/v2/tasks/${taskId}/creations`, {
        method: 'GET',
        headers: { 'Authorization': `Token ${VIDU_API_KEY}` }
      });
      const checkData = await checkRes.json();
      console.log("Vidu 查詢結果:", JSON.stringify(checkData));

      // Vidu 狀態：created / queueing / processing / success / failed
      const state = checkData.state || checkData.status || '';
      let videoUrl = '';

      if (state === 'success') {
        // 取得影片 URL
        const creations = checkData.creations || checkData.outputs || [];
        if (creations.length > 0) {
          videoUrl = creations[0].url || creations[0].video_url || '';
        }
        // 有些版本直接在 checkData.url
        if (!videoUrl && checkData.url) videoUrl = checkData.url;
      }

      return res.status(200).json({ success: true, status: state, videoUrl });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch(err) {
    console.error("後端錯誤:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
