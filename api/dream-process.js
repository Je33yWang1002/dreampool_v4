import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PIAPI_API_KEY = (process.env.PIAPI_API_KEY || '').trim();

export const config = { api: { bodyParser: false } };

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

    if (!mode || mode === 'generate') {
      const dreamText = fields?.dream;
      const userPhotoUrl = fields?.userPhotoUrl || '';
      if (!dreamText) return res.status(400).json({ success: false, error: '請輸入夢境內容' });

      let prompt = `Wide shot: A surreal dreamscape where Character_A experiences: "${dreamText}". 35mm cinematic, slow dolly, ethereal lighting. [Negative: blurry, distorted limbs, text overlays, low quality, flickering]`;
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

      if (!PIAPI_API_KEY) {
        return res.status(500).json({ success: false, error: 'PIAPI_API_KEY 未設定' });
      }

      // ✅ 用 PiAPI Seedance 2，直接控制比例和解析度
      let requestBody;
      if (userPhotoUrl) {
        console.log("使用 PiAPI Seedance image-to-video，照片:", userPhotoUrl);
        requestBody = {
          model: "seedance",
          task_type: "seedance-2-fast",
          input: {
            prompt: prompt,
            mode: "omni_reference",
            image_urls: [userPhotoUrl],
            duration: 5,
            aspect_ratio: "9:16",
            resolution: "720p"
          }
        };
      } else {
        console.log("使用 PiAPI Seedance text-to-video");
        requestBody = {
          model: "seedance",
          task_type: "seedance-2-fast",
          input: {
            prompt: prompt,
            mode: "text_to_video",
            duration: 5,
            aspect_ratio: "9:16",
            resolution: "720p"
          }
        };
      }

      console.log("呼叫 PiAPI Seedance:", JSON.stringify(requestBody));

      const seedRes = await fetch('https://api.piapi.ai/api/v1/task', {
        method: 'POST',
        headers: {
          'x-api-key': PIAPI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const seedData = await seedRes.json();
      console.log("PiAPI Seedance 回應:", JSON.stringify(seedData));

      if (seedData.code !== 200) {
        return res.status(500).json({ success: false, error: `Seedance 錯誤: ${seedData.message || JSON.stringify(seedData)}` });
      }

      const taskId = seedData.data?.task_id;
      if (!taskId) {
        return res.status(500).json({ success: false, error: `未取得 task_id: ${JSON.stringify(seedData)}` });
      }

      return res.status(200).json({ success: true, videoPrompt: prompt, tags, taskId });
    }

    if (mode === 'check_status') {
      const taskId = fields?.taskId;
      if (!taskId) return res.status(400).json({ success: false, error: '缺少 taskId' });

      const checkRes = await fetch(`https://api.piapi.ai/api/v1/task/${taskId}`, {
        method: 'GET',
        headers: { 'x-api-key': PIAPI_API_KEY }
      });

      const checkData = await checkRes.json();
      console.log("PiAPI Seedance 查詢:", JSON.stringify(checkData));

      const status = checkData.data?.status || '';
      let videoUrl = '';

      if (status === 'completed') {
        videoUrl = checkData.data?.output?.video_url || '';
        console.log("解析到影片URL:", videoUrl);
      }

      let frontendStatus = status;
      if (status === 'completed') frontendStatus = 'completed';
      if (status === 'processing' || status === 'pending' || status === 'running' || status === 'queued') frontendStatus = 'processing';
      if (status === 'failed') frontendStatus = 'failed';

      return res.status(200).json({ success: true, status: frontendStatus, videoUrl });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch(err) {
    console.error("後端錯誤:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
