// ─────────────────────────────────────────────────────────
// LensForge — Camera Timeline Editor
// ─────────────────────────────────────────────────────────

const MOTION_TYPES = [
  { id: 'static',    label: 'STATIC',    icon: '◼',  color: '#4a4a4a' },
  { id: 'pan_left',  label: 'PAN ←',     icon: '←',  color: '#1a6b3c' },
  { id: 'pan_right', label: 'PAN →',     icon: '→',  color: '#1a6b3c' },
  { id: 'tilt_up',   label: 'TILT ↑',    icon: '↑',  color: '#1a3d6b' },
  { id: 'tilt_down', label: 'TILT ↓',    icon: '↓',  color: '#1a3d6b' },
  { id: 'zoom_in',   label: 'ZOOM +',    icon: '⊕',  color: '#6b3d1a' },
  { id: 'zoom_out',  label: 'ZOOM −',    icon: '⊖',  color: '#6b3d1a' },
  { id: 'dolly_fwd', label: 'DOLLY FWD', icon: '▶',  color: '#5a1a6b' },
  { id: 'dolly_bwd', label: 'DOLLY BWD', icon: '◀',  color: '#5a1a6b' },
  { id: 'crane_up',  label: 'CRANE ↑',   icon: '⬆',  color: '#1a5a5a' },
  { id: 'crane_dn',  label: 'CRANE ↓',   icon: '⬇',  color: '#1a5a5a' },
  { id: 'orbit_cw',  label: 'ORBIT ↻',   icon: '↻',  color: '#6b5a1a' },
  { id: 'orbit_ccw', label: 'ORBIT ↺',   icon: '↺',  color: '#6b5a1a' },
];

// Map display id back to compiler motion string
const MOTION_ID_MAP = {
  static: 'static', pan_left: 'pan_left', pan_right: 'pan_right',
  tilt_up: 'tilt_up', tilt_down: 'tilt_down',
  zoom_in: 'zoom_in', zoom_out: 'zoom_out',
  dolly_fwd: 'dolly_fwd', dolly_bwd: 'dolly_bwd',
  crane_up: 'crane_up', crane_dn: 'crane_down',
  orbit_cw: 'orbit_cw', orbit_ccw: 'orbit_ccw',
};

// ─────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────

let keyframes = [
  { id: uid(), start: 0, end: 81, motion: 'static', speed: 0.0 },
];
let selectedId  = null;
let totalFrames = 81;

// Drag state
let dragState = null;
// { type: 'move'|'resize-left'|'resize-right'|'create',
//   id, startX, origStart, origEnd, createStart }

// ─────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────

const trackEl       = document.getElementById('timeline-track');
const ghostEl       = document.getElementById('timeline-ghost');
const rulerCanvas   = document.getElementById('ruler-canvas');
const inspectorEl   = document.getElementById('inspector-content');
const inspectorEmpty= document.getElementById('inspector-empty');
const motionGrid    = document.getElementById('motion-grid');
const speedRange    = document.getElementById('speed-range');
const speedVal      = document.getElementById('speed-val');
const delBtn        = document.getElementById('kf-delete-btn');
const sceneDocPre   = document.getElementById('scene-doc-pre');
const statusMsg     = document.getElementById('status-msg');
const renderBtn     = document.getElementById('btn-render');
const promptPos     = document.getElementById('prompt-positive');
const promptNeg     = document.getElementById('prompt-negative');
const frameCountEl  = document.getElementById('frames-count');
const fpsEl         = document.getElementById('fps-val');
const resEl         = document.getElementById('resolution-val');
const seedEl        = document.getElementById('seed-val');
const nameEl        = document.getElementById('shot-name');

// ─────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function frameToX(frame, trackWidth) {
  return (frame / totalFrames) * trackWidth;
}

function xToFrame(x, trackWidth) {
  return Math.round(clamp(x / trackWidth * totalFrames, 0, totalFrames));
}

function motionDef(id) {
  return MOTION_TYPES.find(m => m.id === id) || MOTION_TYPES[0];
}

