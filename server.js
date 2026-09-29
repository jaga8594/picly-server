const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');
const sharp = require('sharp');

ffmpeg.setFfmpegPath(ffmpegPath);

let removeBackground = null;
try {
  removeBackground = require('@imgly/background-removal-node').removeBackground;
  console.log('✅ imgly loaded');
} catch (e) {
  console.log('❌ imgly not installed:', e.message);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const CF_ACCOUNT_ID = (process.env.CF_ACCOUNT_ID || '').trim();
const CF_API_TOKEN = (process.env.CF_API_TOKEN || '').trim();
const CLIPDROP_KEY = (process.env.CLIPDROP_KEY || '').trim();
const HF_TOKEN = (process.env.HF_TOKEN || '').trim();

const upload = multer({ dest: 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');

// ==================== JOB STORE (in-memory) ====================
const jobs = new Map();

function createJob() {
  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  jobs.set(jobId, {
    status: 'processing',
    resultBuffer: null,
    contentType: 'image/png',
    error: null,
    createdAt: Date.now()
  });
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job && job.resultBuffer) {
      jobs.delete(jobId);
      console.log('🧹 Job cleanup:', jobId);
    }
  }, 10 * 60 * 1000);
  return jobId;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', imgly: !!removeBackground, cf: !!CF_ACCOUNT_ID && !!CF_API_TOKEN, clipdrop: !!CLIPDROP_KEY, hf: !!HF_TOKEN, jobs: jobs.size });
});

function getDimensions(ratio) {
  const map = {
    '1:1':  { w: 1024, h: 1024 }, '16:9': { w: 1024, h: 576 }, '9:16': { w: 576, h: 1024 },
    '4:3':  { w: 1024, h: 768 }, '3:2':  { w: 1024, h: 683 }, '4:5':  { w: 819, h: 1024 },
    '3:4':  { w: 768, h: 1024 }, '2:3':  { w: 683, h: 1024 }
  };
  return map[ratio] || map['1:1'];
}

