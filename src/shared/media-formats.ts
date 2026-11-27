export const CLOUD_MEDIA_LIMITS = {
  maxFileBytes: 16 << 20,
  maxBatchBytes: 16 << 20,
  maxChunkBytes: 8 << 20,
  maxFiles: 100,
} as const;

export const SUPPORTED_FORMATS = [
  { kind: 'image', label: 'JPEG', mime: 'image/jpeg', ext: ['jpg', 'jpeg'] },
  { kind: 'image', label: 'PNG', mime: 'image/png', ext: ['png'] },
  { kind: 'image', label: 'GIF', mime: 'image/gif', ext: ['gif'] },
  { kind: 'image', label: 'WebP', mime: 'image/webp', ext: ['webp'] },
  { kind: 'image', label: 'AVIF', mime: 'image/avif', ext: ['avif'] },
  { kind: 'image', label: 'HEIC', mime: 'image/heic', ext: ['heic'] },
  { kind: 'video', label: 'MP4', mime: 'video/mp4', ext: ['mp4'] },
  { kind: 'video', label: 'MOV', mime: 'video/quicktime', ext: ['mov'] },
  { kind: 'video', label: 'WebM', mime: 'video/webm', ext: ['webm'] },
  { kind: 'file', label: 'PDF', mime: 'application/pdf', ext: ['pdf'] },
  { kind: 'file', label: 'ZIP', mime: 'application/zip', ext: ['zip'] },
  { kind: 'document', label: 'TXT', mime: 'text/plain; charset=utf-8', ext: ['txt'] },
  { kind: 'document', label: 'Markdown', mime: 'text/plain; charset=utf-8', ext: ['md'] },
] as const;

type FormatKind = (typeof SUPPORTED_FORMATS)[number]['kind'];

export const acceptAttribute = [
  ...new Set(
    SUPPORTED_FORMATS.flatMap((format) => [
      format.mime.split(';')[0],
      ...format.ext.map((ext) => `.${ext}`),
    ]),
  ),
].join(',');

export function formatSummary(kind?: FormatKind): string {
  return SUPPORTED_FORMATS.filter(
    (format) => !kind || format.kind === kind || (kind === 'file' && format.kind === 'document'),
  )
    .map((format) => format.label)
    .join(' / ');
}
