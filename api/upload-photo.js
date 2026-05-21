import fetch from 'node-fetch';
import crypto from 'crypto';

// 強制清除空白和換行
const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim().replace(/[\r\n]/g, '');
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim().replace(/[\r\n]/g, '');
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim().replace(/[\r\n]/g, '');

export const config = { api: { bodyParser: false } };

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

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'dreampool_users';

    // ✅ 官方正確簽名方式：只對「非 file、api_key 以外」的參數簽名
    // 參數按字母排序，直接串接 secret（不加分隔符）
    const signStr = `folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(signStr).digest('hex');

    // 印出 debug 資訊到 Vercel log
    console.log('Cloud:', CLOUDINARY_CLOUD_NAME);
    console.log('Key 前4碼:', CLOUDINARY_API_KEY.substring(0, 4));
    console.log('Secret 前4碼:', CLOUDINARY_API_SECRET.substring(0, 4));
    console.log('Secret 長度:', CLOUDINARY_API_SECRET.length);
    console.log('簽名字串（去掉secret）:', `folder=${folder}&timestamp=${timestamp}`);
    console.log('簽名結果:', signature);

    // 把圖片轉為 base64，改用 Cloudinary 的 base64 上傳方式
    const base64Image = photoFile.data.toString('base64');
    const mimeType = photoFile.contentType || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64Image}`;

    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    formData.append('file', dataUri);
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('timestamp', String(timestamp));
    formData.append('folder', folder);
    formData.append('signature', signature);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: 'POST', headers: formData.getHeaders(), body: formData }
    );
    const uploadData = await uploadRes.json();
    console.log('Cloudinary 回應:', JSON.stringify(uploadData));

    if (uploadData.error) {
      return res.status(500).json({ 
        success: false, 
        error: `Cloudinary 錯誤: ${uploadData.error.message}`,
        debug: { signStr: `folder=${folder}&timestamp=${timestamp}[SECRET]`, signature }
      });
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
