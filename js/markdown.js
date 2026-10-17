// Builds the Markdown transcript, with optional speaker labels.
export function fmt(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function buildMarkdown({ sourceName, duration, model, segments }) {
  // Each segment already carries a speaker number (or none, if speaker labels were turned off).
  const labels = new Map();
  for (const s of segments) {
    if (s.speaker !== undefined && !labels.has(s.speaker)) labels.set(s.speaker, `Speaker ${labels.size + 1}`);
  }
  const stem = sourceName.replace(/\.[^.]+$/, '');
  const L = [
    '---',
    `source: "${sourceName}"`,
    `duration: ${fmt(duration)}`,
    `model: whisper ${model} (run in the browser)`,
    `generated: ${new Date().toISOString().slice(0, 10)}`,
    'status: machine-generated, unverified',
  ];
  if (labels.size) {
    L.push('speakers:');
    for (const name of labels.values()) L.push(`  - "${name}; name: unknown"`);
  }
  L.push('---', '', `# Transcript: ${stem}`, '',
    '> Machine-generated transcript. Speaker labels are automatic guesses from voice sound, not identities; ' +
    'they can be wrong, especially on phone-quality audio or overlapping speech. Verify against the recording ' +
    'before relying on or quoting it.', '');
  if (labels.size) {
    L.push('Speakers (find and replace the labels below with names once known):', '');
    for (const name of labels.values()) L.push(`- ${name}`);
    L.push('');
  }
  if (!segments.length) L.push('*No speech detected in this recording.*', '');
  let cur = null, buf = [], t0 = 0;
  const flush = () => {
    if (buf.length) { L.push(`**${cur}** [${fmt(t0)}]: ${buf.join(' ')}`, ''); }
    buf = [];
  };
  for (const s of segments) {
    if (labels.size) {
      const name = labels.get(s.speaker) || 'Unidentified';
      if (name !== cur) { flush(); cur = name; t0 = s.start; }
      buf.push(s.text);
    } else {
      L.push(`**[${fmt(s.start)}]** ${s.text}`, '');
    }
  }
  if (labels.size) flush();
  return L.join('\n');
}
