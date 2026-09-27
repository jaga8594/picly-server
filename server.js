const express = require('express');
const multer = require('multer');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors());

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 }
});

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('outputs')) fs.mkdirSync('outputs');

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'picly-ffmpeg', time: new Date().toISOString() });
});

app.post('/api/trim', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const start = parseFloat(req.body.start) || 0;
  const end = parseFloat(req.body.end) || 0;
  const duration = end - start;
  if (duration <= 0) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Invalid range' }); }

  const output = `outputs/trim-${Date.now()}.mp4`;
  console.log(`Trim: ${start}s → ${end}s`);

  ffmpeg(req.file.path)
    .setStartTime(start)
    .setDuration(duration)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions([
      '-vf', 'scale=720:-2',
      '-preset', 'medium',
      '-crf', '23',
      '-maxrate', '2.5M',
      '-bufsize', '5M',
      '-profile:v', 'high',
      '-level', '4.0',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-threads', '0'
    ])
    .save(output)
    .on('end', () => {
      console.log('✅ Trim done:', output);
      fs.unlinkSync(req.file.path);
      res.download(output, 'picly-trimmed.mp4', () => {
        setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000);
      });
    })
    .on('error', (err) => {
      console.error('❌ Error:', err.message);
      try { fs.unlinkSync(req.file.path); } catch(e){}
      res.status(500).json({ error: err.message });
    });
});

app.post('/api/compress', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const quality = req.body.quality || 'medium';
  const presets = {
    high:   { crf: '20', preset: 'slow',   maxrate: '3M' },
    medium: { crf: '23', preset: 'medium', maxrate: '2.5M' },
    low:    { crf: '28', preset: 'fast',   maxrate: '1.5M' }
  };
  const p = presets[quality] || presets.medium;
  const output = `outputs/comp-${Date.now()}.mp4`;
  console.log(`Compress: ${quality}`);

  ffmpeg(req.file.path)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions([
      '-vf', 'scale=720:-2',
      '-preset', p.preset,
      '-crf', p.crf,
      '-maxrate', p.maxrate,
      '-bufsize', '5M',
      '-profile:v', 'high',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-threads', '0'
    ])
    .save(output)
    .on('end', () => {
      console.log('✅ Compress done:', output);
      fs.unlinkSync(req.file.path);
      res.download(output, 'picly-compressed.mp4', () => {
        setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000);
      });
    })
    .on('error', (err) => {
      console.error('❌ Error:', err.message);
      try { fs.unlinkSync(req.file.path); } catch(e){}
      res.status(500).json({ error: err.message });
    });
});

app.post('/api/mp3', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const output = `outputs/audio-${Date.now()}.mp3`;
  console.log('Extract MP3');

  ffmpeg(req.file.path)
    .noVideo()
    .audioCodec('libmp3lame')
    .audioQuality(2)
    .outputOptions(['-threads', '0'])
    .save(output)
    .on('end', () => {
      console.log('✅ MP3 done:', output);
      fs.unlinkSync(req.file.path);
      res.download(output, 'picly-audio.mp3', () => {
        setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000);
      });
    })
    .on('error', (err) => {
      console.error('❌ Error:', err.message);
      try { fs.unlinkSync(req.file.path); } catch(e){}
      res.status(500).json({ error: err.message });
    });
});

app.post('/api/gif', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video' });
  const start = parseFloat(req.body.start) || 0;
  const duration = parseFloat(req.body.duration) || 3;
  const fps = req.body.fps || '15';
  const output = `outputs/gif-${Date.now()}.gif`;
  console.log(`GIF: ${start}s, ${duration}s, ${fps}fps`);

  ffmpeg(req.file.path)
    .setStartTime(start)
    .setDuration(duration)
    .outputOptions([
      '-vf', `fps=${fps},scale=480:-1:flags=lanczos`,
      '-threads', '0'
    ])
    .save(output)
    .on('end', () => {
      console.log('✅ GIF done:', output);
      fs.unlinkSync(req.file.path);
      res.download(output, 'picly.gif', () => {
        setTimeout(() => { try { fs.unlinkSync(output); } catch(e){} }, 30000);
      });
    })
    .on('error', (err) => {
      console.error('❌ Error:', err.message);
      try { fs.unlinkSync(req.file.path); } catch(e){}
      res.status(500).json({ error: err.message });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`FFmpeg: ${ffmpegPath}`);
});