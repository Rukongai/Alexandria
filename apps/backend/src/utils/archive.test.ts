import { describe, it, expect } from 'vitest';
import { detectArchiveExtension, stripArchiveExtension } from './archive.js';

describe('detectArchiveExtension', () => {
  it('detects .zip', () => {
    expect(detectArchiveExtension('model.zip')).toBe('.zip');
  });

  it('detects .rar', () => {
    expect(detectArchiveExtension('model.rar')).toBe('.rar');
  });

  it('detects .7z', () => {
    expect(detectArchiveExtension('model.7z')).toBe('.7z');
  });

  it('detects .tar.gz', () => {
    expect(detectArchiveExtension('model.tar.gz')).toBe('.tar.gz');
  });

  it('detects .tgz', () => {
    expect(detectArchiveExtension('model.tgz')).toBe('.tgz');
  });

  it('returns null for unsupported extension', () => {
    expect(detectArchiveExtension('model.mp4')).toBeNull();
    expect(detectArchiveExtension('model.txt')).toBeNull();
    expect(detectArchiveExtension('model')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(detectArchiveExtension('MODEL.ZIP')).toBe('.zip');
    expect(detectArchiveExtension('Archive.RAR')).toBe('.rar');
    expect(detectArchiveExtension('Pack.TAR.GZ')).toBe('.tar.gz');
  });

  it('returns .tar.gz (not .gz) for model.tar.gz', () => {
    expect(detectArchiveExtension('model.tar.gz')).toBe('.tar.gz');
  });
});

describe('stripArchiveExtension', () => {
  it('strips .zip', () => {
    expect(stripArchiveExtension('my-model.zip')).toBe('my-model');
  });

  it('strips .rar', () => {
    expect(stripArchiveExtension('my-model.rar')).toBe('my-model');
  });

  it('strips .7z', () => {
    expect(stripArchiveExtension('my-model.7z')).toBe('my-model');
  });

  it('strips .tar.gz (multi-part extension)', () => {
    expect(stripArchiveExtension('my-model.tar.gz')).toBe('my-model');
  });

  it('strips .tgz', () => {
    expect(stripArchiveExtension('my-model.tgz')).toBe('my-model');
  });

  it('returns filename unchanged for unsupported extension', () => {
    expect(stripArchiveExtension('model.mp4')).toBe('model.mp4');
    expect(stripArchiveExtension('model')).toBe('model');
  });
});
