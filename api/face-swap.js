import fetch from 'node-fetch';

const PIAPI_API_KEY = (process.env.PIAPI_API_KEY || '').trim();

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { mode, userPhotoUrl, videoUrl, taskId } = req.body;

    if (!PIAPI_API_KEY) {
      return res.status(500).json({ success: false, error: 'PIAPI_API_KEY 未設定' });
    }

    // ── 提交換臉任務 ──
    if (!mode || mode === 'swap') {
      if (!userPhotoUrl || !videoUrl) {
        return res.status(400).json({ success: false, error: '缺少 userPhotoUrl 或 videoUrl' });
      }

      console.log('提交 PiAPI 換臉任務，照片:', userPhotoUrl, '影片:', videoUrl);

      const response = await fetch('https://api.piapi.ai/api/v1/task', {
        method: 'POST',
        headers: {
          'x-api-key': PIAPI_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'Qubico/video-toolkit',
          task_type: 'face-swap',
          input: {
            swap_image: userPhotoUrl,
            target_video: videoUrl
          }
        })
      });

      const data = await response.json();
      console.log('PiAPI 換臉回應:', JSON.stringify(data));

      if (data.code !== 200) {
        return res.status(500).json({ success: false, error: `PiAPI 錯誤: ${data.message || JSON.stringify(data)}` });
      }

      const swapTaskId = data.data?.task_id;
      if (!swapTaskId) {
        return res.status(500).json({ success: false, error: `未取得 task_id: ${JSON.stringify(data)}` });
      }

      return res.status(200).json({ success: true, taskId: swapTaskId });
    }

    // ── 查詢換臉進度 ──
    if (mode === 'check_status') {
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少 taskId' });
      }

      const response = await fetch(`https://api.piapi.ai/api/v1/task/${taskId}`, {
        method: 'GET',
        headers: { 'x-api-key': PIAPI_API_KEY }
      });

      const data = await response.json();
      console.log('PiAPI 換臉查詢:', JSON.stringify(data));

      const status = data.data?.status || '';
      let swappedVideoUrl = '';

      if (status === 'completed' && data.data?.output?.video_url) {
        swappedVideoUrl = data.data.output.video_url;
      }

      return res.status(200).json({
        success: true,
        status,
        swappedVideoUrl,
        error: data.data?.error || null
      });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch (err) {
    console.error('face-swap 錯誤:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
