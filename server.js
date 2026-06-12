import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Create temp directories
const UPLOAD_DIR = path.join(__dirname, 'temp', 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'temp', 'output');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());

// Multer config
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 },
});

// Track jobs
const jobs = new Map();

// ===== HARDWARE ENCODER DETECTION =====
let bestEncoder = null;
let hwAccelArgs = [];

function detectHardwareEncoder() {
  console.log('\n  🔍 Detecting hardware encoders...');

  // Priority order: QSV > NVENC > AMF > software
  const candidates = [
    {
      name: 'Intel QSV (h264_qsv)',
      encoder: 'h264_qsv',
      testArgs: ['-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=1', '-c:v', 'h264_qsv', '-frames:v', '1', '-f', 'null', '-'],
      accelArgs: ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'],
      encodeArgs: (bitrate, crf) => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', String(crf), '-b:v', `${bitrate}k`],
    },
    {
      name: 'NVIDIA NVENC (h264_nvenc)',
      encoder: 'h264_nvenc',
      testArgs: ['-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=1', '-c:v', 'h264_nvenc', '-frames:v', '1', '-f', 'null', '-'],
      accelArgs: ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
      encodeArgs: (bitrate, crf) => ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf), '-b:v', `${bitrate}k`],
    },
    {
      name: 'AMD AMF (h264_amf)',
      encoder: 'h264_amf',
      testArgs: ['-hide_banner', '-f', 'lavfi', '-i', 'nullsrc=s=256x256:d=1', '-c:v', 'h264_amf', '-frames:v', '1', '-f', 'null', '-'],
      accelArgs: [],
      encodeArgs: (bitrate, crf) => ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-qp_i', String(crf), '-qp_p', String(crf), '-b:v', `${bitrate}k`],
    },
  ];

  for (const candidate of candidates) {
    try {
      execSync(`ffmpeg ${candidate.testArgs.join(' ')}`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      bestEncoder = candidate;
      console.log(`  ✅ Using: ${candidate.name}`);
      return;
    } catch (e) {
      console.log(`  ❌ ${candidate.name} — not available`);
    }
  }

  // Fallback to software
  bestEncoder = {
    name: 'Software (libx264 ultrafast)',
    encoder: 'libx264',
    accelArgs: [],
    encodeArgs: (bitrate, crf) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(crf), '-b:v', `${bitrate}k`],
  };
  console.log(`  ⚠️  Fallback: ${bestEncoder.name}`);
}

// ===== ROUTES =====

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', encoder: bestEncoder?.name || 'detecting...' });
});

app.post('/api/compress', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const jobId = uuidv4();
  const inputPath = req.file.path;
  const settings = {
    mode: req.body.mode || 'basic',
    targetSizeMB: parseInt(req.body.targetSizeMB, 10) || 30,
    quality: req.body.quality || 'medium',
    crf: parseInt(req.body.crf, 10) || 28,
    resolution: req.body.resolution || 'original',
    format: req.body.format || 'mp4',
    bitrate: req.body.bitrate || '',
    muteAudio: req.body.muteAudio === 'true',
  };

  const ext = settings.format === 'webm' ? 'webm' : 'mp4';
  const outputPath = path.join(OUTPUT_DIR, `${jobId}.${ext}`);

  jobs.set(jobId, {
    status: 'processing',
    progress: 0,
    inputPath,
    outputPath,
    originalName: req.file.originalname,
    originalSize: req.file.size,
    process: null,
    startTime: Date.now(),
  });

  compressVideo(jobId, inputPath, outputPath, settings, req.file.size);
  res.json({ jobId, encoder: bestEncoder.name });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const response = {
    status: job.status,
    progress: job.progress,
    elapsed: Math.round((Date.now() - job.startTime) / 1000),
  };

  if (job.status === 'done') {
    try {
      const stat = fs.statSync(job.outputPath);
      response.compressedSize = stat.size;
      response.originalSize = job.originalSize;
      response.ratio = ((1 - stat.size / job.originalSize) * 100).toFixed(1);
      response.elapsed = Math.round((job.endTime - job.startTime) / 1000);
    } catch (e) {
      response.status = 'error';
      response.error = 'Output file not found';
    }
  }

  if (job.status === 'error') response.error = job.error;

  res.json(response);
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'done') {
    return res.status(404).json({ error: 'File not available' });
  }

  if (!fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: 'Compressed file no longer exists' });
  }

  const baseName = path.parse(job.originalName).name;
  const ext = path.extname(job.outputPath);
  const downloadName = `${baseName}_compressed${ext}`;
  const stat = fs.statSync(job.outputPath);

  res.setHeader('Content-Type', ext === '.webm' ? 'video/webm' : 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
});

app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.process) job.process.kill('SIGTERM');
  job.status = 'cancelled';
  cleanupJob(req.params.jobId);
  res.json({ status: 'cancelled' });
});

// ===== COMPRESSION =====

async function getVideoDuration(inputPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      inputPath,
    ]);
    let output = '';
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', () => resolve(parseFloat(output.trim()) || 60));
    proc.on('error', () => resolve(60));
  });
}

