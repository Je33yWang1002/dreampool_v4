import fetch from 'node-fetch';
import crypto from 'crypto';

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

export const config = { api: { bodyParser: false } };

// 解析 multipart body 取出圖片
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
      const sep = Buffer.from(`\r\n--${boundary}`);
      let pos = buf.indexOf(`--${boundary}\r\n`);
      if (pos === -1) return resolve({ files });
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
        if (nameMatch && filenameMatch) {
          files[nameMatch[1]] = {
            filename: filenameMatch[1],
            data: bodyBuf,
            contentType: ctMatch ? ctMatch[1].trim() : 'image/jpeg'
          };
        }
        pos = partEnd + sep.length + 2;
        if (nextSep === -1) break;
      }
      resolve({ files });
    });
    req.on('error', reject);
  });
}

// 產生 Cloudinary 簽名
function generateSignature(params, apiSecret) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha256').update(sorted + apiSecret).digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({ success: false, error: 'Cloudinary 環境變數未設定' });
    }

    const { files } = await parseMultipart(req);
    const photoFile = files?.photo;
    if (!photoFile) {
      return res.status(400).json({ success: false, error: '沒有收到照片檔案' });
    }

    // 上傳到 Cloudinary
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'dreampool_users';
    const params = { folder, timestamp };
    const signature = generateSignature(params, CLOUDINARY_API_SECRET);

    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    formData.append('file', photoFile.data, {
      filename: photoFile.filename || 'photo.jpg',
      contentType: photoFile.contentType || 'image/jpeg'
    });
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('timestamp', timestamp.toString());
    formData.append('folder', folder);
    formData.append('signature', signature);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: 'POST', headers: formData.getHeaders(), body: formData }
    );
    const uploadData = await uploadRes.json();
    console.log('Cloudinary 上傳結果:', JSON.stringify(uploadData));

    if (uploadData.error) {
      return res.status(500).json({ success: false, error: `Cloudinary 錯誤: ${uploadData.error.message}` });
    }

    return res.status(200).json({
      success: true,
      imageUrl: uploadData.secure_url,
      publicId: uploadData.public_id
    });

  } catch (err) {
    console.error('upload-photo 錯誤:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
