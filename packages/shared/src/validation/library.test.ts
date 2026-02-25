import { describe, it, expect } from 'vitest';
import { createLibrarySchema } from './library.js';

describe('createLibrarySchema — pathTemplate validation', () => {
  it('should pass for template {library}/{metadata.artist}/{model}', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{library}/{metadata.artist}/{model}',
    });
    expect(result.success).toBe(true);
  });

  it('should pass for template /data/{library}/{metadata.category}/{metadata.artist}/{model}', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '/data/{library}/{metadata.category}/{metadata.artist}/{model}',
    });
    expect(result.success).toBe(true);
  });

  it('should pass for minimal template {library}/{model}', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(true);
  });

  it('should fail when {library} is missing from template', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{metadata.artist}/{model}',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when {model} is not the last token', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{library}/{model}/{metadata.artist}',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when {model} is missing entirely', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{library}/{metadata.artist}',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when {library} appears after another variable token', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{metadata.artist}/{library}/{model}',
    });
    expect(result.success).toBe(false);
  });

  it('should fail with empty template string', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when template has no tokens at all', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: 'just/a/plain/path',
    });
    expect(result.success).toBe(false);
  });

  it('should fail when an intermediate token is not a metadata slug', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/data/models',
      pathTemplate: '{library}/{unknown_token}/{model}',
    });
    expect(result.success).toBe(false);
  });
});

describe('createLibrarySchema — name validation', () => {
  it('should fail when name is empty', () => {
    const result = createLibrarySchema.safeParse({
      name: '',
      rootPath: '/data/models',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(false);
  });

  it('should pass when name is a non-empty string', () => {
    const result = createLibrarySchema.safeParse({
      name: 'Valid Name',
      rootPath: '/data/models',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(true);
  });

  it('should fail when name is missing', () => {
    const result = createLibrarySchema.safeParse({
      rootPath: '/data/models',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(false);
  });
});

describe('createLibrarySchema — rootPath validation', () => {
  it('should fail when rootPath is empty', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(false);
  });

  it('should pass when rootPath is a non-empty string', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      rootPath: '/some/path',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(true);
  });

  it('should fail when rootPath is missing', () => {
    const result = createLibrarySchema.safeParse({
      name: 'My Library',
      pathTemplate: '{library}/{model}',
    });
    expect(result.success).toBe(false);
  });
});
