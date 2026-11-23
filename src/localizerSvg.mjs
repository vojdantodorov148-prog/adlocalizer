// A consumer supplies an opentype.js font parsed from the manifest font asset.
// Paths avoid browser-specific font fallback and baseline placement.
export function drawLayer(layer, font, text = layer.text) {
  if (!layer.editable) return "";
  const lines = text.split("\n");
  if (lines.length > layer.max_lines) throw new Error(layer.id + ": line limit");
  if ([...text].some(c => c !== "\n" && !font.charToGlyphIndex(c))) throw new Error(layer.id + ": missing glyph");
  const width = Math.max(...lines.map(line => font.getAdvanceWidth(line, layer.font_size) * layer.scale_x));
  const size = Math.min(layer.font_size, layer.font_size * layer.max_width / Math.max(width, 1));
  if (size < layer.min_font_size) throw new Error(layer.id + ": translation overflow");
  return lines.map((line, i) => {
    const path = font.getPath(line, 0, 0, size).toPathData(3);
    return '<path transform="translate(' + layer.origin_x + ' ' + (layer.baseline_y + i * layer.line_height) +
      ') scale(' + layer.scale_x + ' 1)" fill="' + layer.color + '" d="' + path + '"/>';
  }).join("");
}
