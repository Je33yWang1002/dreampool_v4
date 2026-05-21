import { IncomingForm } from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import crypto from 'crypto';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KLING_API_KEY = process.env.KLING_API_KEY;

export const config = { api: { bodyParser: false } };

// 完美支援 AccessKey.SecretKey 各種奇怪空格換行格式的清洗與編碼函式
function getKlingAuthHeader(apiKey) {
  if (!apiKey) return '';
  try {
    let cleanKey = apiKey.trim().replace(/[\r\n]/g, ' ');
    
    // 如果包含 Access Key: 或 Secret Key: 字樣，自動抓取後面的乾淨英數密碼
    if (cleanKey.includes('Access Key:') || cleanKey.includes('Secret Key:')) {
      const accessMatch = cleanKey.match(/Access\s*Key:\s*([^\s]+)/i);
      const secretMatch = cleanKey.match(/Secret\s*Key:\s*([^\s]+)/i);
      if (accessMatch && secretMatch) {
        cleanKey = `${accessMatch[1].trim()}.${secretMatch[1].trim()}`;
      }
    }

    // 如果洗完後，不包含中間連字的點（.），就當作是一般 Bearer Token 處理
    if (!cleanKey.includes('.')) {
      return cleanKey.startsWith('Bearer ') ? cleanKey : `Bearer ${cleanKey}`;
    }

    const parts = cleanKey.split('.');
    const accessKeyId = parts[0].trim();
    const secretAccessKey = parts[1].trim();

    // 依據 Kling 官方規範產生 JWT 的 Header 與 Payload
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: accessKeyId,
      exp: now + 1800, // 30分鐘有效
      nbf: now - 60
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    // 使用 HmacSHA256 加密簽章
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const form = new IncomingForm();
  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ success: false, error: "解析表單失敗" });
    }

    // 讀取前端傳過來的 mode (是 'generate' 還是 'check_status')
    const mode = Array.isArray(fields.mode) ? fields.mode[0] : fields.mode;

    try {
      // ---------------- 階段一：建立任務與影像生成 ----------------
      if (!mode || mode === 'generate') {
        const dreamText = Array.isArray(fields.dream) ? fields.dream[0] : fields.dream;
        if (!dreamText) {
          return res.status(400).json({ success: false, error: '請輸入夢境內容' });
        }

        // --- 步驟一：呼叫 OpenAI GPT 幫我們把夢境優化成高畫質英文 Prompt ---
        let prompt = `A surreal dream scene about: ${dreamText}, high quality, 4k resolution, cinematic lighting.`;
        let tags = ["夢境", "潛意識"];

        try {
          const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
              model: "gpt-4o-mini", // 使用更便宜划算的 gpt-4o-mini
              response_format: { type: "json_object" },
              messages: [
                {
                  role: "system",
                  content: "你是一位精通夢境解析與視覺編導的專家。請將用戶口述的夢境，轉化為適用於 AI 影片生成器（Kling/Runway）的高品質英文視覺描述詞（Video Prompt），強調氛圍、超現實感。並同時提取 3-5 個中文的情緒或物件標籤。請一律回傳 JSON 格式： {\"prompt\": \"英文視覺描述\", \"tags\": [\"標籤1\", \"標籤2\"]}"
                },
                {
                  role: "user",
                  content: dreamText
                }
              ],
              temperature: 0.7
            })
          });

          const gptData = await gptResponse.json();
          if (gptData.choices && gptData.choices[0]?.message?.content) {
            const parsed = JSON.parse(gptData.choices[0].message.content);
            if (parsed.prompt) prompt = parsed.prompt;
            if (parsed.tags) tags = parsed.tags;
          }
        } catch (gptErr) {
          console.error("OpenAI 連線異常，啟用備用英文 Prompt 方案:", gptErr);
        }

        // --- 步驟二：呼叫快手 Kling AI 建立文生影片任務 ---
        const klingAuth = getKlingAuthHeader(KLING_API_KEY);
        if (!klingAuth) {
          throw new Error("Kling 金鑰未設定或解密失敗");
        }

        const klingRes = await fetch('https://api.klingai.com/v1/videos/text2video', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': klingAuth
          },
          body: JSON.stringify({
            model: "kling-v1", // 使用穩定的 1.0 模型
            prompt: prompt,
            aspect_ratio: "9:16", // 完美符合 9:16 規格
            duration: "5" // 生成 5 秒
          })
        });

        const klingData = await klingRes.json();
        
        if (klingData.code !== 0) {
          let errorMsg = klingData.message || "未知錯誤";
          if (klingData.code === 1102) {
            errorMsg = "Kling 帳戶餘額點數不足，請至官網儲值！";
          }
          throw new Error(`Kling 錯誤 [${klingData.code}]: ${errorMsg}`);
        }

        const taskId = klingData.data?.task_id;
        if (!taskId) {
          throw new Error("Kling AI 連線成功，但未取得回傳的任務 ID");
        }

        // 回傳給前端網頁成功訊號，把任務 ID 帶過去
        return res.status(200).json({ 
          success: true, 
          videoPrompt: prompt, 
          tags: tags,
          taskId: taskId
        });
      }

      // ---------------- 階段二：單純讓網頁定時查詢進度 ----------------
      else if (mode === 'check_status') {
        const taskId = Array.isArray(fields.taskId) ? fields.taskId[0] : fields.taskId;
        if (!taskId) {
          return res.status(400).json({ success: false, error: '缺少任務 ID (taskId)' });
        }

        const klingAuth = getKlingAuthHeader(KLING_API_KEY);
        
        // 呼叫 Kling 查詢單一任務進度
        const checkRes = await fetch(`https://api.klingai.com/v1/videos/text2video/${taskId}`, {
          method: 'GET',
          headers: { 'Authorization': klingAuth }
        });
        const checkData = await checkRes.json();
        
        const status = checkData.data?.task_status; // 會拿到 'QUEUED', 'PROCESSING', 'SUCCEED', 'FAILED'
        
        let videoUrl = "";
        if (checkData.data?.task_result?.videos && checkData.data.task_result.videos.length > 0) {
          videoUrl = checkData.data.task_result.videos[0].url || "";
        }

        return res.status(200).json({
          success: true,
          status: status,
          videoUrl: videoUrl
        });
      }

    } catch (finalError) {
      console.error("後端發生致命錯誤:", finalError);
      return res.status(500).json({ success: false, error: finalError.message });
    }
  });
}
