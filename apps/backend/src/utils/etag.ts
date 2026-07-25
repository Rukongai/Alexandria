/**
 * S3 ETag computation, used to verify a stored object without downloading it
 * back.
 *
 * S3 (and MEGA S4, verified against a live bucket) derives an object's ETag
 * from the uploaded bytes:
 *
 *   - single-request upload: MD5 of the whole body, 32 hex characters
 *   - multipart upload:      MD5 over the concatenated raw MD5 digests of each
 *                            part, suffixed with `-<partCount>`
 *
 * Hashing the bytes as they stream to the provider therefore yields enough
 * information to confirm the object landed intact, replacing a full re-download
 * per file. MD5 is used because the ETag scheme mandates it — it is an
 * integrity check against truncation and transport corruption, not a security
 * boundary. Content authenticity is still covered by the SHA-256 hashes stored
 * alongside each file.
 */
import { createHash, type Hash } from 'node:crypto';

const SINGLE_PART_ETAG = /^[0-9a-f]{32}$/;
const MULTIPART_ETAG = /^([0-9a-f]{32})-(\d+)$/;

/** Strip the quoting S3 applies to ETag header values. */
export function normalizeEtag(etag: string | undefined): string | undefined {
  return etag?.replaceAll('"', '').trim().toLowerCase() || undefined;
}

/**
 * Accumulates the digests needed to reproduce an object's ETag.
 *
 * `partSize` must match the part size used for the upload; a mismatch changes
 * the part boundaries and therefore the expected multipart digest.
 */
export class EtagCalculator {
  private readonly partSize: number;
  private readonly wholeObject: Hash = createHash('md5');
  private readonly partDigests: Buffer[] = [];

  private currentPart: Hash = createHash('md5');
  private currentPartBytes = 0;
  private totalBytes = 0;

  constructor(partSize: number) {
    if (!Number.isSafeInteger(partSize) || partSize < 1) {
      throw new Error('Part size must be a positive integer');
    }
    this.partSize = partSize;
  }

  update(chunk: Buffer): void {
    this.wholeObject.update(chunk);
    this.totalBytes += chunk.length;

    // A chunk can span several part boundaries, so consume it in slices that
    // each fit inside the part currently being hashed.
    let offset = 0;
    while (offset < chunk.length) {
      const remainingInPart = this.partSize - this.currentPartBytes;
      const take = Math.min(remainingInPart, chunk.length - offset);

      this.currentPart.update(chunk.subarray(offset, offset + take));
      this.currentPartBytes += take;
      offset += take;

      if (this.currentPartBytes === this.partSize) {
        this.partDigests.push(this.currentPart.digest());
        this.currentPart = createHash('md5');
        this.currentPartBytes = 0;
      }
    }
  }

  get bytesHashed(): number {
    return this.totalBytes;
  }

  /**
   * Whether `etag` is consistent with the bytes seen so far.
   *
   * The provider decides between a single-request and a multipart upload, so
   * the shape of the returned ETag selects which digest to compare rather than
   * the caller having to predict that decision.
   */
  matches(etag: string | undefined): boolean {
    const normalized = normalizeEtag(etag);
    if (!normalized) return false;

    const multipart = MULTIPART_ETAG.exec(normalized);
    if (multipart) {
      const digests = this.finalizedPartDigests();
      if (digests.length !== Number(multipart[2])) return false;

      const combined = createHash('md5').update(Buffer.concat(digests)).digest('hex');
      return combined === multipart[1];
    }

    if (SINGLE_PART_ETAG.test(normalized)) {
      return this.wholeObjectDigest() === normalized;
    }

    // Unrecognised format — a provider that does not follow the S3 scheme must
    // not be treated as having passed verification.
    return false;
  }

  private finalizedPartDigests(): Buffer[] {
    if (this.currentPartBytes === 0) return this.partDigests;
    // `copy()` keeps this method side-effect free so it can be called twice.
    return [...this.partDigests, this.currentPart.copy().digest()];
  }

  private wholeObjectDigest(): string {
    return this.wholeObject.copy().digest('hex');
  }
}
