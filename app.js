// ─────────────────────────────────────────────────────────
// LensForge — static camera timeline editor
// Outputs a compact base36 code to paste into any negative
// prompt field as: blurry, noise [LF1:xxxxxxxxxxxx]
// ─────────────────────────────────────────────────────────

// ── Encoding tables (must match lensforge_node/nodes.py) ─

const _B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const RESOLUTIONS = ['848x480','1280x720','640x480','480x848','720x1280'];
const FPS_OPTIONS = [8, 12, 16, 24, 25, 30];
const MOTION_TYPES = [
  { id:'static',    label:'STATIC',    icon:'◼', color:'#4a4a4a', unit:'none'   },
  { id:'pan_left',  label:'PAN ←',     icon:'←', color:'#1a6b3c', unit:'deg',  max:30  },
  { id:'pan_right', label:'PAN →',     icon:'→', color:'#1a6b3c', unit:'deg',  max:30  },
  { id:'tilt_up',   label:'TILT ↑',    icon:'↑', color:'#1a3d6b', unit:'deg',  max:20  },
  { id:'tilt_down', label:'TILT ↓',    icon:'↓', color:'#1a3d6b', unit:'deg',  max:20  },
  { id:'zoom_in',   label:'ZOOM +',    icon:'⊕', color:'#6b3d1a', unit:'pct'          },
  { id:'zoom_out',  label:'ZOOM −',    icon:'⊖', color:'#6b3d1a', unit:'pct'          },
  { id:'dolly_fwd', label:'DOLLY FWD', icon:'▶', color:'#5a1a6b', unit:'pct'          },
  { id:'dolly_bwd', label:'DOLLY BWD', icon:'◀', color:'#5a1a6b', unit:'pct'          },
  { id:'crane_up',  label:'CRANE ↑',   icon:'⬆', color:'#1a5a5a', unit:'pct'          },
  { id:'crane_down',label:'CRANE ↓',   icon:'⬇', color:'#1a5a5a', unit:'pct'          },
  { id:'orbit_cw',  label:'ORBIT ↻',   icon:'↻', color:'#6b5a1a', unit:'deg',  max:60  },
  { id:'orbit_ccw', label:'ORBIT ↺',   icon:'↺', color:'#6b5a1a', unit:'deg',  max:60  },
];

function formatSpeed(motionId, speed) {
  const def = motionDef(motionId);
  if (def.unit === 'none') return '—';
  if (def.unit === 'deg')  return `${Math.round(speed * def.max)}°`;
  return `${Math.round(speed * 100)}%`;
}

function speedLabel(motionId) {
  const def = motionDef(motionId);
  if (def.unit === 'none') return null;
  if (def.unit === 'deg')  return `max ${def.max}° travel`;
  return 'intensity';
}

function enc(n, w) {
  let s = '';
  for (let i = 0; i < w; i++) { s = _B36[n % 36] + s; n = Math.floor(n / 36); }
  return s;
}

function encodeShot(frames, fps, resolution, keyframes) {
  const fpsIdx = FPS_OPTIONS.indexOf(fps);
  const resIdx = RESOLUTIONS.indexOf(resolution);
  let code = 'LF1:' + enc(frames, 2) + enc(fpsIdx < 0 ? 2 : fpsIdx, 1) + enc(resIdx < 0 ? 0 : resIdx, 1);
  for (const kf of keyframes) {
    const mIdx = MOTION_TYPES.findIndex(m => m.id === kf.motion);
    const sEnc = Math.round(kf.speed * 35);
    code += enc(kf.start, 2) + enc(kf.end, 2) + enc(mIdx < 0 ? 0 : mIdx, 1) + enc(sEnc, 1);
  }
  return code;
}

// ── State ─────────────────────────────────────────────────

let keyframes   = [{ id: uid(), start: 0, end: 81, motion: 'static', speed: 0.0 }];
let selectedId  = null;
let totalFrames = 81;
let dragState   = null;

// ── DOM ───────────────────────────────────────────────────

const trackEl      = document.getElementById('timeline-track');
const ghostEl      = document.getElementById('timeline-ghost');
const rulerCanvas  = document.getElementById('ruler-canvas');
const inspectorEl  = document.getElementById('inspector-content');
const inspEmpty    = document.getElementById('inspector-empty');
const motionGrid   = document.getElementById('motion-grid');
const speedRange   = document.getElementById('speed-range');
const speedVal     = document.getElementById('speed-val');
const delBtn       = document.getElementById('kf-delete-btn');
const codeBox      = document.getElementById('code-box');
const copyBtn      = document.getElementById('copy-btn');
const telegramBox  = document.getElementById('telegram-box');
const telegramBtn  = document.getElementById('telegram-btn');
const slugEl       = document.getElementById('workflow-slug');
const statusMsg    = document.getElementById('status-msg');
const framesEl     = document.getElementById('frames-count');
const fpsEl        = document.getElementById('fps-val');
const resEl        = document.getElementById('resolution-val');

