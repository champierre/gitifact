export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

export function toDataUrl(mime: string, body: string, encoding: 'text' | 'base64'): string {
  const b64 = encoding === 'base64' ? body : textToBase64(body);
  return `data:${mime};base64,${b64}`;
}