function setStatus(state, msg) {
  statusMsg.dataset.state = state;
  statusMsg.textContent = msg;
}

// ─────────────────────────────────────────────────────────
// Frame ruler (Canvas)
// ─────────────────────────────────────────────────────────

function drawRuler() {
  const canvas = rulerCanvas;
  const dpr    = window.devicePixelRatio || 1;
  const rect   = canvas.parentElement.getBoundingClientRect();
  canvas.width  = rect.width  * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width  = rect.width  + 'px';
  canvas.style.height = rect.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = 'rgba(0,255,65,0.3)';
  ctx.fillStyle   = 'rgba(200,255,212,0.45)';
  ctx.font        = `9px Courier New`;

  // Pick tick interval that gives ~60-80px per tick
  const candidates = [1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50];
  const pixPerFrame = rect.width / totalFrames;
  let interval = candidates.find(c => c * pixPerFrame >= 48) || 50;

  for (let f = 0; f <= totalFrames; f += interval) {
    const x = frameToX(f, rect.width);
    ctx.beginPath();
    ctx.moveTo(x, rect.height - 6);
    ctx.lineTo(x, rect.height);
    ctx.stroke();
    ctx.fillText(f, x + 2, rect.height - 6);
  }
}

// ─────────────────────────────────────────────────────────
// Timeline rendering
// ─────────────────────────────────────────────────────────

function renderTimeline() {
  // Remove old segments (keep ghost)
  trackEl.querySelectorAll('.kf-segment').forEach(el => el.remove());

  const w = trackEl.clientWidth;

  for (const kf of keyframes) {
    const def  = motionDef(kf.motion);
    const x1   = frameToX(kf.start, w);
    const x2   = frameToX(kf.end,   w);
    const segW = Math.max(6, x2 - x1);

    const seg = document.createElement('div');
    seg.className = 'kf-segment' + (kf.id === selectedId ? ' selected' : '');
    seg.style.left       = x1 + 'px';
    seg.style.width      = segW + 'px';
    seg.style.background = def.color;
    seg.dataset.id       = kf.id;

    const label = document.createElement('div');
    label.className = 'kf-label';
    label.textContent = segW > 30 ? def.label : def.icon;
    seg.appendChild(label);

    const handleL = document.createElement('div');
    handleL.className = 'kf-handle left';
    handleL.dataset.handle = 'left';
    handleL.dataset.id     = kf.id;
    seg.appendChild(handleL);

    const handleR = document.createElement('div');
    handleR.className = 'kf-handle right';
    handleR.dataset.handle = 'right';
    handleR.dataset.id     = kf.id;
    seg.appendChild(handleR);

    trackEl.appendChild(seg);
  }

  drawRuler();
  updateSceneDoc();
}

// ─────────────────────────────────────────────────────────
// Inspector
// ─────────────────────────────────────────────────────────

function renderInspector() {
  const kf = keyframes.find(k => k.id === selectedId);
  if (!kf) {
    inspectorEl.classList.remove('visible');
    inspectorEmpty.style.display = '';
    return;
  }
  inspectorEmpty.style.display = 'none';
  inspectorEl.classList.add('visible');

  // Update motion grid
  motionGrid.querySelectorAll('.motion-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.motion === kf.motion);
  });

  speedRange.value = kf.speed;
  speedVal.textContent = kf.speed.toFixed(2);
}

// ─────────────────────────────────────────────────────────
// Motion grid (built once)
// ─────────────────────────────────────────────────────────

MOTION_TYPES.forEach(def => {
  const btn = document.createElement('button');
  btn.className = 'motion-btn';
  btn.dataset.motion = def.id;
  btn.title = def.label;
  btn.innerHTML = `<div style="font-size:13px">${def.icon}</div><div>${def.label}</div>`;
  btn.addEventListener('click', () => {
    const kf = keyframes.find(k => k.id === selectedId);
    if (!kf) return;
    kf.motion = def.id;
    renderTimeline();
    renderInspector();
  });
  motionGrid.appendChild(btn);
});

