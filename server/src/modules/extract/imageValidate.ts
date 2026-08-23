import { PayloadTooLargeError, UnsupportedMediaTypeError } from '../../lib/errors';

const MAX_BYTES = 10 * 1024 * 1024;

export interface ImageInfo {
  mime: string;
}

export function detectImageMime(buffer: Buffer): ImageInfo | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg' };
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp' };
  }
  return null;
}

export function assertValidImage(buffer: Buffer): ImageInfo {
  if (buffer.length > MAX_BYTES) {
    throw new PayloadTooLargeError('Image exceeds the 10MB limit');
  }
  const info = detectImageMime(buffer);
  if (!info) {
    throw new UnsupportedMediaTypeError('Unsupported image format; upload PNG, JPEG or WebP');
  }
  return info;
}
