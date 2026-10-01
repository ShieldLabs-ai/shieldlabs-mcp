// WebCrypto only: this module runs on Cloudflare Workers as well as on Node.js.

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** Unpadded base64url of `bytes`. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

/** Unpadded base64url HMAC-SHA256 of `message`, keyed with the UTF-8 bytes of `secret`. */
export async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
}