speedRange.addEventListener('input', () => {
  const kf = keyframes.find(k => k.id === selectedId);
  if (!kf) return;
  kf.speed = parseFloat(speedRange.value);
  speedVal.textContent = kf.speed.toFixed(2);
  updateSceneDoc();
});

delBtn.addEventListener('click', () => {
  keyframes = keyframes.filter(k => k.id !== selectedId);
  selectedId = null;
  renderTimeline();
  renderInspector();
});

// ─────────────────────────────────────────────────────────
// Drag interactions
// ─────────────────────────────────────────────────────────

trackEl.addEventListener('mousedown', e => {
  const w = trackEl.clientWidth;
  const rect = trackEl.getBoundingClientRect();
  const x = e.clientX - rect.left;

  // Check if clicking a handle or segment
  const handleEl = e.target.closest('[data-handle]');
  const segEl    = e.target.closest('.kf-segment');

  if (handleEl) {
    e.preventDefault();
    const id = handleEl.dataset.id;
    const kf = keyframes.find(k => k.id === id);
    if (!kf) return;
    selectedId = id;
    dragState = {
      type: handleEl.dataset.handle === 'left' ? 'resize-left' : 'resize-right',
      id, startX: e.clientX, origStart: kf.start, origEnd: kf.end,
    };
    renderTimeline();
    renderInspector();
    return;
  }

  if (segEl) {
    e.preventDefault();
    const id = segEl.dataset.id;
    const kf = keyframes.find(k => k.id === id);
    if (!kf) return;
    selectedId = id;
    dragState = {
      type: 'move',
      id, startX: e.clientX, origStart: kf.start, origEnd: kf.end,
    };
    renderTimeline();
    renderInspector();
    return;
  }

  // Click on empty space → start new segment creation
  e.preventDefault();
  const frame = xToFrame(x, w);
  dragState = { type: 'create', createStart: frame, startX: e.clientX };
  ghostEl.style.display = 'block';
  selectedId = null;
  renderInspector();
});

document.addEventListener('mousemove', e => {
  if (!dragState) {
    // Show ghost on hover over empty track
    const rect = trackEl.getBoundingClientRect();
    if (e.target === trackEl) {
      const x     = e.clientX - rect.left;
      const w     = trackEl.clientWidth;
      const frame = xToFrame(x, w);
      const gx    = frameToX(frame, w);
      ghostEl.style.left  = Math.max(0, gx - 2) + 'px';
      ghostEl.style.width = '4px';
      ghostEl.style.display = 'block';
    } else {
      ghostEl.style.display = 'none';
    }
    return;
  }

  const w    = trackEl.clientWidth;
  const dx   = e.clientX - dragState.startX;
  const dFrames = Math.round(dx / w * totalFrames);

  if (dragState.type === 'move') {
    const kf = keyframes.find(k => k.id === dragState.id);
    if (!kf) return;
    const span = dragState.origEnd - dragState.origStart;
    let ns = clamp(dragState.origStart + dFrames, 0, totalFrames - span);
    kf.start = ns;
    kf.end   = ns + span;
    renderTimeline();

  } else if (dragState.type === 'resize-left') {
    const kf = keyframes.find(k => k.id === dragState.id);
    if (!kf) return;
    kf.start = clamp(dragState.origStart + dFrames, 0, kf.end - 1);
    renderTimeline();

  } else if (dragState.type === 'resize-right') {
    const kf = keyframes.find(k => k.id === dragState.id);
    if (!kf) return;
    kf.end = clamp(dragState.origEnd + dFrames, kf.start + 1, totalFrames);
    renderTimeline();

  } else if (dragState.type === 'create') {
    const rect = trackEl.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const endFrame = xToFrame(x, w);
    const s = Math.min(dragState.createStart, endFrame);
    const en = Math.max(dragState.createStart, endFrame);
    const x1 = frameToX(s, w);
    const x2 = frameToX(en, w);
    ghostEl.style.left  = x1 + 'px';
    ghostEl.style.width = Math.max(4, x2 - x1) + 'px';
    ghostEl.style.display = 'block';
  }
});