// TRIM
app.post('/api/trim', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const start = parseFloat(req.body.start) || 0;
  const end = parseFloat(req.body.end) || 0;
  const duration = end - start;
  if (duration <= 0) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid range' }); }
  const output = `outputs/trim-${Date.now()}.mp4`;
  ffmpeg(req.file.path).setStartTime(start).setDuration(duration).videoCodec('libx264').audioCodec('aac')
    .outputOptions(['-vf','scale=1280:-2','-preset','ultrafast','-crf','28','-maxrate','2M','-bufsize','4M','-profile:v','baseline','-b:a','96k','-movflags','+faststart','-threads','1'])
    .save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, 'picly-trimmed.mp4', () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// COMPRESS
app.post('/api/compress', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const quality = req.body.quality || 'medium';
  const presets = { high: { crf: '24', maxrate: '2.5M' }, medium: { crf: '28', maxrate: '2M' }, low: { crf: '32', maxrate: '1.5M' } };
  const p = presets[quality] || presets.medium;
  const output = `outputs/comp-${Date.now()}.mp4`;
  ffmpeg(req.file.path).videoCodec('libx264').audioCodec('aac')
    .outputOptions(['-vf','scale=1280:-2','-preset','ultrafast','-crf',p.crf,'-maxrate',p.maxrate,'-bufsize','4M','-profile:v','baseline','-b:a','96k','-movflags','+faststart','-threads','1'])
    .save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, 'picly-compressed.mp4', () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// MP3
app.post('/api/mp3', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const output = `outputs/audio-${Date.now()}.mp3`;
  ffmpeg(req.file.path).noVideo().audioCodec('libmp3lame').audioQuality(5).outputOptions(['-threads','1']).save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, 'picly-audio.mp3', () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// GIF
app.post('/api/gif', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const start = parseFloat(req.body.start) || 0;
  const duration = parseFloat(req.body.duration) || 3;
  const fps = req.body.fps || '10';
  const output = `outputs/gif-${Date.now()}.gif`;
  ffmpeg(req.file.path).setStartTime(start).setDuration(duration)
    .outputOptions(['-vf',`fps=${fps},scale=320:-1:flags=fast_bilinear`,'-threads','1']).save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, 'picly.gif', () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// ENHANCE
app.post('/api/enhance', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const type = req.body.type || 'bright';
  const resolution = req.body.resolution || '720';
  const filters = {
    bright: 'eq=brightness=0.06:contrast=1.1:saturation=1.05', contrast: 'eq=contrast=1.2:saturation=1.15',
    sharpen: 'unsharp=3:3:1.0:3:3:0.0', denoise: 'hqdn3d=2:2:3:2', autocolor: 'eq=contrast=1.15:saturation=1.25',
    cinematic: 'eq=contrast=1.15:saturation=0.95', vivid: 'eq=saturation=1.4:contrast=1.1',
    warm: 'colortemperature=temperature=5000', cool: 'colortemperature=temperature=7500',
    vintage: 'eq=saturation=0.85:contrast=1.05', bw: 'hue=s=0'
  };
  const filter = filters[type] || filters.bright;
  const scaleMap = { '480': 'scale=854:-2', '720': 'scale=1280:-2', '1080': 'scale=1920:-2', '2k': 'scale=2560:-2' };
  const scaleFilter = scaleMap[resolution] || scaleMap['720'];
  let outputFilter;
  if (type === 'upscale2k') outputFilter = 'scale=2560:-2:flags=fast_bilinear';
  else if (type === 'stabilize') outputFilter = 'deshake=rx=32:ry=32:blocksize=8,' + scaleFilter;
  else outputFilter = filter + ',' + scaleFilter;
  const is2K = (type === 'upscale2k' || resolution === '2k');
  const is1080 = (resolution === '1080');
  const crf = is2K ? '28' : (is1080 ? '27' : '28');
  const maxrate = is2K ? '5M' : (is1080 ? '3.5M' : '2M');
  const bufsize = is2K ? '10M' : (is1080 ? '7M' : '4M');
  const level = is2K ? '5.0' : '4.0';
  const output = `outputs/enh-${Date.now()}.mp4`;
  ffmpeg(req.file.path).videoCodec('libx264').audioCodec('aac')
    .outputOptions(['-vf', outputFilter,'-preset', 'ultrafast','-crf', crf,'-maxrate', maxrate,'-bufsize', bufsize,'-profile:v', 'baseline','-level', level,'-b:a', '96k','-movflags', '+faststart','-threads', '1'])
    .save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, 'picly-enhanced.mp4', () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// AI MAGIC
app.post('/api/ai-magic', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image' });
  const type = req.body.type || 'enhance';
  const filters = {
    enhance: 'unsharp=5:5:1.2:5:5:0,eq=brightness=0.08:contrast=1.2:saturation=1.15',
    restore: 'eq=saturation=1.3:contrast=1.15:brightness=0.05',
    glow: 'gblur=sigma=18,eq=brightness=0.15:saturation=1.3:contrast=1.1,unsharp=5:5:1.0:5:5:0'
  };
  const filter = filters[type] || filters.enhance;
  const output = `outputs/ai-${Date.now()}.jpg`;
  ffmpeg(req.file.path).outputOptions(['-vf', filter,'-q:v', '2','-threads', '1']).save(output)
    .on('end', () => { fs.unlinkSync(req.file.path); res.download(output, `picly-${type}-${Date.now()}.jpg`, () => { setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000); }); })
    .on('error', (err) => { try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); });
});

// CF IMAGE
app.post('/api/cf-image', async (req, res) => {
  try {
    const { prompt, aspect_ratio } = req.body;
    if (!prompt) return res.status(400).json({ error: 'No prompt' });
    if (!CF_ACCOUNT_ID || !CF_API_TOKEN) return res.status(500).json({ error: 'CF not set' });
    const cfResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) }
    );
    if (!cfResponse.ok) { const errText = await cfResponse.text(); throw new Error(`CF ${cfResponse.status}: ${errText.slice(0, 300)}`); }
    const cfData = await cfResponse.json();
    if (!cfData.result || !cfData.result.image) throw new Error('No image');
    const imageBuffer = Buffer.from(cfData.result.image, 'base64');
    if (!aspect_ratio || aspect_ratio === '1:1') return res.json({ success: true, result: { image: imageBuffer.toString('base64') } });
    const target = getDimensions(aspect_ratio);
    const tempIn = `uploads/cf-in-${Date.now()}.png`;
    const tempOut = `outputs/cf-out-${Date.now()}.png`;
    fs.writeFileSync(tempIn, imageBuffer);
    await new Promise((resolve, reject) => {
      ffmpeg(tempIn).outputOptions(['-vf', `crop=${target.w}:${target.h}:(iw-${target.w})/2:(ih-${target.h})/2`, '-frames:v', '1']).save(tempOut).on('end', resolve).on('error', reject);
    });
    const croppedBuffer = fs.readFileSync(tempOut);
    try { fs.unlinkSync(tempIn); } catch(e){}
    try { fs.unlinkSync(tempOut); } catch(e){}
    res.json({ success: true, result: { image: croppedBuffer.toString('base64') } });
  } catch (err) { console.error('❌ CF error:', err.message); res.status(500).json({ error: err.message }); }
});

