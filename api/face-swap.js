import fetch from 'node-fetch';

const VMODEL_API_TOKEN = (process.env.VMODEL_API_TOKEN || '').trim();

// Video Face Swap Pro 的 version ID（官方文件確認）
const VIDEO_FACE_SWAP_VERSION = '537e83f7ed84751dc56aa80fb2391b07696c85a49967c72c64f002a0ca2bb224';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { mode, userPhotoUrl, videoUrl, taskId } = req.body;

    if (!VMODEL_API_TOKEN) {
      return res.status(500).json({ success: false, error: 'VMODEL_API_TOKEN 未設定' });
    }

    // ── 提交換臉任務 ──
    if (!mode || mode === 'swap') {
      if (!userPhotoUrl || !videoUrl) {
        return res.status(400).json({ success: false, error: '缺少 userPhotoUrl 或 videoUrl' });
      }

      console.log('提交換臉任務，照片:', userPhotoUrl, '影片:', videoUrl);

      const response = await fetch('https://api.vmodel.ai/api/tasks/v1/create', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${VMODEL_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: VIDEO_FACE_SWAP_VERSION,
          input: {
            source: userPhotoUrl,  // 使用者的臉（照片）
            target: videoUrl,       // 夢境影片（要被換臉的影片）
            keep_fps: false,
            disable_safety_checker: false
          }
        })
      });

      const data = await response.json();
      console.log('VModel 換臉回應:', JSON.stringify(data));

      if (data.error) {
        return res.status(500).json({ success: false, error: `VModel 錯誤: ${data.error}` });
      }

      const swapTaskId = data.task_id || data.id;
      if (!swapTaskId) {
        return res.status(500).json({ success: false, error: `未取得換臉 task_id: ${JSON.stringify(data)}` });
      }

      return res.status(200).json({ success: true, taskId: swapTaskId });
    }

    // ── 查詢換臉進度 ──
    if (mode === 'check_status') {
      if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少 taskId' });
      }

      const response = await fetch(`https://api.vmodel.ai/api/tasks/v1/${taskId}`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${VMODEL_API_TOKEN}` }
      });

      const data = await response.json();
      console.log('VModel 換臉查詢:', JSON.stringify(data));

      const status = data.status || '';
      let swappedVideoUrl = '';

      if (status === 'succeeded' && data.output && data.output.length > 0) {
        swappedVideoUrl = data.output[0];
      }

      return res.status(200).json({
        success: true,
        status,
        swappedVideoUrl,
        error: data.error || null
      });
    }

    return res.status(400).json({ success: false, error: '未知的 mode' });

  } catch (err) {
    console.error('face-swap 錯誤:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