document.addEventListener('mouseup', e => {
  if (!dragState) return;

  if (dragState.type === 'create') {
    const w    = trackEl.clientWidth;
    const rect = trackEl.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const endFrame = xToFrame(x, w);
    const s  = Math.min(dragState.createStart, endFrame);
    const en = Math.max(dragState.createStart, endFrame);

    if (en - s >= 2) {
      const newKf = { id: uid(), start: s, end: en, motion: 'pan_left', speed: 0.5 };
      keyframes.push(newKf);
      selectedId = newKf.id;
      renderTimeline();
      renderInspector();
    }
  }

  ghostEl.style.display = 'none';
  dragState = null;
});

trackEl.addEventListener('mouseleave', () => {
  if (!dragState) ghostEl.style.display = 'none';
});

// ─────────────────────────────────────────────────────────
// Scene document
// ─────────────────────────────────────────────────────────

function buildSceneDoc() {
  return {
    version: 1,
    name:   nameEl.value.trim() || 'shot',
    prompt: promptPos.value.trim(),
    negative_prompt: promptNeg.value.trim(),
    frames: parseInt(frameCountEl.value) || 81,
    fps:    parseInt(fpsEl.value) || 16,
    resolution: resEl.value || '848x480',
    seed:   parseInt(seedEl.value) || -1,
    target: 'path_a',
    keyframes: keyframes.map(kf => ({
      start:  kf.start,
      end:    kf.end,
      motion: MOTION_ID_MAP[kf.motion] || kf.motion,
      speed:  Math.round(kf.speed * 100) / 100,
    })),
  };
}

function updateSceneDoc() {
  sceneDocPre.textContent = JSON.stringify(buildSceneDoc(), null, 2);
}

// Update totalFrames when header input changes
frameCountEl.addEventListener('change', () => {
  totalFrames = parseInt(frameCountEl.value) || 81;
  // Clamp all keyframe ends
  keyframes.forEach(kf => {
    kf.end   = clamp(kf.end,   kf.start + 1, totalFrames);
    kf.start = clamp(kf.start, 0, kf.end - 1);
  });
  renderTimeline();
});

[promptPos, promptNeg, fpsEl, resEl, seedEl, nameEl].forEach(el =>
  el.addEventListener('input', updateSceneDoc)
);

// ─────────────────────────────────────────────────────────
// Sidebar tabs
// ─────────────────────────────────────────────────────────

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.pane).classList.add('active');
  });
});

// ─────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────

const activePolls = new Map(); // render_id → intervalId

renderBtn.addEventListener('click', async () => {
  const doc = buildSceneDoc();
  renderBtn.disabled = true;
  setStatus('busy', 'submitting to Graydient…');

  try {
    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(JSON.parse(txt)?.detail ?? txt);
    }
    const result = await res.json();
    const id = result.render_id;

    addResultCard(id, doc.name, doc);
    switchSidebarTo('results-pane');
    setStatus('ok', `queued "${doc.name}" — render id: ${id || '(pending)'}`);

    if (id) startPolling(id);

  } catch (err) {
    setStatus('error', 'render failed: ' + err.message);
  } finally {
    renderBtn.disabled = false;
  }
});

// ── Result cards ─────────────────────────────────────────

const resultsList = document.getElementById('results-list');

function addResultCard(id, name, doc) {
  const card = document.createElement('div');
  card.className = 'result-card';
  card.dataset.renderId = id;
  card.innerHTML = `
    <div class="result-card-header">
      <span class="result-name">${escHtml(name)}</span>
      <span class="result-status" data-state="queued">QUEUED</span>
    </div>
    <div class="result-id">${escHtml(id || '—')}</div>
    <div class="result-motion">${summariseMotion(doc.keyframes)}</div>
    <div class="result-media"></div>
  `;
  resultsList.prepend(card);
  return card;
}