// AI EDITOR
app.post('/api/ai-editor', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'No prompt' });
    const hqPath = `uploads/editor-hq-${Date.now()}.jpg`;
    await sharp(req.file.path).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 95, mozjpeg: true }).toFile(hqPath);
    const imageBuffer = fs.readFileSync(hqPath);
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('input_image', new Blob([imageBuffer], { type: 'image/jpeg' }), 'photo.jpg');
    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`,
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN }, body: formData }
    );
    if (!cfRes.ok) { const errText = await cfRes.text(); throw new Error(`CF ${cfRes.status}: ${errText.slice(0, 300)}`); }
    const cfData = await cfRes.json();
    if (!cfData.result || !cfData.result.image) throw new Error('No image');
    const outputBuffer = Buffer.from(cfData.result.image, 'base64');
    try { fs.unlinkSync(req.file.path); } catch(e){}
    try { fs.unlinkSync(hqPath); } catch(e){}
    res.set('Content-Type', 'image/png'); res.send(outputBuffer);
  } catch (err) { console.error('❌ AI Editor error:', err.message); try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); }
});

// CLIPDROP — UPSCALE (2x/4x)
app.post('/api/upscale', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    if (!CLIPDROP_KEY) return res.status(500).json({ error: 'Clipdrop key not set' });
    const scale = parseInt(req.body.scale) || 2;
    console.log(`🖼️ Upscaling ${scale}x...`);
    const metadata = await sharp(req.file.path).metadata();
    const origW = metadata.width || 1024;
    const origH = metadata.height || 1024;
    const targetW = Math.min(origW * scale, 4096);
    const targetH = Math.min(origH * scale, 4096);
    console.log(`Original: ${origW}x${origH} → Target: ${targetW}x${targetH} (${scale}x)`);
    const imageBuffer = fs.readFileSync(req.file.path);
    const formData = new FormData();
    formData.append('image_file', new Blob([imageBuffer], { type: 'image/png' }), 'photo.png');
    formData.append('target_width', String(targetW));
    formData.append('target_height', String(targetH));
    const cdRes = await fetch('https://clipdrop-api.co/image-upscaling/v1/upscale', { method: 'POST', headers: { 'x-api-key': CLIPDROP_KEY }, body: formData });
    if (!cdRes.ok) { const errText = await cdRes.text(); throw new Error(`Clipdrop ${cdRes.status}: ${errText.slice(0, 200)}`); }
    const upscaledBuffer = Buffer.from(await cdRes.arrayBuffer());
    const finalBuffer = await sharp(upscaledBuffer).sharpen({ sigma: 1.2, m1: 0.5, m2: 0.5 }).png({ compressionLevel: 1, adaptiveFiltering: false }).toBuffer();
    console.log(`✅ Final (${scale}x): ${(finalBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    try { fs.unlinkSync(req.file.path); } catch(e){}
    res.set('Content-Type', 'image/png'); res.send(finalBuffer);
  } catch (err) { console.error('❌ Upscale error:', err.message); try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); }
});

