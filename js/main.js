import { buildMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const stem = (n) => n.replace(/\.[^.]+$/, '');
const mb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

let ffmpeg = null;
let step1Wav = null; // { name, blob }
let step2File = null; // File or Blob with .name

// ---------- ffmpeg (video to audio) ----------
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = window.FFmpegWASM;
  const f = new FFmpeg();
  const abs = (p) => new URL(p, document.baseURI).href;
  await f.load({ coreURL: abs('vendor/ffmpeg/ffmpeg-core.js'), wasmURL: abs('vendor/ffmpeg/ffmpeg-core.wasm') });
  ffmpeg = f;
  return f;
}

async function toWav(file, onProgress) {
  const f = await getFFmpeg();
  const ext = (file.name.match(/\.[^.]+$/) || ['.bin'])[0].toLowerCase();
  const inName = 'input' + ext;
  const handler = ({ progress }) => onProgress && onProgress(Math.min(Math.max(progress, 0), 1));
  f.on('progress', handler);
  try {
    await f.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    const code = await f.exec(['-i', inName, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', 'output.wav']);
    if (code !== 0) throw new Error('ffmpeg could not read this file. It may have no audio track or an unusual format.');
    const data = await f.readFile('output.wav');
    return new Blob([data.buffer], { type: 'audio/wav' });
  } finally {
    f.off('progress', handler);
    try { await f.deleteFile(inName); await f.deleteFile('output.wav'); } catch (e) { /* ignore */ }
  }
}

function wavToFloat32(buf) {
  const v = new DataView(buf);
  let p = 12;
  while (p + 8 <= v.byteLength) {
    const id = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    const size = v.getUint32(p + 4, true);
    if (id === 'data') {
      const n = Math.min(size, v.byteLength - p - 8) >> 1;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = v.getInt16(p + 8 + i * 2, true) / 32768;
      return out;
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('Could not read the converted audio.');
}

// ---------- small UI helpers ----------
function setBar(n, pct) {
  const bar = $('bar' + n);
  bar.style.display = 'block';
  bar.firstElementChild.style.width = Math.round(pct * 100) + '%';
}
function setStatus(n, text, isErr) {
  const s = $('st' + n);
  s.textContent = text;
  s.className = isErr ? 'err' : 'status';
}
function wire(zoneId, inputId, nameId, onFile) {
  const zone = $(zoneId), input = $(inputId);
  const take = (f) => { if (!f) return; $(nameId).textContent = `${f.name} (${mb(f.size)})`; onFile(f); };
  input.addEventListener('change', () => take(input.files[0]));
  ['dragenter', 'dragover'].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((e) => zone.addEventListener(e, (ev) => { ev.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (ev) => take(ev.dataTransfer.files[0]));
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Step 1 ----------
let videoFile = null;
wire('zone1', 'file1', 'name1', (f) => { videoFile = f; $('go1').disabled = false; });
$('go1').onclick = async () => {
  if (!videoFile) return;
  $('go1').disabled = true;
  $('res1').style.display = 'none';
  if (videoFile.size > 1.5 * 1073741824) {
    setStatus(1, 'This file is over 1.5 GB, which is too large for a browser. Use the Mac or PC app for files this big.', true);
    $('go1').disabled = false; return;
  }
  try {
    setStatus(1, 'Loading the converter (about 30 MB the first time)...');
    setBar(1, 0);
    $('cmd1').style.display = 'block';
    $('cmd1').textContent = `The command running behind the scenes:\nffmpeg -i "${videoFile.name}" -vn -ac 1 -ar 16000 -c:a pcm_s16le "${stem(videoFile.name)}.wav"`;
    await getFFmpeg();
    setStatus(1, 'Taking the sound out of the video...');
    const wav = await toWav(videoFile, (p) => setBar(1, p));
    step1Wav = { name: stem(videoFile.name) + '.wav', blob: wav };
    setBar(1, 1);
    setStatus(1, `Finished. Audio file: ${mb(wav.size)}.`);
    $('aud1').src = URL.createObjectURL(wav);
    $('res1').style.display = 'block';
  } catch (e) {
    setStatus(1, e.message || String(e), true);
  }
  $('go1').disabled = false;
};
$('dl1').onclick = () => step1Wav && download(step1Wav.blob, step1Wav.name);
$('use2').onclick = () => {
  if (!step1Wav) return;
  step2File = new File([step1Wav.blob], step1Wav.name, { type: 'audio/wav' });
  $('name2').textContent = `${step1Wav.name} (from Step 1)`;
  $('go2').disabled = false;
  $('zone2').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

// ---------- Step 2 ----------
wire('zone2', 'file2', 'name2', (f) => { step2File = f; $('go2').disabled = false; });
let lastMd = null;

$('go2').onclick = async () => {
  if (!step2File) return;
  const file = step2File;
  $('go2').disabled = true;
  $('res2').style.display = 'none';
  setBar(2, 0);
  const model = $('model').value;
  const wantSpk = $('spk').checked;
  const nspk = parseInt($('nspk').value, 10) || -1;
  try {
    setStatus(2, 'Preparing the audio...');
    const wav = await toWav(file, (p) => setBar(2, p * 0.05));
    const audio = wavToFloat32(await wav.arrayBuffer());
    const duration = audio.length / 16000;
    if (duration > 40 * 60) throw new Error('This recording is longer than 40 minutes, which is too long for the browser version. Use the Mac or PC app, or split the recording.');
    const worker = new Worker('js/worker.js', { type: 'module' });
    const result = await new Promise((resolve, reject) => {
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'status') setStatus(2, m.text);
        else if (m.type === 'download') setBar(2, 0.05 + m.pct * 0.05);
        else if (m.type === 'progress') setBar(2, m.stage === 'spk' ? 0.1 + m.pct * 0.3 : (wantSpk ? 0.4 : 0.1) + m.pct * (wantSpk ? 0.6 : 0.9));
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The worker stopped unexpectedly.'));
      worker.postMessage({ audio, model, speakers: wantSpk, numSpeakers: nspk, cpu: new URLSearchParams(location.search).has('cpu'), threshold: parseFloat(new URLSearchParams(location.search).get('th')) || 0 }, [audio.buffer]);
    });
    worker.terminate();
    lastMd = { name: stem(file.name) + '.md', text: buildMarkdown({
      sourceName: file.name, duration, model, segments: result.segments }) };
    setBar(2, 1);
    setStatus(2, `Finished (${result.usedGPU ? 'graphics acceleration used' : 'standard mode'}).`);
    $('md').textContent = lastMd.text;
    $('res2').style.display = 'block';
  } catch (e) {
    setStatus(2, e.message || String(e), true);
  }
  $('go2').disabled = false;
};
$('dl2').onclick = () => lastMd && download(new Blob([lastMd.text], { type: 'text/markdown' }), lastMd.name);
$('copy2').onclick = async () => {
  if (!lastMd) return;
  await navigator.clipboard.writeText(lastMd.text);
  $('copy2').textContent = 'Copied';
  setTimeout(() => { $('copy2').textContent = 'Copy to clipboard'; }, 1500);
};

$('gpu').textContent = navigator.gpu
  ? 'This browser supports graphics acceleration, so transcribing will be faster.'
  : 'This browser does not support graphics acceleration. It still works, but transcribing will be slower. Chrome or Edge on a recent PC is best.';
