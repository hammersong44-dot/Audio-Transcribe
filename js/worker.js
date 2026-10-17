// Runs speech detection, speaker identification and speech recognition off the main thread.
// Everything happens in this browser tab. Audio is never uploaded; only the model files are downloaded.
//
// Plan: (1) find the stretches where someone is talking, (2) optionally learn each voice and group
// the stretches by speaker, (3) write out the words of each stretch with Whisper.
import {
  pipeline, env, AutoProcessor, AutoModel, AutoModelForAudioFrameClassification,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';

env.allowLocalModels = false;

const SR = 16000;
const post = (m) => self.postMessage(m);
let hasGPU = typeof navigator !== 'undefined' && !!navigator.gpu;

const download = (p) => { if (p.status === 'progress') post({ type: 'download', file: p.file, pct: p.progress / 100 }); };

// ---------- 1. Where is someone talking? ----------
async function findUtterances(audio) {
  post({ type: 'status', text: 'Loading the speech-detection model...' });
  const model = await AutoModelForAudioFrameClassification.from_pretrained('onnx-community/pyannote-segmentation-3.0', { dtype: 'q8', progress_callback: download });
  const proc = await AutoProcessor.from_pretrained('onnx-community/pyannote-segmentation-3.0');
  post({ type: 'status', text: 'Finding the stretches where someone is talking...' });
  const inputs = await proc(audio);
  const { logits } = await model(inputs);
  const raw = proc.post_process_speaker_diarization(logits, audio.length)[0];
  const spans = raw.filter((s) => s.id !== 0).map((s) => ({ start: s.start, end: s.end, id: s.id }));
  spans.sort((a, b) => a.start - b.start);

  // Join neighbours that are the same voice with a short gap; fold very short bits into the previous one.
  const utt = [];
  for (const s of spans) {
    const last = utt[utt.length - 1];
    const gap = last ? s.start - last.end : Infinity;
    const sameVoiceClose = last && gap < 0.5 && s.id === last.id;
    const tinyBit = last && gap < 1.0 && (s.end - s.start) < 1.0;
    if ((sameVoiceClose || tinyBit) && (Math.max(s.end, last.end) - last.start) <= 20) {
      last.end = Math.max(last.end, s.end);
    } else {
      utt.push({ start: s.start, end: s.end, id: s.id });
    }
  }
  // Split anything longer than 20 seconds, and drop slivers shorter than 0.4 seconds.
  const out = [];
  for (const u of utt) {
    for (let t = u.start; t < u.end; t += 20) {
      const e = Math.min(t + 20, u.end);
      if (e - t >= 0.4) out.push({ start: t, end: e });
    }
  }
  return out;
}

// ---------- 2. Which voice is it? ----------
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

const mergeLog = [];
function cluster(embs, numSpeakers, threshold) {
  // Average-linkage agglomerative clustering on cosine similarity.
  const groups = embs.map((_, i) => [i]);
  const sim = (g1, g2) => {
    let s = 0;
    for (const i of g1) for (const j of g2) s += cosine(embs[i], embs[j]);
    return s / (g1.length * g2.length);
  };
  for (;;) {
    if (groups.length <= 1) break;
    if (numSpeakers > 0 && groups.length <= numSpeakers) break;
    let best = -2, bi = 0, bj = 1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const s = sim(groups[i], groups[j]);
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    mergeLog.push(Math.round(best * 100) / 100);
    if (numSpeakers <= 0 && best < threshold) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  // Number speakers by who talks first.
  const label = new Array(embs.length);
  groups.sort((a, b) => Math.min(...a) - Math.min(...b)).forEach((g, k) => g.forEach((i) => { label[i] = k; }));
  return label;
}

async function labelSpeakers(audio, utts, numSpeakers, threshold) {
  post({ type: 'status', text: 'Loading the voice-fingerprint model...' });
  const model = await AutoModel.from_pretrained('onnx-community/wespeaker-voxceleb-resnet34-LM', { dtype: 'fp32', progress_callback: download });
  const proc = await AutoProcessor.from_pretrained('onnx-community/wespeaker-voxceleb-resnet34-LM');
  const embs = [];
  for (let i = 0; i < utts.length; i++) {
    const u = utts[i];
    post({ type: 'status', text: `Learning the voices... (${i + 1} of ${utts.length})` });
    const slice = audio.slice(Math.floor(u.start * SR), Math.floor(Math.min(u.end, u.start + 10) * SR));
    const out = await model(await proc(slice));
    const t = out.embeddings ?? out.embs ?? out.output ?? Object.values(out)[0];
    embs.push(Array.from(t.data));
    post({ type: 'progress', stage: 'spk', pct: (i + 1) / utts.length });
  }
  return cluster(embs, numSpeakers, threshold);
}

// ---------- 3. What was said? ----------
async function loadWhisper(modelName) {
  const id = `Xenova/whisper-${modelName}`;
  post({ type: 'status', text: `Loading the speech model (${modelName}). The first time this downloads about ${modelName === 'small.en' ? '600' : '150'} MB; later it loads from your browser's cache.` });
  const base = { progress_callback: download };
  if (hasGPU) {
    try {
      return await pipeline('automatic-speech-recognition', id, { ...base, device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
    } catch (e) {
      hasGPU = false;
      post({ type: 'status', text: 'Graphics acceleration was not usable; using standard mode (slower).' });
    }
  }
  return pipeline('automatic-speech-recognition', id, { ...base, dtype: 'q8' });
}

self.onmessage = async (ev) => {
  const { audio, model, speakers, numSpeakers, cpu, threshold } = ev.data;
  if (cpu) hasGPU = false;
  try {
    const utts = await findUtterances(audio);
    if (!utts.length) { post({ type: 'done', segments: [], usedGPU: hasGPU }); return; }
    let labels = null;
    if (speakers) labels = await labelSpeakers(audio, utts, numSpeakers, threshold || 0.3);
    const asr = await loadWhisper(model);
    const segments = [];
    for (let i = 0; i < utts.length; i++) {
      const u = utts[i];
      post({ type: 'status', text: `Writing the words... (${i + 1} of ${utts.length})` });
      const clip = audio.slice(Math.floor(u.start * SR), Math.floor(u.end * SR));
      const r = await asr(clip);
      const text = (r.text || '').trim();
      const noise = /^[\[(*].*[\])*]$/.test(text) || /^[.\s]*$/.test(text);
      if (text && !noise) segments.push({ start: u.start, end: u.end, text, speaker: labels ? labels[i] : undefined });
      post({ type: 'progress', stage: 'asr', pct: (i + 1) / utts.length });
    }
    post({ type: 'done', segments, usedGPU: hasGPU, mergeLog, nUtts: utts.length });
  } catch (e) {
    post({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
};