function updateResultCard(id, status, url) {
  const card = resultsList.querySelector(`[data-render-id="${id}"]`);
  if (!card) return;
  const statusEl = card.querySelector('.result-status');
  const mediaEl  = card.querySelector('.result-media');
  statusEl.dataset.state = status;
  statusEl.textContent   = status.toUpperCase();

  if (url && !mediaEl.hasChildNodes()) {
    if (url.match(/\.(mp4|webm)$/i)) {
      mediaEl.innerHTML = `<video src="${escHtml(url)}" controls loop style="width:100%;margin-top:6px;border-radius:2px"></video>`;
    } else {
      mediaEl.innerHTML = `<img src="${escHtml(url)}" style="width:100%;margin-top:6px;border-radius:2px" />`;
    }
  }
}

function summariseMotion(keyframes) {
  if (!keyframes?.length) return '—';
  return keyframes.map(kf => {
    const def = MOTION_TYPES.find(m => m.id === kf.motion) || { icon: '?', label: kf.motion };
    return `${def.icon} ${kf.start}–${kf.end}`;
  }).join('  ');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Polling ──────────────────────────────────────────────

function startPolling(renderId) {
  if (activePolls.has(renderId)) return;
  let attempts = 0;
  const MAX_ATTEMPTS = 120; // ~4 min at 2 s intervals

  const intervalId = setInterval(async () => {
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      clearInterval(intervalId);
      activePolls.delete(renderId);
      updateResultCard(renderId, 'timeout', null);
      return;
    }
    try {
      const res = await fetch(`/render/${renderId}`);
      if (!res.ok) return;
      const data = await res.json();
      const status = data.status ?? 'unknown';
      const url    = data.url ?? null;
      updateResultCard(renderId, status, url);
      if (['done', 'completed', 'failed', 'error'].includes(status)) {
        clearInterval(intervalId);
        activePolls.delete(renderId);
        if (url) setStatus('ok', `render complete — ${renderId}`);
        else     setStatus('error', `render ${status} — ${renderId}`);
      }
    } catch (_) {}
  }, 2000);

  activePolls.set(renderId, intervalId);
}

function switchSidebarTo(paneId) {
  document.querySelectorAll('.sidebar-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.pane === paneId));
  document.querySelectorAll('.sidebar-pane').forEach(p =>
    p.classList.toggle('active', p.id === paneId));
}


// ─────────────────────────────────────────────────────────
// Config pane
// ─────────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch('/config');
    if (!res.ok) return;
    const cfg = await res.json();
    document.getElementById('cfg-api-key').value    = cfg.api_key        ?? '';
    document.getElementById('cfg-slug').value       = cfg.workflow_slug  ?? '';
    document.getElementById('cfg-field-json').value = cfg.field_json     ?? 'lensforge_json';
    document.getElementById('cfg-field-pos').value  = cfg.field_positive ?? 'positive_prompt';
    document.getElementById('cfg-field-neg').value  = cfg.field_negative ?? 'negative_prompt';
    document.getElementById('cfg-field-seed').value = cfg.field_seed     ?? 'seed';
  } catch (_) {}
}

document.getElementById('cfg-save-btn').addEventListener('click', async () => {
  const btn = document.getElementById('cfg-save-btn');
  btn.disabled = true;
  try {
    const body = {
      api_key:        document.getElementById('cfg-api-key').value,
      workflow_slug:  document.getElementById('cfg-slug').value,
      field_json:     document.getElementById('cfg-field-json').value,
      field_positive: document.getElementById('cfg-field-pos').value,
      field_negative: document.getElementById('cfg-field-neg').value,
      field_seed:     document.getElementById('cfg-field-seed').value,
    };
    const res = await fetch('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) setStatus('ok', 'config saved');
    else throw new Error(await res.text());
  } catch (e) {
    setStatus('error', e.message);
  } finally {
    btn.disabled = false;
  }
});

// ─────────────────────────────────────────────────────────
// Resize handling
// ─────────────────────────────────────────────────────────

const ro = new ResizeObserver(() => {
  renderTimeline();
});
ro.observe(trackEl);
ro.observe(rulerCanvas.parentElement);

// ─────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────

loadConfig();
totalFrames = parseInt(frameCountEl.value) || 81;
renderTimeline();
renderInspector();
updateSceneDoc();
setStatus('', 'LENSFORGE v0.1 — Path A ready');
