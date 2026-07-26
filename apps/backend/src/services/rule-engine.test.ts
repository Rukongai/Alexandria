/**
 * Unit tests for the rule engine. Pure — no database. SQL fragments are
 * rendered with PgDialect and asserted on shape + parameters.
 *
 * Coverage:
 * - buildLeafCondition: one assertion per (field, operator) pair, including the
 *   exact subquery shapes that mirror searchModels.
 * - compileRuleTree: nested AND/OR nesting, single-child unwrapping, empty-root
 *   match-all (undefined), value/operator error paths.
 */

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { smartCollectionDefinitionSchema, type RuleNode, type RuleCondition } from '@alexandria/shared';
import { buildLeafCondition, compileRuleTree, buildTsQuery, collectConditions } from './rule-engine.js';

const dialect = new PgDialect();

function render(node: RuleNode) {
  const compiled = compileRuleTree(node);
  if (compiled === undefined) return { sql: undefined, params: undefined };
  const q = dialect.sqlToQuery(compiled);
  return { sql: q.sql, params: q.params };
}

function renderLeaf(leaf: RuleCondition) {
  return dialect.sqlToQuery(buildLeafCondition(leaf));
}

const cond = (
  field: RuleCondition['field'],
  operator: RuleCondition['operator'],
  value: string | null = null,
): RuleCondition => ({ kind: 'condition', field, operator, value });

const builtin = (f: string) => ({ source: 'builtin' as const, field: f as never });
const meta = (slug: string) => ({ source: 'metadata' as const, slug });

describe('buildTsQuery', () => {
  it('prefix-matches the last token only', () => {
    expect(buildTsQuery('dragon bust')).toBe('dragon & bust:*');
  });
  it('returns empty for punctuation-only input', () => {
    expect(buildTsQuery('!!!')).toBe('');
  });
});

describe('buildLeafCondition — builtin fields', () => {
  it('name/contains uses full-text search on search_vector', () => {
    const q = renderLeaf(cond(builtin('name'), 'contains', 'dragon'));
    expect(q.sql).toContain('@@ to_tsquery');
    expect(q.params).toContain('dragon:*');
  });

  it('name/contains with unparseable value matches everything', () => {
    const q = renderLeaf(cond(builtin('name'), 'contains', '!!!'));
    expect(q.sql.toLowerCase()).toContain('true');
  });

  it('name/equals is a case-insensitive exact match', () => {
    const q = renderLeaf(cond(builtin('name'), 'equals', 'Dragon'));
    expect(q.sql).toContain('lower(');
    expect(q.params).toContain('Dragon');
  });

  it('status/is and isNot', () => {
    expect(renderLeaf(cond(builtin('status'), 'is', 'ready')).sql).toContain('"status" =');
    expect(renderLeaf(cond(builtin('status'), 'isNot', 'ready')).sql).toContain('<>');
  });

  it('hasDuplicates/is and isNot compare the duplicate-review flag as a boolean', () => {
    const isDuplicate = renderLeaf(cond(builtin('hasDuplicates'), 'is', 'true'));
    expect(isDuplicate.sql).toContain('"is_duplicate" =');
    expect(isDuplicate.params).toContain(true);

    const isNotDuplicate = renderLeaf(cond(builtin('hasDuplicates'), 'isNot', 'true'));
    expect(isNotDuplicate.sql).toContain('"is_duplicate" <>');
    expect(isNotDuplicate.params).toContain(true);
  });

  it('rejects invalid values for hasDuplicates', () => {
    expect(() => buildLeafCondition(cond(builtin('hasDuplicates'), 'is', 'yes'))).toThrow();
  });

  it('validates hasDuplicates values in the shared rule definition schema', () => {
    const valid = cond(builtin('hasDuplicates'), 'is', 'true');
    const invalid = cond(builtin('hasDuplicates'), 'is', 'yes');

    expect(smartCollectionDefinitionSchema.safeParse(valid).success).toBe(true);
    expect(smartCollectionDefinitionSchema.safeParse(invalid).success).toBe(false);
  });

  it('manualPreview/exists and notExists check for an explicitly pinned cover', () => {
    expect(renderLeaf(cond(builtin('manualPreview'), 'exists')).sql).toContain(
      '"preview_image_file_id" IS NOT NULL',
    );
    expect(renderLeaf(cond(builtin('manualPreview'), 'notExists')).sql).toContain(
      '"preview_image_file_id" IS NULL',
    );
  });

  it('fileType/has is an EXISTS subquery; notHas negates it', () => {
    const has = renderLeaf(cond(builtin('fileType'), 'has', 'stl'));
    expect(has.sql).toContain('EXISTS');
    expect(has.sql).toContain('model_files');
    expect(has.params).toContain('stl');
    expect(renderLeaf(cond(builtin('fileType'), 'notHas', 'stl')).sql).toContain('NOT EXISTS');
  });

  it('collection/inCollection and notInCollection use membership subqueries', () => {
    const inC = renderLeaf(cond(builtin('collection'), 'inCollection', 'c-id'));
    expect(inC.sql).toContain('collection_models');
    expect(inC.sql).toContain('IN (');
    expect(renderLeaf(cond(builtin('collection'), 'notInCollection', 'c-id')).sql).toContain('NOT IN (');
  });

  it('tag/hasTag joins tags case-insensitively', () => {
    const q = renderLeaf(cond(builtin('tag'), 'hasTag', 'Dragon'));
    expect(q.sql).toContain('model_tags');
    expect(q.sql).toContain('lower(t.name) = lower(');
    expect(q.params).toContain('Dragon');
    expect(renderLeaf(cond(builtin('tag'), 'notHasTag', 'Dragon')).sql).toContain('NOT IN');
  });
});

