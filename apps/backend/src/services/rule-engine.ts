import { and, or, sql, SQL } from 'drizzle-orm';
import type { RuleNode, RuleCondition, RuleFieldRef } from '@alexandria/shared';
import { models } from '../db/schema/index.js';
import { validationError } from '../utils/errors.js';

// ---------------------------------------------------------------------------
// Rule engine — compiles a smart-collection rule tree into a single Drizzle SQL
// condition over the models table.
//
// The per-leaf SQL fragments mirror EXACTLY the subquery shapes used by
// search.service `searchModels`, so a flat ModelSearchParams filter and the
// equivalent rule tree produce identical results. searchModels is refactored to
// build its own conditions via `buildLeafCondition` too, so there is a single
// source of truth for "what SQL a filter on dimension X looks like".
//
// The compiler is pure: no I/O, no DB access, no context needed. All v1
// operators are text comparisons, so it never needs a metadata field's type to
// emit SQL. Validation that a field exists and that its operator is legal for
// its type happens in SmartCollectionService before compilation.
// ---------------------------------------------------------------------------

/**
 * Convert a user-supplied search string into a Postgres tsquery expression.
 * Mirrors the global search bar: "dragon bust" → "dragon & bust:*" (prefix
 * match on the final token only). Returns '' when nothing usable remains.
 *
 * Defined here (not in search.service) so both the rule engine and the
 * refactored searchModels can share it without a circular import.
 */
