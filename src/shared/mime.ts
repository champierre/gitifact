const MAP: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm', pdf: 'application/pdf', map: 'application/json',
};

/** raw.githubusercontent.com serves most files as text/plain, so the MIME type is derived from the extension. */
export function mimeFromPath(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && MAP[m[1]!]) || 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || /\b(json|javascript|xml|svg)\b/.test(mime);
}
