import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EtagCalculator, normalizeEtag } from './etag.js';

const PART_SIZE = 8;

function md5Hex(buffer: Buffer): string {
  return createHash('md5').update(buffer).digest('hex');
}

/** The reference multipart ETag, built the way S3 documents it. */
function multipartEtag(parts: Buffer[]): string {
  const digests = parts.map((part) => createHash('md5').update(part).digest());
  return `${md5Hex(Buffer.concat(digests))}-${parts.length}`;
}

function feed(calculator: EtagCalculator, chunks: Buffer[]): void {
  for (const chunk of chunks) calculator.update(chunk);
}

describe('normalizeEtag', () => {
  it('strips the quoting S3 applies and lowercases the value', () => {
    expect(normalizeEtag('"ABC123"')).toBe('abc123');
    expect(normalizeEtag('  "abc"  ')).toBe('abc');
  });

  it('treats empty and missing values alike', () => {
    expect(normalizeEtag(undefined)).toBeUndefined();
    expect(normalizeEtag('""')).toBeUndefined();
  });
});

describe('EtagCalculator', () => {
  it('matches a single-request upload against the MD5 of the whole body', () => {
    const body = Buffer.from('short body');
    const calculator = new EtagCalculator(1024);
    calculator.update(body);

    expect(calculator.matches(md5Hex(body))).toBe(true);
    expect(calculator.matches(`"${md5Hex(body)}"`)).toBe(true);
    expect(calculator.matches(md5Hex(Buffer.from('other')))).toBe(false);
  });

  it('matches a multipart upload against the digest-of-digests form', () => {
    const parts = [
      Buffer.alloc(PART_SIZE, 'a'),
      Buffer.alloc(PART_SIZE, 'b'),
      Buffer.alloc(3, 'c'),
    ];
    const calculator = new EtagCalculator(PART_SIZE);
    feed(calculator, parts);

    expect(calculator.matches(multipartEtag(parts))).toBe(true);
  });

  it('is unaffected by how the byte stream is chunked', () => {
    const parts = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(PART_SIZE, 'b'), Buffer.alloc(2, 'c')];
    const whole = Buffer.concat(parts);
    const expected = multipartEtag(parts);

    // One chunk spanning every part boundary at once.
    const single = new EtagCalculator(PART_SIZE);
    single.update(whole);
    expect(single.matches(expected)).toBe(true);

    // A byte at a time, so every boundary is crossed mid-chunk.
    const drip = new EtagCalculator(PART_SIZE);
    feed(drip, [...whole].map((byte) => Buffer.from([byte])));
    expect(drip.matches(expected)).toBe(true);

    // Chunks deliberately misaligned with the part size.
    const misaligned = new EtagCalculator(PART_SIZE);
    for (let offset = 0; offset < whole.length; offset += 3) {
      misaligned.update(whole.subarray(offset, offset + 3));
    }
    expect(misaligned.matches(expected)).toBe(true);
  });

  it('rejects an ETag whose part count disagrees', () => {
    const parts = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(PART_SIZE, 'b')];
    const calculator = new EtagCalculator(PART_SIZE);
    feed(calculator, parts);

    const [digest] = multipartEtag(parts).split('-');
    expect(calculator.matches(`${digest}-3`)).toBe(false);
  });

  it('rejects a body that differs by a single byte', () => {
    const parts = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(PART_SIZE, 'b')];
    const expected = multipartEtag(parts);

    const tampered = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(PART_SIZE, 'b')];
    tampered[1][0] = 0;

    const calculator = new EtagCalculator(PART_SIZE);
    feed(calculator, tampered);
    expect(calculator.matches(expected)).toBe(false);
  });

  it('treats an unrecognised ETag format as a failure rather than a pass', () => {
    const calculator = new EtagCalculator(PART_SIZE);
    calculator.update(Buffer.from('body'));

    for (const value of ['', 'not-an-etag', 'zzzz', '123-abc', undefined]) {
      expect(calculator.matches(value)).toBe(false);
    }
  });

  it('distinguishes an exact multiple of the part size from a trailing part', () => {
    const exact = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(PART_SIZE, 'b')];
    const calculator = new EtagCalculator(PART_SIZE);
    feed(calculator, exact);

    expect(calculator.matches(multipartEtag(exact))).toBe(true);
    // No empty third part may be invented for a body that divides evenly.
    expect(calculator.matches(multipartEtag([...exact, Buffer.alloc(0)]))).toBe(false);
  });

  it('can be asked more than once without changing its answer', () => {
    const parts = [Buffer.alloc(PART_SIZE, 'a'), Buffer.alloc(4, 'b')];
    const calculator = new EtagCalculator(PART_SIZE);
    feed(calculator, parts);

    const expected = multipartEtag(parts);
    expect(calculator.matches(expected)).toBe(true);
    expect(calculator.matches(expected)).toBe(true);
    expect(calculator.bytesHashed).toBe(PART_SIZE + 4);
  });

  it('rejects a part size that could not produce stable boundaries', () => {
    expect(() => new EtagCalculator(0)).toThrow();
    expect(() => new EtagCalculator(-1)).toThrow();
  });
});