// ── Utilities ─────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 9); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function frameToX(f, w) { return (f / totalFrames) * w; }
function xToFrame(x, w) { return Math.round(clamp(x / w * totalFrames, 0, totalFrames)); }
function motionDef(id) { return MOTION_TYPES.find(m => m.id === id) || MOTION_TYPES[0]; }
function setStatus(state, msg) { statusMsg.dataset.state = state; statusMsg.textContent = msg; }

// ── Ruler ─────────────────────────────────────────────────

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
  ctx.font        = '9px Courier New';
  const candidates = [1,2,4,5,8,10,16,20,25,40,50];
  const pxPerFrame = rect.width / totalFrames;
  const interval   = candidates.find(c => c * pxPerFrame >= 48) || 50;
  for (let f = 0; f <= totalFrames; f += interval) {
    const x = frameToX(f, rect.width);
    ctx.beginPath(); ctx.moveTo(x, rect.height - 6); ctx.lineTo(x, rect.height); ctx.stroke();
    ctx.fillText(f, x + 2, rect.height - 8);
  }
}

// ── Timeline ──────────────────────────────────────────────

function renderTimeline() {
  trackEl.querySelectorAll('.kf-segment').forEach(el => el.remove());
  const w = trackEl.clientWidth;
  for (const kf of keyframes) {
    const def  = motionDef(kf.motion);
    const x1   = frameToX(kf.start, w);
    const segW = Math.max(6, frameToX(kf.end, w) - x1);
    const seg  = document.createElement('div');
    seg.className = 'kf-segment' + (kf.id === selectedId ? ' selected' : '');
    seg.style.cssText = `left:${x1}px;width:${segW}px;background:${def.color}`;
    seg.dataset.id = kf.id;
    const lbl = document.createElement('div');
    lbl.className = 'kf-label';
    lbl.textContent = segW > 30 ? def.label : def.icon;
    seg.appendChild(lbl);
    ['left','right'].forEach(side => {
      const h = document.createElement('div');
      h.className = `kf-handle ${side}`;
      h.dataset.handle = side; h.dataset.id = kf.id;
      seg.appendChild(h);
    });
    trackEl.appendChild(seg);
  }
  drawRuler();
  updateCode();
}

// ── Inspector ─────────────────────────────────────────────

function renderInspector() {
  const kf = keyframes.find(k => k.id === selectedId);
  if (!kf) {
    inspectorEl.classList.remove('visible');
    inspEmpty.style.display = '';
    return;
  }
  inspEmpty.style.display = 'none';
  inspectorEl.classList.add('visible');
  motionGrid.querySelectorAll('.motion-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.motion === kf.motion));

  const isStatic = kf.motion === 'static';
  speedRange.value        = kf.speed;
  speedVal.textContent    = formatSpeed(kf.motion, kf.speed);
  speedRange.disabled     = isStatic;
  speedRange.style.opacity = isStatic ? '0.25' : '1';

  // Update the speed row label to show units
  const lbl = document.getElementById('speed-unit-label');
  if (lbl) lbl.textContent = speedLabel(kf.motion) || '';
}

// ── Motion grid ───────────────────────────────────────────

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
    renderTimeline(); renderInspector();
  });
  motionGrid.appendChild(btn);
});

speedRange.addEventListener('input', () => {
  const kf = keyframes.find(k => k.id === selectedId);
  if (!kf) return;
  kf.speed = parseFloat(speedRange.value);
  speedVal.textContent = formatSpeed(kf.motion, kf.speed);
  updateCode();
});

delBtn.addEventListener('click', () => {
  keyframes = keyframes.filter(k => k.id !== selectedId);
  selectedId = null;
  renderTimeline(); renderInspector();
});

// ── Drag ──────────────────────────────────────────────────

trackEl.addEventListener('mousedown', e => {
  const w = trackEl.clientWidth;
  const rect = trackEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const handleEl = e.target.closest('[data-handle]');
  const segEl    = e.target.closest('.kf-segment');

  if (handleEl) {
    e.preventDefault();
    const kf = keyframes.find(k => k.id === handleEl.dataset.id);
    if (!kf) return;
    selectedId = kf.id;
    dragState = { type: handleEl.dataset.handle === 'left' ? 'resize-left' : 'resize-right',
                  id: kf.id, startX: e.clientX, origStart: kf.start, origEnd: kf.end };
    renderTimeline(); renderInspector(); return;
  }
  if (segEl) {
    e.preventDefault();
    const kf = keyframes.find(k => k.id === segEl.dataset.id);
    if (!kf) return;
    selectedId = kf.id;
    dragState = { type: 'move', id: kf.id, startX: e.clientX, origStart: kf.start, origEnd: kf.end };
    renderTimeline(); renderInspector(); return;
  }
  e.preventDefault();
  dragState = { type: 'create', createStart: xToFrame(x, w), startX: e.clientX };
  ghostEl.style.display = 'block';
  selectedId = null; renderInspector();
});

