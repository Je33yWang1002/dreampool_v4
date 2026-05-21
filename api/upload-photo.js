// ✅ 改用 Cloudinary Unsigned Upload（不需要手動簽名，最簡單可靠）
// 需要在 Cloudinary 後台設定一個 unsigned upload preset

export const config = { api: { bodyParser: false } };

const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_UPLOAD_PRESET = (process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();

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
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
      return res.status(500).json({ 
        success: false, 
        error: 'Cloudinary 環境變數未設定（需要 CLOUDINARY_CLOUD_NAME 和 CLOUDINARY_UPLOAD_PRESET）' 
      });
    }

    const { files } = await parseMultipart(req);
    const photoFile = files?.photo;
    if (!photoFile) {
      return res.status(400).json({ success: false, error: '沒有收到照片檔案' });
    }

    // 轉成 base64 data URI
    const base64 = photoFile.data.toString('base64');
    const mimeType = photoFile.contentType || 'image/jpeg';
    const dataUri = `data:${mimeType};base64,${base64}`;

    // ✅ Unsigned upload，不需要簽名，只需要 upload_preset
    const { default: fetch } = await import('node-fetch');
    const { default: FormData } = await import('form-data');
    
    const formData = new FormData();
    formData.append('file', dataUri);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder', 'dreampool_users');

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: 'POST', headers: formData.getHeaders(), body: formData }
    );

    const uploadData = await uploadRes.json();
    console.log('Cloudinary 回應:', JSON.stringify(uploadData));

    if (uploadData.error) {
      return res.status(500).json({ 
        success: false, 
        error: `Cloudinary 錯誤: ${uploadData.error.message}`
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
