import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Upload, X } from 'lucide-react';
import type { VaultFileRecord } from '../../../shared/types';
import { apiFetch, apiJson } from '../../lib/api';

const CHUNK_SIZE = 4 * 1024 * 1024;

type VaultUploaderProps = {
  onUploaded: (file: VaultFileRecord) => void;
};

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function VaultUploader({ onUploaded }: VaultUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeUploadIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState('');
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const handleCancel = async () => {
    cancelledRef.current = true;
    abortControllerRef.current?.abort();
    const uploadId = activeUploadIdRef.current;
    activeUploadIdRef.current = null;
    if (uploadId) {
      await apiFetch(`/api/vault/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    setUploading(false);
    setFileName('');
    setProgress(0);
    setStatusMessage('已取消本次分片上传。');
  };

  const uploadSingleFile = async (file: File) => {
    cancelledRef.current = false;
    setUploading(true);
    setFileName(file.name);
    setProgress(0);
    setErrorMessage('');
    setStatusMessage('正在计算校验摘要……');

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const arrayBuf = await file.arrayBuffer();
      if (cancelledRef.current) return;

      const sha256 = await computeSha256Hex(arrayBuf);
      const totalChunks = Math.max(1, Math.ceil(arrayBuf.byteLength / CHUNK_SIZE));

      const initData = await apiJson<{ uploadId: string; fileId: string }>(
        '/api/vault/uploads/init',
        {
          method: 'POST',
          signal: controller.signal,
          json: {
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: arrayBuf.byteLength,
            sha256,
            totalChunks,
          },
        },
      );
      if (cancelledRef.current) return;

      activeUploadIdRef.current = initData.uploadId;
      const completed = new Set<number>();

      for (let i = 0; i < totalChunks; i += 1) {
        if (cancelledRef.current) return;
        if (completed.has(i)) continue;

        const start = i * CHUNK_SIZE;
        const end = Math.min(arrayBuf.byteLength, start + CHUNK_SIZE);
        const slice = arrayBuf.slice(start, end);

        let chunkOk = false;
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 2 && !cancelledRef.current; attempt += 1) {
          try {
            setStatusMessage(`正在上传分片 ${i + 1} / ${totalChunks}……`);
            const res = await apiFetch(
              `/api/vault/uploads/${encodeURIComponent(initData.uploadId)}/chunk`,
              {
                method: 'PUT',
                signal: controller.signal,
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'X-Chunk-Index': String(i),
                },
                body: slice,
              },
            );
            if (!res.ok) {
              const errData = (await res.json().catch(() => null)) as { error?: string } | null;
              throw new Error(errData?.error || `分片上传失败 (${res.status})`);
            }
            completed.add(i);
            chunkOk = true;
            setProgress(Math.round((completed.size / totalChunks) * 100));
            break;
          } catch (err) {
            if (cancelledRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
              return;
            }
            lastErr = err;
          }
        }

        if (!chunkOk) {
          throw lastErr instanceof Error ? lastErr : new Error('分片上传失败');
        }
      }

      if (cancelledRef.current) return;
      const done = await apiJson<{ file: VaultFileRecord }>(
        `/api/vault/uploads/${encodeURIComponent(initData.uploadId)}/complete`,
        {
          method: 'POST',
          signal: controller.signal,
          json: {},
        },
      );

      activeUploadIdRef.current = null;
      setUploading(false);
      setProgress(100);
      setStatusMessage(`已存为私密文件：${done.file.name}`);
      onUploaded(done.file);
    } catch (err) {
      if (cancelledRef.current || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setUploading(false);
      setErrorMessage(err instanceof Error ? err.message : '上传未能完成');
      setStatusMessage('');
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || uploading) return;
    void uploadSingleFile(file);
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div className="rounded-[20px] border border-dashed border-hairline-strong bg-surface p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={[
          'flex flex-col items-center justify-center rounded-[14px] px-4 py-6 text-center transition-colors',
          dragging ? 'bg-surface-hover' : '',
        ].join(' ')}
      >
        <Upload className="mb-2 h-5 w-5 text-ink-muted" aria-hidden="true" />
        <p className="m-0 mb-4 text-[14px] font-medium text-ink">拖拽文件到此处分片上传至私密密匣</p>

        <input
          ref={inputRef}
          type="file"
          aria-label="选择要上传至密匣的文件"
          onChange={handleChange}
          className="sr-only"
        />

        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="min-h-[38px] rounded-full bg-cta-bg px-4 text-[13px] font-medium text-cta-text disabled:opacity-50"
          >
            选择文件分片上传
          </button>

          {uploading && (
            <button
              type="button"
              onClick={() => void handleCancel()}
              className="inline-flex min-h-[38px] items-center gap-1 rounded-full bg-surface-hover px-4 text-[13px] font-medium text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              <span>取消上传</span>
            </button>
          )}
        </div>
      </div>

      {uploading && (
        <div className="mt-4">
          <div className="flex items-center justify-between text-[12px] text-ink-muted">
            <span className="truncate">{fileName}</span>
            <span className="tabular-nums-mono">{progress}%</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-page">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {statusMessage && (
        <p role="status" className="mt-3 mb-0 text-[12.5px] text-ink-muted">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="mt-3 mb-0 text-[12.5px] text-postmark">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
