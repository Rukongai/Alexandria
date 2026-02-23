import { describe, it, expect } from 'vitest';
import { generateSlug } from './slug.js';

describe('generateSlug', () => {
  it('should generate lowercase slug from name', () => {
    const slug = generateSlug('MyModel');
    // Strip the random suffix (last 5 chars: hyphen + 4 char suffix)
    const base = slug.slice(0, slug.lastIndexOf('-'));
    expect(base).toBe('mymodel');
  });

  it('should replace spaces with hyphens', () => {
    const slug = generateSlug('my cool model');
    const base = slug.slice(0, slug.lastIndexOf('-'));
    expect(base).toBe('my-cool-model');
  });

  it('should remove special characters', () => {
    const slug = generateSlug('model@name!#$%');
    const base = slug.slice(0, slug.lastIndexOf('-'));
    expect(base).toBe('model-name');
  });

  it('should append random suffix', () => {
    const slug1 = generateSlug('test');
    const slug2 = generateSlug('test');
    // Both should be valid slugs
    expect(slug1).toMatch(/^test-[a-z0-9]{4}$/);
    expect(slug2).toMatch(/^test-[a-z0-9]{4}$/);
    // Suffixes are random — they will differ with overwhelming probability
    // (chance of collision: 36^-4 ≈ 0.06%), so we just confirm the format
  });

  it('should collapse consecutive hyphens', () => {
    const slug = generateSlug('model   name!!here');
    const base = slug.slice(0, slug.lastIndexOf('-'));
    // Multiple spaces and special chars should not produce double hyphens
    expect(base).not.toMatch(/--/);
    expect(base).toBe('model-name-here');
  });

  it('should strip leading and trailing hyphens from base', () => {
    const slug = generateSlug('  model  ');
    const base = slug.slice(0, slug.lastIndexOf('-'));
    expect(base).not.toMatch(/^-|-$/);
    expect(base).toBe('model');
  });
});
