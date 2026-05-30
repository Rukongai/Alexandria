import { z } from 'zod';
import {
  RULE_OPERATORS,
  BUILTIN_RULE_FIELDS,
  VALUELESS_OPERATORS,
  LEGAL_OPERATORS_BY_BUILTIN,
  SMART_COLLECTION_MAX_DEPTH,
  SMART_COLLECTION_MAX_NODES,
  SMART_COLLECTION_MAX_CHILDREN,
  type RuleNode,
  type RuleGroup,
  type RuleCondition,
  type RuleOperator,
  type BuiltinRuleField,
} from '../types/smart-collection.js';

const operatorEnum = z.enum(RULE_OPERATORS as unknown as [RuleOperator, ...RuleOperator[]]);
const builtinFieldEnum = z.enum(
  BUILTIN_RULE_FIELDS as unknown as [BuiltinRuleField, ...BuiltinRuleField[]],
);

const ruleFieldRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('builtin'), field: builtinFieldEnum }),
  z.object({ source: z.literal('metadata'), slug: z.string().min(1).max(255) }),
]);

// Leaf condition. Semantic checks that depend on the operator (value presence,
// builtin operator legality) are done in the tree walker below, not here, so
// the node schemas stay plain objects usable inside z.union.
const ruleConditionSchema = z.object({
  kind: z.literal('condition'),
  field: ruleFieldRefSchema,
  operator: operatorEnum,
  value: z.string().max(500).nullable(),
});

// Recursive node schema. Nested groups must be non-empty (min 1) — an empty
// nested group has an ambiguous AND/OR identity. The only legal empty group is
// the root (see rootGroupSchema), which means "match everything".
const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([ruleConditionSchema, nestedGroupSchema]),
);

const nestedGroupSchema: z.ZodType<RuleGroup> = z.object({
  kind: z.literal('group'),
  op: z.enum(['and', 'or']),
  children: z.array(ruleNodeSchema).min(1).max(SMART_COLLECTION_MAX_CHILDREN),
});

// Root may be a bare condition or a group; the root group may be empty.
const rootGroupSchema = z.object({
  kind: z.literal('group'),
  op: z.enum(['and', 'or']),
  children: z.array(ruleNodeSchema).max(SMART_COLLECTION_MAX_CHILDREN),
});

/** Validate one leaf's operator/value/field coherence. */
function validateCondition(node: RuleCondition, ctx: z.RefinementCtx, path: (string | number)[]): void {
  const valueless = VALUELESS_OPERATORS.includes(node.operator);
  if (valueless && node.value !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Operator '${node.operator}' takes no value`,
      path: [...path, 'value'],
    });
  }
  if (!valueless && (node.value === null || node.value.trim() === '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Operator '${node.operator}' requires a value`,
      path: [...path, 'value'],
    });
  }
  // Builtin field/operator legality is knowable without a DB. Metadata
  // field/operator legality depends on the field's type and is checked
  // server-side once the field definition is resolved.
  if (node.field.source === 'builtin') {
    const legal = LEGAL_OPERATORS_BY_BUILTIN[node.field.field];
    if (!legal.includes(node.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Operator '${node.operator}' is not valid for field '${node.field.field}'`,
        path: [...path, 'operator'],
      });
    }
  }
}

/**
 * Walk the whole tree once: enforce depth and total node count, and run
 * per-condition semantic checks. `groupDepth` counts group nesting (root group
 * = 1); conditions do not add depth.
 */
function walkTree(
  node: RuleNode,
  groupDepth: number,
  counter: { n: number; flagged: boolean },
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  counter.n += 1;
  if (counter.n > SMART_COLLECTION_MAX_NODES && !counter.flagged) {
    counter.flagged = true;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Rule tree exceeds the maximum of ${SMART_COLLECTION_MAX_NODES} nodes`,
      path,
    });
  }

  if (node.kind === 'group') {
    if (groupDepth > SMART_COLLECTION_MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Rule tree exceeds the maximum nesting depth of ${SMART_COLLECTION_MAX_DEPTH}`,
        path,
      });
      return;
    }
    node.children.forEach((child, i) =>
      walkTree(child, groupDepth + 1, counter, ctx, [...path, 'children', i]),
    );
  } else {
    validateCondition(node, ctx, path);
  }
}

/**
 * A complete smart-collection rule tree definition. An empty root group means
 * "match every model in the library".
 */
export const smartCollectionDefinitionSchema = z
  .union([ruleConditionSchema, rootGroupSchema])
  .superRefine((node, ctx) => {
    walkTree(node as RuleNode, 1, { n: 0, flagged: false }, ctx, []);
  });

export const createSmartCollectionSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  definition: smartCollectionDefinitionSchema,
});

export const updateSmartCollectionSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    definition: smartCollectionDefinitionSchema.optional(),
  })
  .refine((d) => d.name !== undefined || d.description !== undefined || d.definition !== undefined, {
    message: 'At least one field must be provided',
  });

export const previewSmartCollectionSchema = z.object({
  definition: smartCollectionDefinitionSchema,
  status: z.enum(['processing', 'ready', 'error']).optional(),
  fileType: z.enum(['stl', 'image', 'document', 'other']).optional(),
  sort: z.enum(['name', 'createdAt', 'totalSizeBytes']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().optional(),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
