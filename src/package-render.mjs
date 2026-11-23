import opentype from 'opentype.js';
import { drawLayer } from './localizerSvg.mjs';

export async function loadArt(manifest) {
  const [base, font] = await Promise.all([loadImage(manifest.assets.base), fetch(manifest.assets.font).then(r => {
    if (!r.ok) throw Error('Font unavailable. Refresh the package.');
    return r.arrayBuffer();
  }).then(buffer => opentype.parse(buffer))]);
  if (base.naturalWidth !== manifest.width || base.naturalHeight !== manifest.height) throw Error('Base dimensions differ from manifest.');
  return {base, font};
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(Error('Image unavailable. Refresh the package.'));
    img.src = src;
  });
}

export async function renderArt(m, art, texts) {
  const errors = {};
  const paths = [];
  for (const b of [...m.blocks].filter(b => b.editable).sort((a,b) => a.z-b.z)) {
    try {
      if (!/^#[0-9a-f]{3,8}$/i.test(b.color) || ![b.origin_x,b.baseline_y,b.line_height,b.scale_x,b.font_size,b.min_font_size,b.max_width,b.max_lines].every(Number.isFinite)) throw Error('Invalid layer geometry');
      const text = texts[b.id] ?? b.text;
      if (!text.trim()) throw Error('Empty translation');
      const missing = [...new Set([...text].filter(c => c !== '\n' && !art.font.charToGlyphIndex(c)))];
      if (missing.length) throw Error('Missing glyph: ' + missing.join(' '));
      paths.push(drawLayer(b, art.font, text));
    } catch (e) { errors[b.id] = e.message; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = m.width; canvas.height = m.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(art.base,0,0);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+canvas.width+'" height="'+canvas.height+'">'+paths.join('')+'</svg>';
  const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
  try { ctx.drawImage(await loadImage(url),0,0); } finally { URL.revokeObjectURL(url); }
  return {canvas,errors};
}
