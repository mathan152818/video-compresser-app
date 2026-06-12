"""
FFmpeg Video Compression Engine
Handles hardware encoder detection, video compression, and progress tracking.
"""

import os
import re
import subprocess
import threading
import time
import shutil


# ===== HARDWARE ENCODER DETECTION =====

ENCODER_CANDIDATES = [
    {
        "name": "Intel QSV (h264_qsv)",
        "encoder": "h264_qsv",
        "test_args": [
            "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
            "-c:v", "h264_qsv", "-frames:v", "1", "-f", "null", "-",
        ],
        "encode_fn": lambda br, crf: [
            "-c:v", "h264_qsv", "-preset", "veryfast",
            "-global_quality", str(crf), "-b:v", f"{br}k",
        ],
    },
    {
        "name": "NVIDIA NVENC (h264_nvenc)",
        "encoder": "h264_nvenc",
        "test_args": [
            "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
            "-c:v", "h264_nvenc", "-frames:v", "1", "-f", "null", "-",
        ],
        "encode_fn": lambda br, crf: [
            "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "hq",
            "-rc", "vbr", "-cq", str(crf), "-b:v", f"{br}k",
        ],
    },
    {
        "name": "AMD AMF (h264_amf)",
        "encoder": "h264_amf",
        "test_args": [
            "-hide_banner", "-f", "lavfi", "-i", "nullsrc=s=256x256:d=1",
            "-c:v", "h264_amf", "-frames:v", "1", "-f", "null", "-",
        ],
        "encode_fn": lambda br, crf: [
            "-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak",
            "-qp_i", str(crf), "-qp_p", str(crf), "-b:v", f"{br}k",
        ],
    },
]

SOFTWARE_ENCODER = {
    "name": "Software (libx264 veryfast)",
    "encoder": "libx264",
    "encode_fn": lambda br, crf: [
        "-c:v", "libx264", "-preset", "veryfast",
        "-crf", str(crf), "-b:v", f"{br}k",
    ],
}


def detect_hardware_encoder():
    """Detect the best available hardware encoder, falling back to software."""
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        print("  ❌ FFmpeg not found on PATH!")
        return SOFTWARE_ENCODER

    print("\n  🔍 Detecting hardware encoders...")

    for candidate in ENCODER_CANDIDATES:
        try:
            subprocess.run(
                ["ffmpeg"] + candidate["test_args"],
                capture_output=True,
                timeout=10,
                check=True,
            )
            print(f"  ✅ Using: {candidate['name']}")
            return candidate
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            print(f"  ❌ {candidate['name']} — not available")

    print(f"  ⚠️  Fallback: {SOFTWARE_ENCODER['name']}")
    return SOFTWARE_ENCODER


# ===== VIDEO DURATION =====