// CLIPDROP — CLEANUP
app.post('/api/cleanup', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    if (!CLIPDROP_KEY) return res.status(500).json({ error: 'Clipdrop key not set' });
    const imageBuffer = fs.readFileSync(req.file.path);
    const formData = new FormData();
    formData.append('image_file', new Blob([imageBuffer], { type: 'image/png' }), 'photo.png');
    formData.append('mask_file', new Blob([imageBuffer], { type: 'image/png' }), 'mask.png');
    const cdRes = await fetch('https://clipdrop-api.co/cleanup/v1', { method: 'POST', headers: { 'x-api-key': CLIPDROP_KEY }, body: formData });
    if (!cdRes.ok) { const errText = await cdRes.text(); throw new Error(`Clipdrop ${cdRes.status}: ${errText.slice(0, 200)}`); }
    const outputBuffer = Buffer.from(await cdRes.arrayBuffer());
    try { fs.unlinkSync(req.file.path); } catch(e){}
    res.set('Content-Type', 'image/jpeg'); res.send(outputBuffer);
  } catch (err) { console.error('❌ Cleanup error:', err.message); try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); }
});

// ==================== CODEFORMER — ASYNC RESTORE ====================
async function processRestore(jobId, filePath) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    console.log(`🎨 [${jobId}] Restoring with CodeFormer (384px)...`);

    const smallPath = `uploads/restore-small-${Date.now()}.jpg`;
    await sharp(filePath)
      .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(smallPath);

    const imageBuffer = fs.readFileSync(smallPath);
    const base64Image = 'data:image/jpeg;base64,' + imageBuffer.toString('base64');
    console.log(`📤 [${jobId}] Uploaded:`, (imageBuffer.length / 1024).toFixed(0), 'KB');

    // Step 1: POST
    const postController = new AbortController();
    const postTimeout = setTimeout(() => postController.abort(), 20000);
    const postRes = await fetch('https://sczhou-codeformer.hf.space/gradio_api/call/inference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [
          { url: base64Image, meta: { _type: 'gradio.FileData' } },
          true, true, true, 2, 0.7
        ]
      }),
      signal: postController.signal
    });
    clearTimeout(postTimeout);

    if (!postRes.ok) {
      const errText = await postRes.text();
      console.error(`❌ [${jobId}] POST failed:`, postRes.status, errText.slice(0, 500));
      throw new Error(`CodeFormer POST ${postRes.status}: ${errText.slice(0, 200)}`);
    }

    const postData = await postRes.json();
    const eventId = postData.event_id;
    if (!eventId) throw new Error('No event_id');
    console.log(`🆔 [${jobId}] Event ID:`, eventId);

    // Step 2: Poll (max 40 × 1.5 sec = 60 sec)
    let resultUrl = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));

      const pollController = new AbortController();
      const pollTimeout = setTimeout(() => pollController.abort(), 10000);

      try {
        const pollRes = await fetch(`https://sczhou-codeformer.hf.space/gradio_api/call/inference/${eventId}`, {
          signal: pollController.signal
        });
        clearTimeout(pollTimeout);

        const pollText = await pollRes.text();
        console.log(`🔍 [${jobId}] Poll ${i + 1} response:`, pollText.slice(0, 400));

        // Check for completed
        if (pollText.includes('process_completed')) {
          for (const line of pollText.split('\n')) {
            if (line.startsWith('data:')) {
              try {
                const jsonStr = line.replace('data:', '').trim();
                const data = JSON.parse(jsonStr);
                
                // Try multiple formats (Gradio v4 variations)
                let url = null;
                
                // Format 1: Array directly
                if (Array.isArray(data) && data[0]) {
                  if (typeof data[0] === 'string') url = data[0];
                  else if (data[0].url) url = data[0].url;
                  else if (data[0].path) url = data[0].path;
                }
                // Format 2: { data: [...] }
                else if (data && data.data && Array.isArray(data.data) && data.data[0]) {
                  if (typeof data.data[0] === 'string') url = data.data[0];
                  else if (data.data[0].url) url = data.data[0].url;
                  else if (data.data[0].path) url = data.data[0].path;
                }
                // Format 3: { output: { data: [...] } }
                else if (data && data.output && data.output.data) {
                  const out = data.output.data;
                  if (Array.isArray(out) && out[0]) {
                    if (typeof out[0] === 'string') url = out[0];
                    else if (out[0].url) url = out[0].url;
                    else if (out[0].path) url = out[0].path;
                  }
                }
                // Format 4: { output: [...] }
                else if (data && data.output && Array.isArray(data.output) && data.output[0]) {
                  if (typeof data.output[0] === 'string') url = data.output[0];
                  else if (data.output[0].url) url = data.output[0].url;
                }
                
                if (url) {
                  // If relative URL, prepend HF Space URL
                  if (url.startsWith('/')) {
                    url = 'https://sczhou-codeformer.hf.space' + url;
                  }
                  resultUrl = url;
                  console.log(`✅ [${jobId}] Result URL found:`, url);
                  break;
                }
              } catch (e) {
                console.log(`⚠️ [${jobId}] Parse error:`, e.message);
              }
            }
          }
          if (resultUrl) break;
        }

        if (pollText.includes('event: error')) {
          console.error(`❌ [${jobId}] Poll error:`, pollText.slice(0, 500));
          throw new Error('CodeFormer error');
        }
      } catch (e) {
        clearTimeout(pollTimeout);
        if (e.name === 'AbortError') continue;
        throw e;
      }
    }

    if (!resultUrl) throw new Error('CodeFormer timeout — no result URL');

    // Step 3: Download result
    console.log(`📥 [${jobId}] Downloading result from:`, resultUrl);
    const imgController = new AbortController();
    const imgTimeout = setTimeout(() => imgController.abort(), 20000);
    const imgRes = await fetch(resultUrl, { signal: imgController.signal });
    clearTimeout(imgTimeout);

    if (!imgRes.ok) throw new Error('Failed to download result image');

    const outputBuffer = Buffer.from(await imgRes.arrayBuffer());

    try { fs.unlinkSync(filePath); } catch(e){}
    try { fs.unlinkSync(smallPath); } catch(e){}

    // Update job
    job.status = 'completed';
    job.resultBuffer = outputBuffer;
    // Detect actual format from magic bytes
    if (outputBuffer[0] === 0xFF && outputBuffer[1] === 0xD8) job.contentType = 'image/jpeg';
    else if (outputBuffer[0] === 0x89 && outputBuffer[1] === 0x50) job.contentType = 'image/png';
    else if (outputBuffer[0] === 0x52 && outputBuffer[1] === 0x49 && outputBuffer[8] === 0x57) job.contentType = 'image/webp';
    else job.contentType = 'image/png';
    console.log(`✅ [${jobId}] Restored:`, (outputBuffer.length / 1024).toFixed(0), 'KB, Type:', job.contentType);
  } catch (err) {
    console.error(`❌ [${jobId}] Restore error:`, err.message);
    console.error(`❌ [${jobId}] Stack:`, (err.stack || '').substring(0, 500));
    job.status = 'failed';
    job.error = err.message;
    try { fs.unlinkSync(filePath); } catch(e){}
  }
}

