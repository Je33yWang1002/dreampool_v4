import FormData from 'form-data';
import fetch from 'node-fetch';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export const config = { api: { bodyParser: false } };

// 解析 multipart body，抓出音訊檔
async function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) return reject(new Error('No boundary'));
      const boundary = boundaryMatch[1];

      const files = {};
      const fields = {};
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
            files[name] = {
              filename: filenameMatch[1],
              data: bodyBuf,
              contentType: ctMatch ? ctMatch[1].trim() : 'audio/webm'
            };
          } else {
            fields[name] = bodyBuf.toString();
          }
        }
        pos = partEnd + sep.length + 2;
        if (nextSep === -1) break;
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { files } = await parseMultipart(req);
    const audioFile = files?.audio;

    if (!audioFile) {
      return res.status(400).json({ success: false, error: '沒有收到音訊檔案' });
    }
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: 'OPENAI_API_KEY 未設定' });
    }

    console.log('收到音訊檔:', audioFile.filename, audioFile.contentType, audioFile.data.length, 'bytes');

    // ✅ 用 form-data 套件送給 Whisper，確保格式正確
    const formData = new FormData();
    
    // Whisper 需要副檔名來判斷格式，強制給 .webm
    formData.append('file', audioFile.data, {
      filename: 'audio.webm',
      contentType: 'audio/webm'
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

    if (whisperData.error) {
      return res.status(500).json({ 
        success: false, 
        error: `Whisper 錯誤: ${whisperData.error.message}` 
      });
    }

    if (!whisperData.text) {
      return res.status(500).json({ success: false, error: '語音辨識沒有回傳文字' });
    }

    return res.status(200).json({ success: true, transcript: whisperData.text });

  } catch(err) {
    console.error('transcribe 錯誤:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