export function buildTsQuery(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';

  // Strip characters that have special meaning in tsquery
  const safe = tokens.map((t) => t.replace(/[!'()*:&|<>]/g, ''));
  const filtered = safe.filter(Boolean);
  if (filtered.length === 0) return '';

  const last = filtered.length - 1;
  const parts = filtered.map((t, i) => (i === last ? `${t}:*` : t));
  return parts.join(' & ');
}

/** A non-null, non-empty value is required for every operator except exists/notExists. */
function requireValue(leaf: RuleCondition): string {
  if (leaf.value === null || leaf.value.trim() === '') {
    throw validationError(`Rule operator '${leaf.operator}' requires a value`);
  }
  return leaf.value;
}

function describeField(field: RuleFieldRef): string {
  return field.source === 'builtin' ? field.field : `metadata:${field.slug}`;
}

function illegal(leaf: RuleCondition): never {
  throw validationError(
    `Operator '${leaf.operator}' is not valid for field '${describeField(leaf.field)}'`,
  );
}

// ---- Built-in field leaves ----

function buildBuiltinCondition(leaf: RuleCondition): SQL {
  if (leaf.field.source !== 'builtin') illegal(leaf);
  const op = leaf.operator;

  switch (leaf.field.field) {
    case 'name': {
      // `contains` performs a full-text search across the model's indexed text
      // (name weighted above description) — identical to the search bar's `q`.
      if (op === 'contains') {
        const tsQuery = buildTsQuery(requireValue(leaf));
        if (!tsQuery) return sql`true`; // unparseable query → no constraint (matches search)
        return sql`${models.searchVector} @@ to_tsquery('english', ${tsQuery})`;
      }
      if (op === 'equals') {
        return sql`lower(${models.name}) = lower(${requireValue(leaf)})`;
      }
      return illegal(leaf);
    }

    case 'description': {
      // True substring match on the description column (search_vector cannot
      // separate name from description, so this uses the column directly).
      if (op === 'contains') {
        return sql`${models.description} ILIKE ${'%' + requireValue(leaf) + '%'}`;
      }
      return illegal(leaf);
    }

    case 'status': {
      if (op === 'is') return sql`${models.status} = ${requireValue(leaf)}`;
      if (op === 'isNot') return sql`${models.status} <> ${requireValue(leaf)}`;
      return illegal(leaf);
    }

    case 'fileType': {
      const value = requireValue(leaf);
      const exists = sql`EXISTS (
        SELECT 1 FROM model_files mf
        WHERE mf.model_id = ${models.id}
          AND mf.file_type = ${value}
      )`;
      if (op === 'has') return exists;
      if (op === 'notHas') return sql`NOT ${exists}`;
      return illegal(leaf);
    }

    case 'collection': {
      const value = requireValue(leaf);
      const inSet = sql`${models.id} IN (
        SELECT cm.model_id FROM collection_models cm
        WHERE cm.collection_id = ${value}
      )`;
      if (op === 'inCollection') return inSet;
      if (op === 'notInCollection') return sql`${models.id} NOT IN (
        SELECT cm.model_id FROM collection_models cm
        WHERE cm.collection_id = ${value}
      )`;
      return illegal(leaf);
    }

    case 'tag': {
      const value = requireValue(leaf);
      const inSet = sql`${models.id} IN (
        SELECT mt.model_id FROM model_tags mt
        INNER JOIN tags t ON t.id = mt.tag_id
        WHERE lower(t.name) = lower(${value})
      )`;
      if (op === 'hasTag') return inSet;
      if (op === 'notHasTag') return sql`${models.id} NOT IN (
        SELECT mt.model_id FROM model_tags mt
        INNER JOIN tags t ON t.id = mt.tag_id
        WHERE lower(t.name) = lower(${value})
      )`;
      return illegal(leaf);
    }

    default:
      return illegal(leaf);
  }
}

// ---- Metadata field leaves ----
//
// All use the slug-join form (identical to searchModels' metadataFilters
// subquery) so the SQL is provably the same as flat search. Membership is
// expressed as IN / NOT IN over model ids.

function metadataMembership(slug: string, valuePredicate: SQL): SQL {
  return sql`(
    SELECT mm.model_id FROM model_metadata mm
    INNER JOIN metadata_field_definitions fd ON fd.id = mm.field_definition_id
    WHERE fd.slug = ${slug} AND ${valuePredicate}
  )`;
}

function buildMetadataCondition(leaf: RuleCondition): SQL {
  if (leaf.field.source !== 'metadata') illegal(leaf);
  const slug = leaf.field.slug;
  const op = leaf.operator;

  switch (op) {
    case 'equals':
    case 'is': {
      const sub = metadataMembership(slug, sql`mm.value = ${requireValue(leaf)}`);
      return sql`${models.id} IN ${sub}`;
    }
    case 'notEquals':
    case 'isNot': {
      const sub = metadataMembership(slug, sql`mm.value = ${requireValue(leaf)}`);
      return sql`${models.id} NOT IN ${sub}`;
    }
    case 'contains': {
      const sub = metadataMembership(slug, sql`mm.value ILIKE ${'%' + requireValue(leaf) + '%'}`);
      return sql`${models.id} IN ${sub}`;
    }
    case 'exists': {
      const sub = metadataMembership(slug, sql`mm.value <> ''`);
      return sql`${models.id} IN ${sub}`;
    }
    case 'notExists': {
      const sub = metadataMembership(slug, sql`mm.value <> ''`);
      return sql`${models.id} NOT IN ${sub}`;
    }
    default:
      return illegal(leaf);
  }
}

/** Compile a single leaf condition to SQL. */
export function buildLeafCondition(leaf: RuleCondition): SQL {
  return leaf.field.source === 'builtin'
    ? buildBuiltinCondition(leaf)
    : buildMetadataCondition(leaf);
}

/**
 * Compile a rule tree into a single SQL condition over the models table.
 *
 * Returns `undefined` when the tree imposes no constraint (an empty root
 * group) — the caller treats that as "match every model in the library".
 * Non-empty groups always produce SQL because leaves always do.
 */
export function compileRuleTree(node: RuleNode): SQL | undefined {
  if (node.kind === 'condition') {
    return buildLeafCondition(node);
  }

  const compiled = node.children
    .map((child) => compileRuleTree(child))
    .filter((c): c is SQL => c !== undefined);

  if (compiled.length === 0) {
    // Only reachable for an empty root group (nested groups require >=1 child).
    return undefined;
  }
  if (compiled.length === 1) {
    return compiled[0];
  }
  // and()/or() with >=2 defined operands always return a defined SQL.
  return (node.op === 'and' ? and(...compiled) : or(...compiled)) as SQL;
}

/** Walk every condition leaf in a tree (used by callers for inspection). */
export function collectConditions(node: RuleNode): RuleCondition[] {
  if (node.kind === 'condition') return [node];
  return node.children.flatMap(collectConditions);
}