async function compressVideo(jobId, inputPath, outputPath, settings, originalSize) {
  const job = jobs.get(jobId);

  try {
    const duration = await getVideoDuration(inputPath);
    const args = buildFFmpegArgs(inputPath, outputPath, settings, duration, originalSize);

    console.log(`\n  [Job ${jobId.slice(0, 8)}] Encoder: ${bestEncoder.name}`);
    console.log(`  [Job ${jobId.slice(0, 8)}] Command: ffmpeg ${args.join(' ')}\n`);

    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    job.process = proc;

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch && duration > 0) {
        const sec = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        job.progress = Math.min(Math.round((sec / duration) * 100), 99);
      }
      // Also check for speed info
      const speedMatch = str.match(/speed=\s*([\d.]+)x/);
      if (speedMatch) {
        job.speed = parseFloat(speedMatch[1]);
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        job.status = 'done';
        job.progress = 100;
        job.endTime = Date.now();
        const elapsed = ((job.endTime - job.startTime) / 1000).toFixed(1);
        const compressedSize = fs.statSync(outputPath).size;
        console.log(`  ✅ [Job ${jobId.slice(0, 8)}] Done in ${elapsed}s — ${formatBytes(originalSize)} → ${formatBytes(compressedSize)}`);
        try { fs.unlinkSync(inputPath); } catch (e) {}
      } else if (job.status !== 'cancelled') {
        job.status = 'error';
        job.error = `FFmpeg exited with code ${code}`;
        console.error(`  ❌ [Job ${jobId.slice(0, 8)}] Failed with code ${code}`);
        cleanupJob(jobId);
      }
    });

    proc.on('error', (err) => {
      job.status = 'error';
      job.error = err.message;
      cleanupJob(jobId);
    });

  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    cleanupJob(jobId);
  }
}

function buildFFmpegArgs(inputPath, outputPath, settings, duration, originalSize) {
  const args = ['-y'];

  // Add hardware acceleration input args (for decode acceleration)
  // Note: skip hw accel input for QSV as it can cause issues with some input formats
  // We'll use hw accel on the encoding side which is where the big speed win is

  args.push('-i', inputPath);

  if (settings.format === 'webm') {
    // WebM: use libvpx-vp9 with speed optimizations (no HW accel available for VP9 on most GPUs)
    const crf = settings.mode === 'basic' ? getCRFFromQuality(settings.quality) : settings.crf;
    args.push(
      '-c:v', 'libvpx-vp9',
      '-crf', String(crf),
      '-b:v', '0',
      '-deadline', 'realtime',
      '-cpu-used', '8',    // Max speed for VP9
      '-row-mt', '1',       // Enable row-based multithreading
    );
  } else {
    // MP4: use best available hardware encoder
    const crf = settings.mode === 'basic' ? getCRFFromQuality(settings.quality) : settings.crf;

    if (settings.mode === 'basic') {
      const targetBytes = settings.targetSizeMB * 1024 * 1024;
      const audioBitrate = 128;
      const videoBitrate = Math.max(200, Math.round(((targetBytes * 8) / duration - audioBitrate * 1000) / 1000));
      args.push(...bestEncoder.encodeArgs(videoBitrate, crf));
      args.push('-maxrate', `${Math.round(videoBitrate * 1.5)}k`, '-bufsize', `${videoBitrate * 2}k`);
    } else {
      const bitrate = settings.bitrate ? parseInt(settings.bitrate, 10) : 2000;
      args.push(...bestEncoder.encodeArgs(bitrate, crf));

      if (settings.bitrate) {
        args.push('-maxrate', `${parseInt(settings.bitrate, 10) * 1.5}k`);
      }
    }

    // Resolution scaling
    if (settings.resolution && settings.resolution !== 'original') {
      args.push('-vf', `scale=${settings.resolution}`);
    }
  }

  // Audio
  if (settings.muteAudio) {
    args.push('-an');
  } else {
    if (settings.format === 'webm') {
      args.push('-c:a', 'libopus', '-b:a', '128k');
    } else {
      args.push('-c:a', 'aac', '-b:a', '128k');
    }
  }

  args.push('-movflags', '+faststart', '-threads', '0', outputPath);
  return args;
}

function getCRFFromQuality(quality) {
  switch (quality) {
    case 'high':   return 22;
    case 'low':    return 34;
    default:       return 28;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 0) + ' ' + sizes[i];
}

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  try { if (fs.existsSync(job.inputPath)) fs.unlinkSync(job.inputPath); } catch (e) {}
  try { if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch (e) {}
  setTimeout(() => jobs.delete(jobId), 5 * 60 * 1000);
}

// Clean temp on startup
for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  try {
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  } catch (e) {}
}

// ===== START =====
detectHardwareEncoder();

app.listen(PORT, () => {
  console.log(`\n  🎬 Video Compressor Backend running at http://localhost:${PORT}`);
  console.log(`  ⚡ Encoder: ${bestEncoder.name}\n`);
});
