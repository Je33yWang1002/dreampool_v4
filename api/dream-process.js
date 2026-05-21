import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BYTEPLUS_API_KEY = (process.env.BYTEPLUS_API_KEY || '').trim();

export const config = { api: { bodyParser: false } };

// 解析 multipart body
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

const DREAM_SYSTEM_PROMPT = `You are a world-class cinematic AI director. Convert the user's dream description into a structured English video prompt for Seedance AI.

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

      // GPT 生成 prompt
      let prompt = `Wide shot: A surreal dreamscape where Character_A experiences: "${dreamText}". 35mm cinematic, slow dolly, ethereal lighting.`;
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

      if (!BYTEPLUS_API_KEY) {
        return res.status(500).json({ success: false, error: 'BYTEPLUS_API_KEY 未設定' });
      }

      // ✅ 呼叫 BytePlus ModelArk Seedance API
      // 有照片 → image-to-video，無照片 → text-to-video
      let seedanceBody;
      if (userPhotoUrl) {
        console.log("使用 Seedance image-to-video，照片:", userPhotoUrl);
        seedanceBody = {
          model: "Dreamina-Seedance-2.0-fast",
          content: [
            { type: "image_url", image_url: { url: userPhotoUrl } },
            { type: "text", text: prompt + " --ar 9:16 --dur 5" }
          ]
        };
      } else {
        console.log("使用 Seedance text-to-video");
        seedanceBody = {
          model: "Dreamina-Seedance-2.0-fast",
          content: [
            { type: "text", text: prompt + " --ar 9:16 --dur 5" }
          ]
        };
      }

      console.log("呼叫 Seedance:", JSON.stringify(seedanceBody));

      const seedRes = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BYTEPLUS_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(seedanceBody)
      });

      const seedData = await seedRes.json();
      console.log("Seedance 回應:", JSON.stringify(seedData));

      if (seedData.error) {
        return res.status(500).json({ success: false, error: `Seedance 錯誤: ${seedData.error.message || JSON.stringify(seedData.error)}` });
      }

      const taskId = seedData.id;
      if (!taskId) {
        return res.status(500).json({ success: false, error: `未取得 task_id: ${JSON.stringify(seedData)}` });
      }

      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    // ── 查詢進度 ──
    if (mode === 'check_status') {
      const taskId = fields?.taskId;
      if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });

      const checkRes = await fetch(`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${taskId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${BYTEPLUS_API_KEY}` }
      });

      const checkData = await checkRes.json();
      console.log("Seedance 查詢:", JSON.stringify(checkData));

      // Seedance 狀態: queued / running / succeeded / failed
      const status = checkData.status || '';
      let videoUrl = '';

      if (status === 'succeeded') {
        const contents = checkData.content || checkData.choices?.[0]?.message?.content || [];
        for (const item of contents) {
          if (item.type === 'video_url' && item.video_url?.url) {
            videoUrl = item.video_url.url;
            break;
          }
        }
      }

      // 前端用的狀態對應
      let frontendStatus = status;
      if (status === 'succeeded') frontendStatus = 'completed';
      if (status === 'running' || status === 'queued') frontendStatus = 'processing';

      return res.status(200).json({ success: true, status: frontendStatus, videoUrl });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch(err) {
    console.error("後端錯誤:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
