"""
Video Compressor — Flask Backend
Serves the frontend and provides REST API for video compression via FFmpeg.
"""

import os
import uuid
import shutil

from flask import Flask, request, jsonify, send_from_directory, send_file

from compressor import detect_hardware_encoder, FFmpegCompressor, format_bytes

# ===== CONFIG =====
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
UPLOAD_DIR = os.path.join(TEMP_DIR, "uploads")
OUTPUT_DIR = os.path.join(TEMP_DIR, "output")

MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024  # 5 GB

# Ensure temp directories exist
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ===== INIT =====
app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE

# Detect best encoder at startup
best_encoder = detect_hardware_encoder()

# Track active jobs
jobs = {}


# ===== STATIC FILES =====

@app.route("/")
def serve_index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/<path:path>")
def serve_static(path):
    return send_from_directory(WEB_DIR, path)


# ===== API ROUTES =====

@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "encoder": best_encoder.get("name", "detecting...")})


@app.route("/api/compress", methods=["POST"])
def compress():
    if "video" not in request.files:
        return jsonify({"error": "No video file provided"}), 400

    file = request.files["video"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    # Generate job ID
    job_id = str(uuid.uuid4())

    # Save uploaded file
    ext = os.path.splitext(file.filename)[1] or ".mp4"
    input_path = os.path.join(UPLOAD_DIR, f"{job_id}{ext}")
    file.save(input_path)

    original_size = os.path.getsize(input_path)

    # Parse settings
    settings = {
        "mode": request.form.get("mode", "basic"),
        "targetSizeMB": request.form.get("targetSizeMB", "30"),
        "quality": request.form.get("quality", "medium"),
        "crf": request.form.get("crf", "28"),
        "resolution": request.form.get("resolution", "original"),
        "format": request.form.get("format", "mp4"),
        "bitrate": request.form.get("bitrate", ""),
        "muteAudio": request.form.get("muteAudio", "false"),
    }

    # Determine output format
    out_ext = ".webm" if settings["format"] == "webm" else ".mp4"
    output_path = os.path.join(OUTPUT_DIR, f"{job_id}{out_ext}")

    # Create compressor and start
    compressor = FFmpegCompressor(best_encoder)
    jobs[job_id] = {
        "compressor": compressor,
        "input_path": input_path,
        "output_path": output_path,
        "original_name": file.filename,
        "original_size": original_size,
    }

    compressor.compress(input_path, output_path, settings, original_size)

    print(f"\n  🎬 [Job {job_id[:8]}] Started — {format_bytes(original_size)} — {best_encoder['name']}")

    return jsonify({"jobId": job_id, "encoder": best_encoder["name"]})


@app.route("/api/status/<job_id>", methods=["GET"])
def status(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404

    job = jobs[job_id]
    compressor = job["compressor"]
    state = compressor.get_state()

    response = {
        "status": state["status"],
        "progress": state["progress"],
        "elapsed": state["elapsed"],
    }

    if state["status"] == "done":
        try:
            compressed_size = os.path.getsize(job["output_path"])
            original_size = job["original_size"]
            ratio = round((1 - compressed_size / original_size) * 100, 1) if original_size > 0 else 0
            response.update({
                "compressedSize": compressed_size,
                "originalSize": original_size,
                "ratio": ratio,
            })
        except OSError:
            response["status"] = "error"
            response["error"] = "Output file not found"

    if state["status"] == "error":
        response["error"] = state["error"]

    return jsonify(response)


@app.route("/api/download/<job_id>", methods=["GET"])
def download(job_id):
    if job_id not in jobs:
        return jsonify({"error": "File not available"}), 404

    job = jobs[job_id]
    compressor = job["compressor"]
    state = compressor.get_state()

    if state["status"] != "done":
        return jsonify({"error": "File not ready"}), 404

    if not os.path.exists(job["output_path"]):
        return jsonify({"error": "Compressed file no longer exists"}), 404

    base_name = os.path.splitext(job["original_name"])[0]
    ext = os.path.splitext(job["output_path"])[1]
    download_name = f"{base_name}_compressed{ext}"

    return send_file(
        job["output_path"],
        as_attachment=True,
        download_name=download_name,
        mimetype="video/webm" if ext == ".webm" else "video/mp4",
    )


@app.route("/api/cancel/<job_id>", methods=["POST"])
def cancel(job_id):
    if job_id not in jobs:
        return jsonify({"error": "Job not found"}), 404

    job = jobs[job_id]
    job["compressor"].cancel()

    # Cleanup files
    _cleanup_job(job)

    return jsonify({"status": "cancelled"})


# ===== HELPERS =====

def _cleanup_job(job):
    """Remove temp files for a job."""
    for path_key in ("input_path", "output_path"):
        path = job.get(path_key, "")
        try:
            if path and os.path.exists(path):
                os.unlink(path)
        except OSError:
            pass


def _clean_temp_dirs():
    """Remove leftover files from previous runs."""
    for dir_path in (UPLOAD_DIR, OUTPUT_DIR):
        try:
            for f in os.listdir(dir_path):
                filepath = os.path.join(dir_path, f)
                if os.path.isfile(filepath):
                    os.unlink(filepath)
        except OSError:
            pass


# ===== STARTUP =====
_clean_temp_dirs()

if __name__ == "__main__":
    print(f"\n  🎬 Video Compressor Backend")
    print(f"  ⚡ Encoder: {best_encoder['name']}")
    print(f"  🌐 http://localhost:5000\n")

    app.run(host="0.0.0.0", port=5000, debug=False)