app.post('/api/restore', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const jobId = createJob();
    console.log(`🎯 New job: ${jobId}`);
    processRestore(jobId, req.file.path);
    res.json({ jobId, status: 'processing' });
  } catch (err) {
    console.error('❌ Restore start error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/restore-status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, error: job.error });
});

app.get('/api/restore-result/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'Job not completed', status: job.status });
  const ct = job.contentType || 'image/png';
  const ext = ct.includes('jpeg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
  res.set('Content-Type', ct);
  res.set('Content-Disposition', 'inline; filename="restored.' + ext + '"');
  res.send(job.resultBuffer);
});

// BG REMOVE
async function removeBgLocal(imageBuffer) {
  if (!removeBackground) throw new Error('imgly not installed');
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  const resultBlob = await removeBackground(blob);
  return Buffer.from(await resultBlob.arrayBuffer());
}

app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    if (!removeBackground) return res.status(500).json({ error: 'imgly not installed' });
    const imageBuffer = fs.readFileSync(req.file.path);
    const transparentPng = await removeBgLocal(imageBuffer);
    try { fs.unlinkSync(req.file.path); } catch(e){}
    res.set('Content-Type', 'image/png'); res.send(transparentPng);
  } catch (err) { console.error('❌ BG remove error:', err.message); try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); }
});

