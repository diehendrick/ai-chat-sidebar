// Screenshot annotation editor.
// Loads the pending capture from chrome.storage.local, lets the user draw on it
// (pen / arrow / rectangle / ellipse / text), then sends the flattened PNG back
// to the side panel, which copies it and focuses the chat for a single Ctrl+V.

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const ctx = canvas.getContext('2d');

let tool = 'pen';
let color = '#6b7cff';
let lineWidth = 5;
let baseImage = null;   // ImageBitmap of the original screenshot
let strokes = [];       // committed annotation ops, replayed for undo/redraw
let draft = null;       // op currently being drawn
let scale = 1;          // CSS px -> image px
let label = 'Screenshot';

/* ------------------------------------------------------------------ loading */

async function loadPending() {
  const { 'annotate.pending': pending } = await chrome.storage.local.get('annotate.pending');
  if (!pending?.dataUrl) {
    document.body.innerHTML = '<p style="padding:24px">No screenshot to annotate.</p>';
    return false;
  }
  label = pending.label ?? 'Screenshot';

  const blob = await (await fetch(pending.dataUrl)).blob();
  baseImage = await createImageBitmap(blob);
  canvas.width = baseImage.width;
  canvas.height = baseImage.height;

  // fit inside the window while keeping the image resolvable
  const maxW = Math.max(320, window.innerWidth - 40);
  const maxH = Math.max(240, window.innerHeight - 140);
  scale = Math.min(1, maxW / canvas.width, maxH / canvas.height);
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;

  redraw();
  return true;
}

/* ------------------------------------------------------------------ drawing */

function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (baseImage) ctx.drawImage(baseImage, 0, 0);
  for (const op of strokes) drawOp(op);
  if (draft) drawOp(draft);
}

function drawOp(op) {
  ctx.save();
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (op.type === 'pen') {
    ctx.beginPath();
    op.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (op.points.length === 1) {
      ctx.arc(op.points[0].x, op.points[0].y, op.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke();
    }
  } else if (op.type === 'rect') {
    ctx.strokeRect(op.x, op.y, op.w, op.h);
  } else if (op.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(op.x + op.w / 2, op.y + op.h / 2, Math.abs(op.w / 2), Math.abs(op.h / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (op.type === 'arrow') {
    const { x1, y1, x2, y2 } = op;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(12, op.width * 3);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  } else if (op.type === 'text') {
    ctx.font = `600 ${Math.max(14, op.width * 4)}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(op.text, op.x, op.y);
  }
  ctx.restore();
}

function pointFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * canvas.width,
    y: ((e.clientY - rect.top) / rect.height) * canvas.height
  };
}

/* ------------------------------------------------------------------ events */

canvas.addEventListener('pointerdown', (e) => {
  if (!baseImage) return;
  canvas.setPointerCapture(e.pointerId);
  const p = pointFromEvent(e);

  if (tool === 'pen') draft = { type: 'pen', points: [p], color, width: lineWidth };
  else if (tool === 'text') {
    const text = prompt('Text to add:');
    if (!text) return;
    strokes.push({ type: 'text', x: p.x, y: p.y, text, color, width: lineWidth });
    redraw();
    return;
  } else if (tool === 'arrow') draft = { type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: lineWidth };
  else draft = { type: tool, x: p.x, y: p.y, w: 0, h: 0, color, width: lineWidth };

  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!draft) return;
  const p = pointFromEvent(e);
  if (draft.type === 'pen') draft.points.push(p);
  else if (draft.type === 'arrow') { draft.x2 = p.x; draft.y2 = p.y; }
  else { draft.w = p.x - draft.x; draft.h = p.y - draft.y; }
  redraw();
});

canvas.addEventListener('pointerup', () => {
  if (!draft) return;
  const op = draft;
  draft = null;
  if ((op.type === 'rect' || op.type === 'ellipse') && Math.abs(op.w) < 4 && Math.abs(op.h) < 4) { redraw(); return; }
  strokes.push(op);
  redraw();
});

document.querySelectorAll('.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    tool = btn.dataset.tool;
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
  });
});

document.querySelectorAll('.swatch').forEach((btn) => {
  btn.addEventListener('click', () => {
    color = btn.dataset.color;
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('is-active', b === btn));
  });
});

$('width').addEventListener('input', (e) => { lineWidth = Number(e.target.value); });
$('undo').addEventListener('click', () => { strokes.pop(); redraw(); });
$('clear').addEventListener('click', () => { strokes = []; draft = null; redraw(); });
$('cancel').addEventListener('click', () => window.close());

$('done').addEventListener('click', async () => {
  // flatten exactly what is visible on the canvas
  const dataUrl = canvas.toDataURL('image/png');
  await chrome.storage.local.set({ 'annotate.result': { dataUrl, label } });
  await chrome.storage.local.remove('annotate.pending');
  try {
    await chrome.runtime.sendMessage({ type: 'annotation:done', dataUrl, label });
  } catch {
    // the panel may have been closed; the data is still in storage
  }
  window.close();
});

/* --------------------------------------------------------------------- init */

loadPending().then((ok) => {
  if (!ok) return;
  window.addEventListener('resize', () => {
    const maxW = Math.max(320, window.innerWidth - 40);
    const maxH = Math.max(240, window.innerHeight - 140);
    scale = Math.min(1, maxW / canvas.width, maxH / canvas.height);
    canvas.style.width = `${Math.round(canvas.width * scale)}px`;
    canvas.style.height = `${Math.round(canvas.height * scale)}px`;
  });
});