describe('buildLeafCondition — metadata fields', () => {
  it('equals/is uses the slug-join subquery (mirrors searchModels)', () => {
    const q = renderLeaf(cond(meta('artist'), 'equals', 'Loot Studios'));
    expect(q.sql).toContain('model_metadata');
    expect(q.sql).toContain('metadata_field_definitions');
    expect(q.sql).toContain('fd.slug =');
    expect(q.params).toEqual(expect.arrayContaining(['artist', 'Loot Studios']));
  });

  it('notEquals negates membership', () => {
    expect(renderLeaf(cond(meta('artist'), 'notEquals', 'X')).sql).toContain('NOT IN');
  });

  it('contains uses ILIKE with wildcards', () => {
    const q = renderLeaf(cond(meta('artist'), 'contains', 'loot'));
    expect(q.sql).toContain('ILIKE');
    expect(q.params).toContain('%loot%');
  });

  it('exists / notExists check for a non-empty value', () => {
    expect(renderLeaf(cond(meta('artist'), 'exists')).sql).toContain("mm.value <> ''");
    expect(renderLeaf(cond(meta('artist'), 'notExists')).sql).toContain('NOT IN');
  });
});

describe('buildLeafCondition — error paths', () => {
  it('throws when a value-required operator has no value', () => {
    expect(() => buildLeafCondition(cond(builtin('status'), 'is', null))).toThrow();
  });
  it('throws on an illegal field/operator pair', () => {
    expect(() => buildLeafCondition(cond(builtin('status'), 'contains', 'x'))).toThrow();
  });
});

describe('compileRuleTree', () => {
  it('returns undefined for an empty root group (match all)', () => {
    expect(compileRuleTree({ kind: 'group', op: 'and', children: [] })).toBeUndefined();
  });

  it('unwraps a single-child group (no AND/OR wrapper)', () => {
    const single: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [cond(builtin('status'), 'is', 'ready')],
    };
    const q = render(single);
    expect(q.sql).toContain('"status" =');
    expect(q.sql).not.toMatch(/\band\b/i);
  });

  it('combines children with AND', () => {
    const tree: RuleNode = {
      kind: 'group',
      op: 'and',
      children: [cond(builtin('tag'), 'hasTag', 'dragon'), cond(builtin('fileType'), 'has', 'stl')],
    };
    const q = render(tree);
    expect(q.sql).toContain(' and ');
    expect(q.params).toEqual(expect.arrayContaining(['dragon', 'stl']));
  });

  it('combines children with OR', () => {
    const tree: RuleNode = {
      kind: 'group',
      op: 'or',
      children: [cond(builtin('status'), 'is', 'ready'), cond(builtin('status'), 'is', 'processing')],
    };
    expect(render(tree).sql).toContain(' or ');
  });

  it('nests groups: (tag AND fileType) OR status', () => {
    const tree: RuleNode = {
      kind: 'group',
      op: 'or',
      children: [
        {
          kind: 'group',
          op: 'and',
          children: [cond(builtin('tag'), 'hasTag', 'dragon'), cond(builtin('fileType'), 'has', 'stl')],
        },
        cond(builtin('status'), 'is', 'error'),
      ],
    };
    const q = render(tree);
    expect(q.sql).toContain(' or ');
    expect(q.sql).toContain(' and ');
    expect(q.params).toEqual(expect.arrayContaining(['dragon', 'stl', 'error']));
  });
});

describe('collectConditions', () => {
  it('flattens every leaf in a nested tree', () => {
    const tree: RuleNode = {
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'group', op: 'and', children: [cond(builtin('status'), 'is', 'ready')] },
        cond(builtin('tag'), 'hasTag', 'dragon'),
      ],
    };
    expect(collectConditions(tree)).toHaveLength(2);
  });
});
