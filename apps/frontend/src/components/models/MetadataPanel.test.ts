import { describe, it, expect } from 'vitest';
import type { MetadataValue } from '@alexandria/shared';
import {
  buildEditState,
  buildRequest,
  defaultValueForType,
  type EditableField,
  type EditState,
} from './MetadataPanel';

// -- helpers --

function field(overrides: Partial<EditableField> & { fieldSlug: string }): EditableField {
  return {
    fieldName: overrides.fieldSlug,
    type: 'text',
    ...overrides,
  };
}

function metaVal(overrides: Partial<MetadataValue> & { fieldSlug: string }): MetadataValue {
  return {
    fieldName: overrides.fieldSlug,
    type: 'text',
    value: '',
    displayValue: '',
    ...overrides,
  };
}

// -- defaultValueForType --

describe('defaultValueForType', () => {
  it('returns empty array for multi_enum', () => {
    expect(defaultValueForType('multi_enum')).toEqual([]);
  });

  it('returns "false" for boolean', () => {
    expect(defaultValueForType('boolean')).toBe('false');
  });

  it.each(['text', 'number', 'date', 'url', 'enum'] as const)(
    'returns empty string for %s',
    (type) => {
      expect(defaultValueForType(type)).toBe('');
    },
  );
});

// -- buildEditState --

describe('buildEditState', () => {
  it('copies metadata values into state keyed by slug', () => {
    const metadata: MetadataValue[] = [
      metaVal({ fieldSlug: 'author', value: 'Alice' }),
      metaVal({ fieldSlug: 'tags', type: 'multi_enum', value: ['a', 'b'] }),
    ];
    const state = buildEditState(metadata, []);
    expect(state).toEqual({
      author: 'Alice',
      tags: ['a', 'b'],
    });
  });

  it('adds default values for unassigned fields', () => {
    const unassigned: EditableField[] = [
      field({ fieldSlug: 'notes', type: 'text' }),
      field({ fieldSlug: 'rating', type: 'number' }),
      field({ fieldSlug: 'tags', type: 'multi_enum' }),
      field({ fieldSlug: 'published', type: 'boolean' }),
      field({ fieldSlug: 'category', type: 'enum' }),
      field({ fieldSlug: 'created', type: 'date' }),
    ];
    const state = buildEditState([], unassigned);
    expect(state).toEqual({
      notes: '',
      rating: '',
      tags: [],
      published: 'false',
      category: '',
      created: '',
    });
  });

  it('combines assigned and unassigned fields', () => {
    const metadata: MetadataValue[] = [
      metaVal({ fieldSlug: 'author', value: 'Bob' }),
    ];
    const unassigned: EditableField[] = [
      field({ fieldSlug: 'notes', type: 'text' }),
    ];
    const state = buildEditState(metadata, unassigned);
    expect(state).toEqual({ author: 'Bob', notes: '' });
  });
});

// -- buildRequest --

describe('buildRequest', () => {
  it('skips fields that are unchanged from initial state', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'author', type: 'text' }),
      field({ fieldSlug: 'notes', type: 'text' }),
    ];
    const initial: EditState = { author: 'Alice', notes: '' };
    const edited: EditState = { author: 'Alice', notes: 'changed' };

    const req = buildRequest(edited, fields, initial);
    expect(req).toEqual({ notes: 'changed' });
    expect(req).not.toHaveProperty('author');
  });

  it('skips unchanged array fields (multi_enum)', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'tags', type: 'multi_enum' }),
    ];
    const initial: EditState = { tags: ['a', 'b'] };
    const edited: EditState = { tags: ['a', 'b'] };

    const req = buildRequest(edited, fields, initial);
    expect(req).toEqual({});
  });

  it('sends number 0 as 0, not null', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'rating', type: 'number' }),
    ];
    const initial: EditState = { rating: '' };
    const edited: EditState = { rating: '0' };

    const req = buildRequest(edited, fields, initial);
    expect(req.rating).toBe(0);
  });

  it('sends null for an empty number field', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'rating', type: 'number' }),
    ];
    const initial: EditState = { rating: '5' };
    const edited: EditState = { rating: '' };

    const req = buildRequest(edited, fields, initial);
    expect(req.rating).toBeNull();
  });

  it('coerces boolean strings to actual booleans', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'published', type: 'boolean' }),
    ];
    const initial: EditState = { published: 'false' };
    const edited: EditState = { published: 'true' };

    const req = buildRequest(edited, fields, initial);
    expect(req.published).toBe(true);
  });

  it('sends null for an empty multi_enum (cleared selection)', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'tags', type: 'multi_enum' }),
    ];
    const initial: EditState = { tags: ['a'] };
    const edited: EditState = { tags: [] };

    const req = buildRequest(edited, fields, initial);
    expect(req.tags).toBeNull();
  });

  it('sends multi_enum values as an array', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'tags', type: 'multi_enum' }),
    ];
    const initial: EditState = { tags: [] };
    const edited: EditState = { tags: ['x', 'y'] };

    const req = buildRequest(edited, fields, initial);
    expect(req.tags).toEqual(['x', 'y']);
  });

  it('sends enum value as a single string, not an array', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'category', type: 'enum' }),
    ];
    const initial: EditState = { category: '' };
    const edited: EditState = { category: 'option-a' };

    const req = buildRequest(edited, fields, initial);
    expect(req.category).toBe('option-a');
  });

  it('sends null for a cleared enum field', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'category', type: 'enum' }),
    ];
    const initial: EditState = { category: 'option-a' };
    const edited: EditState = { category: '' };

    const req = buildRequest(edited, fields, initial);
    expect(req.category).toBeNull();
  });

  it('sends null for a cleared text field', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'author', type: 'text' }),
    ];
    const initial: EditState = { author: 'Alice' };
    const edited: EditState = { author: '' };

    const req = buildRequest(edited, fields, initial);
    expect(req.author).toBeNull();
  });

  it('sends null for a cleared url field', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'link', type: 'url' }),
    ];
    const initial: EditState = { link: 'https://example.com' };
    const edited: EditState = { link: '' };

    const req = buildRequest(edited, fields, initial);
    expect(req.link).toBeNull();
  });

  it('sends null for a cleared date field', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'created', type: 'date' }),
    ];
    const initial: EditState = { created: '2024-01-01' };
    const edited: EditState = { created: '' };

    const req = buildRequest(edited, fields, initial);
    expect(req.created).toBeNull();
  });

  it('returns empty object when nothing changed', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'a', type: 'text' }),
      field({ fieldSlug: 'b', type: 'number' }),
      field({ fieldSlug: 'c', type: 'boolean' }),
    ];
    const state: EditState = { a: 'x', b: '5', c: 'true' };

    const req = buildRequest(state, fields, state);
    expect(req).toEqual({});
  });

  it('correctly parses numeric strings to numbers', () => {
    const fields: EditableField[] = [
      field({ fieldSlug: 'count', type: 'number' }),
    ];
    const initial: EditState = { count: '' };
    const edited: EditState = { count: '42.5' };

    const req = buildRequest(edited, fields, initial);
    expect(req.count).toBe(42.5);
  });
});