def get_video_duration(input_path):
    """Get video duration in seconds using ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "csv=p=0",
                input_path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return float(result.stdout.strip()) if result.stdout.strip() else 60.0
    except Exception:
        return 60.0


# ===== CRF MAPPING =====

def get_crf_from_quality(quality):
    """Map quality preset name to CRF value."""
    return {"high": 22, "low": 34}.get(quality, 28)


# ===== FFMPEG COMPRESSOR =====

class FFmpegCompressor:
    """Manages a single FFmpeg compression job."""

    def __init__(self, encoder):
        self.encoder = encoder
        self.process = None
        self.progress = 0
        self.speed = 0.0
        self.status = "pending"       # pending | processing | done | error | cancelled
        self.error = None
        self.start_time = None
        self.end_time = None
        self._lock = threading.Lock()

    def compress(self, input_path, output_path, settings, original_size):
        """Start compression in a background thread."""
        self.status = "processing"
        self.start_time = time.time()

        thread = threading.Thread(
            target=self._run,
            args=(input_path, output_path, settings, original_size),
            daemon=True,
        )
        thread.start()

    def _run(self, input_path, output_path, settings, original_size):
        """Execute FFmpeg compression."""
        try:
            duration = get_video_duration(input_path)
            args = self._build_args(input_path, output_path, settings, duration, original_size)

            print(f"\n  ▶ FFmpeg: {' '.join(args)}")

            self.process = subprocess.Popen(
                args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )

            # Parse stderr for progress in real time
            time_pattern = re.compile(r"time=(\d+):(\d+):(\d+\.?\d*)")
            speed_pattern = re.compile(r"speed=\s*([\d.]+)x")

            for text in self.process.stderr:
                if self.status == "cancelled":
                    break

                match = time_pattern.search(text)
                if match and duration > 0:
                    sec = (
                        int(match.group(1)) * 3600
                        + int(match.group(2)) * 60
                        + float(match.group(3))
                    )
                    with self._lock:
                        self.progress = min(int((sec / duration) * 100), 99)

                speed_match = speed_pattern.search(text)
                if speed_match:
                    with self._lock:
                        self.speed = float(speed_match.group(1))

            self.process.wait()

            if self.status == "cancelled":
                return

            if self.process.returncode == 0 and os.path.exists(output_path):
                with self._lock:
                    self.status = "done"
                    self.progress = 100
                    self.end_time = time.time()

                compressed_size = os.path.getsize(output_path)
                elapsed = f"{self.end_time - self.start_time:.1f}"
                print(
                    f"  ✅ Done in {elapsed}s — "
                    f"{format_bytes(original_size)} → {format_bytes(compressed_size)}"
                )

                # Clean up input file
                try:
                    os.unlink(input_path)
                except OSError:
                    pass
            else:
                with self._lock:
                    self.status = "error"
                    self.error = f"FFmpeg exited with code {self.process.returncode}"
                print(f"  ❌ FFmpeg failed with code {self.process.returncode}")

        except Exception as e:
            with self._lock:
                self.status = "error"
                self.error = str(e)
            print(f"  ❌ Compression error: {e}")

    def _build_args(self, input_path, output_path, settings, duration, original_size):
        """Build FFmpeg command-line arguments."""
        args = ["ffmpeg", "-y", "-i", input_path]

        fmt = settings.get("format", "mp4")

        if fmt == "webm":
            # WebM: VP9 software encoding (no HW accel for VP9 on most GPUs)
            crf = (
                get_crf_from_quality(settings.get("quality", "medium"))
                if settings.get("mode") == "basic"
                else int(settings.get("crf", 28))
            )
            args += [
                "-c:v", "libvpx-vp9",
                "-crf", str(crf),
                "-b:v", "0",
                "-deadline", "realtime",
                "-cpu-used", "8",
                "-row-mt", "1",
            ]
        else:
            # MP4: use best encoder
            crf = (
                get_crf_from_quality(settings.get("quality", "medium"))
                if settings.get("mode") == "basic"
                else int(settings.get("crf", 28))
            )

            if settings.get("mode") == "basic":
                target_bytes = int(settings.get("targetSizeMB", 30)) * 1024 * 1024
                audio_bitrate = 128  # kbps
                video_bitrate = max(
                    200,
                    round(((target_bytes * 8) / duration - audio_bitrate * 1000) / 1000),
                )
                args += self.encoder["encode_fn"](video_bitrate, crf)
                args += [
                    "-maxrate", f"{video_bitrate}k",
                    "-bufsize", f"{video_bitrate * 2}k",
                ]
            else:
                bitrate = int(settings.get("bitrate") or 2000)
                args += self.encoder["encode_fn"](bitrate, crf)

                if settings.get("bitrate"):
                    args += ["-maxrate", f"{int(float(settings['bitrate']) * 1.5)}k"]

            # Resolution scaling
            resolution = settings.get("resolution", "original")
            if resolution and resolution != "original":
                args += ["-vf", f"scale={resolution}"]

        # Audio
        if settings.get("muteAudio") == "true":
            args += ["-an"]
        else:
            if fmt == "webm":
                args += ["-c:a", "libopus", "-b:a", "128k"]
            else:
                args += ["-c:a", "aac", "-b:a", "128k"]

        args += ["-movflags", "+faststart", "-threads", "0", output_path]
        return args

    def cancel(self):
        """Cancel the running compression."""
        with self._lock:
            self.status = "cancelled"
        if self.process:
            try:
                self.process.terminate()
            except OSError:
                pass

    def get_state(self):
        """Get current job state (thread-safe)."""
        with self._lock:
            elapsed = 0
            if self.start_time:
                end = self.end_time or time.time()
                elapsed = round(end - self.start_time)

            return {
                "status": self.status,
                "progress": self.progress,
                "speed": self.speed,
                "elapsed": elapsed,
                "error": self.error,
            }


# ===== UTILITIES =====

def format_bytes(size):
    """Format bytes to human readable string."""
    if size == 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB"]
    i = 0
    while size >= 1024 and i < len(units) - 1:
        size /= 1024
        i += 1
    return f"{size:.2f} {units[i]}" if i > 1 else f"{size:.0f} {units[i]}"
