import type { MetadataFieldType } from './metadata.js';
import type { ModelStatus, FileType, ModelSearchParams } from './model.js';

// ---------------------------------------------------------------------------
// Smart Collections — dynamic, rule-based collections (P4).
//
// A smart collection stores a nested boolean RULE TREE (its "definition"). The
// result set is never materialized; it is derived on read by compiling the
// tree into a SQL query against the models table (see rule-engine on the
// backend). The definition is the only server state.
// ---------------------------------------------------------------------------

/**
 * Built-in fields a rule can target. Each maps to a fixed column or join in the
 * existing model search (see search.service `buildLeafCondition`).
 */
export type BuiltinRuleField =
  | 'name' // models.search_vector / models.name
  | 'description' // models.search_vector
  | 'status' // models.status
  | 'hasDuplicates' // models.is_duplicate (duplicate-review flag)
  | 'manualPreview' // models.preview_image_file_id (user-pinned cover)
  | 'fileType' // model_files.file_type (EXISTS)
  | 'collection' // collection_models membership
  | 'tag'; // model_tags + tags membership

export const BUILTIN_RULE_FIELDS: readonly BuiltinRuleField[] = [
  'name',
  'description',
  'status',
  'hasDuplicates',
  'manualPreview',
  'fileType',
  'collection',
  'tag',
];

/**
 * A reference to the field a condition targets — either a built-in dimension or
 * a user-defined metadata field addressed by its slug. Structured (rather than
 * a colon-prefixed string) so validation and compilation can switch on `source`
 * without parsing.
 */
export type RuleFieldRef =
  | { source: 'builtin'; field: BuiltinRuleField }
  | { source: 'metadata'; slug: string };

/**
 * The operators supported in v1. All are text-safe — numeric/date comparison
 * operators (gt/lt/before/after) are deliberately deferred because metadata
 * values are stored as untyped text and a cast would throw on a bad row.
 * "is A or is B" is expressed with single-value operators under an OR group, so
 * no multi-value operators are needed.
 */
export type RuleOperator =
  | 'contains' // full-text / substring match
  | 'equals' // exact (case-insensitive)
  | 'notEquals'
  | 'is' // enum/boolean exact
  | 'isNot'
  | 'has' // fileType present (EXISTS)
  | 'notHas'
  | 'hasTag' // tag membership
  | 'notHasTag'
  | 'inCollection'
  | 'notInCollection'
  | 'exists' // field has a value (metadata or supported built-in)
  | 'notExists';

export const RULE_OPERATORS: readonly RuleOperator[] = [
  'contains',
  'equals',
  'notEquals',
  'is',
  'isNot',
  'has',
  'notHas',
  'hasTag',
  'notHasTag',
  'inCollection',
  'notInCollection',
  'exists',
  'notExists',
];

/** A leaf: one condition on one field. `value` is null only for exists/notExists. */
export interface RuleCondition {
  kind: 'condition';
  field: RuleFieldRef;
  operator: RuleOperator;
  value: string | null;
}

/** A branch: combine children with AND or OR. */
export interface RuleGroup {
  kind: 'group';
  op: 'and' | 'or';
  children: RuleNode[];
}

export type RuleNode = RuleGroup | RuleCondition;

// ---------------------------------------------------------------------------
// Legal-operator tables — the single source of truth shared by the backend
// validator (rejects illegal field/operator pairs) and the frontend
// OperatorPicker (only offers legal operators). Keep these in sync by deriving
// both sides from here.
// ---------------------------------------------------------------------------

export const LEGAL_OPERATORS_BY_BUILTIN: Record<BuiltinRuleField, readonly RuleOperator[]> = {
  name: ['contains', 'equals'],
  description: ['contains'],
  status: ['is', 'isNot'],
  hasDuplicates: ['is', 'isNot'],
  manualPreview: ['exists', 'notExists'],
  fileType: ['has', 'notHas'],
  collection: ['inCollection', 'notInCollection'],
  tag: ['hasTag', 'notHasTag'],
};

export const LEGAL_OPERATORS_BY_METADATA_TYPE: Record<MetadataFieldType, readonly RuleOperator[]> = {
  text: ['equals', 'notEquals', 'contains', 'exists', 'notExists'],
  url: ['equals', 'notEquals', 'contains', 'exists', 'notExists'],
  enum: ['is', 'isNot', 'exists', 'notExists'],
  // multi_enum values are stored as a comma-joined string, so equality is wrong —
  // only substring (contains) and presence are meaningful in v1.
  multi_enum: ['contains', 'exists', 'notExists'],
  boolean: ['is', 'exists', 'notExists'],
  // number/date: text-safe operators only in v1 (no gt/lt/before/after).
  number: ['equals', 'notEquals', 'exists', 'notExists'],
  date: ['equals', 'notEquals', 'exists', 'notExists'],
};

/** Operators that take no value (the value field must be null). */
export const VALUELESS_OPERATORS: readonly RuleOperator[] = ['exists', 'notExists'];

// Bounds on tree complexity — enforced by the shared validator and re-checked
// server-side. They bound query cost (OR fan-out) and protect against abuse.
export const SMART_COLLECTION_MAX_DEPTH = 3;
export const SMART_COLLECTION_MAX_NODES = 50;
export const SMART_COLLECTION_MAX_CHILDREN = 20;

// ---------------------------------------------------------------------------
// Entity + request shapes
// ---------------------------------------------------------------------------

export interface SmartCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  definition: RuleNode;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SmartCollectionSummary {
  id: string;
  name: string;
  slug: string;
}

export interface SmartCollectionDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  definition: RuleNode;
  /** Count of models the rule tree currently matches (derived on read). */
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSmartCollectionRequest {
  name: string;
  description?: string;
  definition: RuleNode;
}

export interface UpdateSmartCollectionRequest {
  name?: string;
  description?: string | null;
  definition?: RuleNode;
}

/**
 * Body for the dry-run preview endpoint — an unsaved tree plus the read-time
 * pagination/sort knobs reused from model search.
 */
export interface PreviewSmartCollectionRequest {
  definition: RuleNode;
  status?: ModelStatus;
  fileType?: FileType;
  sort?: ModelSearchParams['sort'];
  sortDir?: ModelSearchParams['sortDir'];
  cursor?: string;
  pageSize?: number;
}
