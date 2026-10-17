# Audio Transcribe

A web page that turns a video into audio, and audio into a Markdown transcript with speaker labels ("Speaker 1", "Speaker 2"). Built for training.

**Everything runs inside the visitor's browser tab. Video and audio files are never uploaded.** The page downloads the program (ffmpeg) and the speech models, which are public software, not user files.

## Use
Open the page in Chrome or Edge on a computer.
1. **Step 1, video to audio:** drop a video, click Convert. The page shows the ffmpeg command and plays the WAV.
2. **Step 2, audio to Markdown:** drop an audio file (or use the Step 1 result), choose accuracy, click Make the transcript. Download or copy the Markdown.

The first transcription downloads the speech models (about 150 MB for the faster setting, about 600 MB for the more accurate one). The browser keeps them afterward.

## Limits
- Videos up to about 1.5 GB; recordings up to 40 minutes.
- Slower than the desktop apps. Chrome or Edge with graphics acceleration (WebGPU) is much faster than without.
- Transcripts are machine drafts. Speaker labels are guesses from voice sound. Verify against the recording before relying on anything. Phone-quality audio is the hardest case.
- For large or sensitive discovery files, use the desktop app instead.

## How it is built
No server and no build step: static files only.
- `index.html`, `js/main.js`: the page.
- `js/worker.js`: speech detection, voice grouping, and Whisper, run in a background thread using transformers.js.
- `js/markdown.js`: builds the Markdown.
- `vendor/ffmpeg/`: ffmpeg.wasm 0.12 (browser build of ffmpeg).

To run locally: `python3 -m http.server 8000` in this folder, then open http://localhost:8000.
