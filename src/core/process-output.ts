import { mkdtemp, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ProcessExecution, ProcessOutput, ProcessRequest } from '../contracts/process.js';

export function systemErrorCode(
  error: unknown,
): NonNullable<ProcessExecution['error']>['systemCode'] {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = error.code;

    if (
      code === 'ENOENT' ||
      code === 'EACCES' ||
      code === 'EPERM' ||
      code === 'ENOTDIR' ||
      code === 'E2BIG' ||
      code === 'EIO' ||
      code === 'ENOSPC'
    ) {
      return code;
    }
  }

  return 'UNKNOWN';
}

/** Each collector retains a bounded prefix and awaits each file write for backpressure. */
export class ProcessOutputCollector {
  readonly output: ProcessOutput = {
    text: '',
    capturedBytes: 0,
    observedBytes: 0,
    truncated: false,
    complete: false,
    artifact: null,
  };
  done = false;
  private capture: Buffer;
  private file: FileHandle | undefined;

  constructor(
    private readonly captureLimit: number,
    private readonly artifactLimit: number,
  ) {
    this.capture = Buffer.alloc(captureLimit);
  }

  async openArtifact(path: string): Promise<void> {
    this.file = await open(path, 'wx', 0o600);
    this.output.artifact = { path, writtenBytes: 0, truncated: false, complete: false };
  }

  async collect(stream: Readable, onFailure: (error: unknown) => void): Promise<void> {
    try {
      for await (const value of stream) {
        const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        this.output.observedBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.output.observedBytes + chunk.length,
        );
        const keep = Math.min(chunk.length, this.captureLimit - this.output.capturedBytes);

        if (keep > 0) {
          chunk.copy(this.capture, this.output.capturedBytes, 0, keep);
          this.output.capturedBytes += keep;
        }

        this.output.truncated = this.output.observedBytes > this.output.capturedBytes;
        const artifact = this.output.artifact;

        if (artifact && this.file) {
          const length = Math.min(chunk.length, this.artifactLimit - artifact.writtenBytes);
          let offset = 0;

          while (offset < length) {
            const { bytesWritten } = await this.file.write(chunk, offset, length - offset);

            if (bytesWritten === 0) {
              throw new Error('Output write made no progress');
            }

            offset += bytesWritten;
            artifact.writtenBytes += bytesWritten;
          }

          artifact.truncated = artifact.writtenBytes < this.output.observedBytes;
        }
      }

      this.output.complete = stream.readableEnded;
    } catch (error) {
      onFailure(error);
    } finally {
      await this.finish(onFailure);
      this.done = true;
    }
  }

  async finish(onFailure: (error: unknown) => void): Promise<void> {
    this.output.text = this.capture.subarray(0, this.output.capturedBytes).toString('utf8');
    this.capture = Buffer.alloc(0);
    const file = this.file;
    this.file = undefined;
    let closed = true;

    try {
      await file?.close();
    } catch (error) {
      closed = false;
      onFailure(error);
    }

    if (this.output.artifact) {
      this.output.artifact.truncated =
        this.output.artifact.writtenBytes < this.output.observedBytes;
      this.output.artifact.complete =
        closed && this.output.complete && !this.output.artifact.truncated;
    }
  }
}

export async function prepareProcessArtifacts(
  request: ProcessRequest,
  stdout: ProcessOutputCollector,
  stderr: ProcessOutputCollector,
): Promise<void> {
  if (!request.artifacts) {
    return;
  }

  const directory = await mkdtemp(join(request.artifacts.directory, 'process-'));
  await stdout.openArtifact(join(directory, 'stdout.bin'));
  await stderr.openArtifact(join(directory, 'stderr.bin'));
}