// BG REPLACE
app.post('/api/merge-bg', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const { bgPrompt } = req.body;
    if (!bgPrompt) return res.status(400).json({ error: 'No bg prompt' });
    if (!removeBackground) return res.status(500).json({ error: 'imgly not installed' });
    const imageBuffer = fs.readFileSync(req.file.path);
    const transparentPng = await removeBgLocal(imageBuffer);
    const fgPath = `uploads/fg-${Date.now()}.png`;
    fs.writeFileSync(fgPath, transparentPng);
    try { fs.unlinkSync(req.file.path); } catch(e){}
    const bgRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + CF_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: bgPrompt + ', cinematic, photorealistic, 8k' }) }
    );
    if (!bgRes.ok) throw new Error('BG generate failed');
    const bgData = await bgRes.json();
    if (!bgData.result || !bgData.result.image) throw new Error('No BG image');
    const bgImageBuffer = Buffer.from(bgData.result.image, 'base64');
    const bgPath = `uploads/bg-${Date.now()}.png`;
    fs.writeFileSync(bgPath, bgImageBuffer);
    const outputPath = `outputs/merged-${Date.now()}.png`;
    await new Promise((resolve, reject) => {
      ffmpeg().input(bgPath).input(fgPath)
        .complexFilter(['[1:v]scale=1024:1024:force_original_aspect_ratio=decrease[fg]', '[0:v][fg]overlay=(W-w)/2:(H-h)/2'])
        .outputOptions(['-frames:v', '1']).save(outputPath).on('end', resolve).on('error', reject);
    });
    try { fs.unlinkSync(fgPath); } catch(e){}
    try { fs.unlinkSync(bgPath); } catch(e){}
    res.download(outputPath, 'picly-bg-replace.png', () => { setTimeout(() => { try { fs.unlinkSync(outputPath); } catch(e){} }, 30000); });
  } catch (err) { console.error('❌ Merge error:', err.message); try { fs.unlinkSync(req.file.path); } catch(e){} res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
  console.log(`imgly: ${removeBackground ? '✅' : '❌'}`);
  console.log(`CF: ${CF_ACCOUNT_ID && CF_API_TOKEN ? '✅' : '❌'}`);
  console.log(`Clipdrop: ${CLIPDROP_KEY ? '✅' : '❌'}`);
  console.log(`HF: ${HF_TOKEN ? '✅' : '❌'}`);
  console.log(`sharp: ✅`);
  console.log(`Async restore: ✅`);
});