document.addEventListener('mousemove', e => {
  if (!dragState) {
    if (e.target === trackEl) {
      const rect = trackEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const gx = frameToX(xToFrame(x, trackEl.clientWidth), trackEl.clientWidth);
      ghostEl.style.cssText = `display:block;left:${Math.max(0,gx-2)}px;width:4px`;
    } else { ghostEl.style.display = 'none'; }
    return;
  }
  const w = trackEl.clientWidth;
  const dF = Math.round((e.clientX - dragState.startX) / w * totalFrames);

  if (dragState.type === 'move') {
    const kf = keyframes.find(k => k.id === dragState.id); if (!kf) return;
    const span = dragState.origEnd - dragState.origStart;
    kf.start = clamp(dragState.origStart + dF, 0, totalFrames - span);
    kf.end   = kf.start + span;
    renderTimeline();
  } else if (dragState.type === 'resize-left') {
    const kf = keyframes.find(k => k.id === dragState.id); if (!kf) return;
    kf.start = clamp(dragState.origStart + dF, 0, kf.end - 1);
    renderTimeline();
  } else if (dragState.type === 'resize-right') {
    const kf = keyframes.find(k => k.id === dragState.id); if (!kf) return;
    kf.end = clamp(dragState.origEnd + dF, kf.start + 1, totalFrames);
    renderTimeline();
  } else if (dragState.type === 'create') {
    const rect = trackEl.getBoundingClientRect();
    const endF = xToFrame(e.clientX - rect.left, w);
    const s = Math.min(dragState.createStart, endF);
    const en = Math.max(dragState.createStart, endF);
    const x1 = frameToX(s, w), x2 = frameToX(en, w);
    ghostEl.style.cssText = `display:block;left:${x1}px;width:${Math.max(4, x2-x1)}px`;
  }
});

document.addEventListener('mouseup', e => {
  if (!dragState) return;
  if (dragState.type === 'create') {
    const w = trackEl.clientWidth;
    const rect = trackEl.getBoundingClientRect();
    const endF = xToFrame(e.clientX - rect.left, w);
    const s = Math.min(dragState.createStart, endF);
    const en = Math.max(dragState.createStart, endF);
    if (en - s >= 2) {
      const nkf = { id: uid(), start: s, end: en, motion: 'pan_left', speed: 0.5 };
      keyframes.push(nkf);
      selectedId = nkf.id;
      renderTimeline(); renderInspector();
    }
  }
  ghostEl.style.display = 'none';
  dragState = null;
});

trackEl.addEventListener('mouseleave', () => { if (!dragState) ghostEl.style.display = 'none'; });

// ── Touch support (mirrors mouse handlers) ────────────────

function clientXY(e) {
  return e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
}

trackEl.addEventListener('touchstart', e => {
  e.preventDefault();
  const touch = clientXY(e);
  trackEl.dispatchEvent(new MouseEvent('mousedown', { clientX: touch.clientX, clientY: touch.clientY, bubbles: true }));
}, { passive: false });

document.addEventListener('touchmove', e => {
  if (!dragState) return;
  e.preventDefault();
  const touch = clientXY(e);
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: touch.clientX, clientY: touch.clientY, bubbles: true }));
}, { passive: false });

document.addEventListener('touchend', e => {
  if (!dragState) return;
  const touch = clientXY(e);
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: touch.clientX, clientY: touch.clientY, bubbles: true }));
});

// ── Code output ───────────────────────────────────────────

function updateCode() {
  const fps  = parseInt(fpsEl.value) || 16;
  const res  = resEl.value || '848x480';
  const slug = slugEl.value.trim() || 'camera-dictator';
  const code = encodeShot(totalFrames, fps, res, keyframes);

  codeBox.value     = `[${code}]`;
  telegramBox.value = `/wf /run:${slug} /fps:${fps} /length:${totalFrames} /size:${res} [${code}]`;
}

async function copyText(text, btn, label, statusMsg) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  btn.textContent = '✓ COPIED';
  setStatus('ok', statusMsg);
  setTimeout(() => { btn.textContent = label; }, 2000);
}

copyBtn.addEventListener('click', () =>
  copyText(codeBox.value, copyBtn, 'COPY', 'camera code copied — paste into negative prompt'));

telegramBtn.addEventListener('click', () =>
  copyText(telegramBox.value, telegramBtn, 'TELEGRAM', 'telegram string copied — paste into @GraydientBot then add your prompt'));

// ── Header inputs ─────────────────────────────────────────

framesEl.addEventListener('change', () => {
  totalFrames = parseInt(framesEl.value) || 81;
  keyframes.forEach(kf => {
    kf.end   = clamp(kf.end,   kf.start + 1, totalFrames);
    kf.start = clamp(kf.start, 0, kf.end - 1);
  });
  renderTimeline();
});

[fpsEl, resEl, slugEl].forEach(el => el.addEventListener('change', updateCode));
slugEl.addEventListener('input', updateCode);

// ── Resize observer ───────────────────────────────────────

new ResizeObserver(() => renderTimeline()).observe(trackEl);
new ResizeObserver(() => drawRuler()).observe(rulerCanvas.parentElement);

// ── Boot ──────────────────────────────────────────────────

totalFrames = parseInt(framesEl.value) || 81;
renderTimeline();
renderInspector();
updateCode();
setStatus('', 'LENSFORGE — draw shot · copy code · paste into negative prompt');
