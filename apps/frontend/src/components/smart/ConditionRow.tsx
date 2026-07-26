import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type {
  MetadataFieldDetail,
  RuleFieldRef,
  RuleOperator,
  BuiltinRuleField,
} from '@alexandria/shared';
import {
  LEGAL_OPERATORS_BY_BUILTIN,
  LEGAL_OPERATORS_BY_METADATA_TYPE,
  VALUELESS_OPERATORS,
} from '@alexandria/shared';
import { Select } from '../ui/select';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { getFieldValues } from '../../api/metadata';
import type { DraftCondition } from '../../hooks/use-smart-collection-draft';

// Builtin fields exposed in the composer. `collection` is supported by the rule
// engine but omitted here in v1 (it needs a collection picker, not a raw id).
const BUILTIN_FIELD_OPTIONS: { field: BuiltinRuleField; label: string }[] = [
  { field: 'name', label: 'Name' },
  { field: 'description', label: 'Description' },
  { field: 'tag', label: 'Tag' },
  { field: 'status', label: 'Status' },
  { field: 'hasDuplicates', label: 'Has duplicates' },
  { field: 'fileType', label: 'File type' },
  { field: 'manualPreview', label: 'Manually set preview' },
];

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  contains: 'contains',
  equals: 'is',
  notEquals: 'is not',
  is: 'is',
  isNot: 'is not',
  has: 'has',
  notHas: 'does not have',
  hasTag: 'has tag',
  notHasTag: 'lacks tag',
  inCollection: 'in collection',
  notInCollection: 'not in collection',
  exists: 'is set',
  notExists: 'is not set',
};

const STATUS_OPTIONS = ['ready', 'processing', 'error'];
const FILE_TYPE_OPTIONS = ['stl', 'image', 'document', 'other'];

function fieldKey(f: RuleFieldRef): string {
  return f.source === 'builtin' ? `builtin:${f.field}` : `metadata:${f.slug}`;
}

function parseFieldKey(key: string): RuleFieldRef {
  const [source, rest] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
  return source === 'metadata'
    ? { source: 'metadata', slug: rest }
    : { source: 'builtin', field: rest as BuiltinRuleField };
}

function legalOperators(field: RuleFieldRef, def?: MetadataFieldDetail): readonly RuleOperator[] {
  if (field.source === 'builtin') {
    return LEGAL_OPERATORS_BY_BUILTIN[field.field] ?? [];
  }
  return def ? LEGAL_OPERATORS_BY_METADATA_TYPE[def.type] : ['equals', 'contains', 'exists', 'notExists'];
}

interface Props {
  node: DraftCondition;
  fields: MetadataFieldDetail[];
  onChange: (patch: Partial<Omit<DraftCondition, '_id' | 'kind'>>) => void;
  onRemove: () => void;
}

/** A single rule row: field → operator → value, plus a remove button. */
export function ConditionRow({ node, fields, onChange, onRemove }: Props) {
  const field = node.field;
  const metaDef = field.source === 'metadata' ? fields.find((f) => f.slug === field.slug) : undefined;

  // The 'tags' field is stored in dedicated tables, not model_metadata, so a
  // metadata rule on it matches nothing — the builtin "Tag" field covers it.
  const metadataFieldOptions = fields.filter((f) => f.slug !== 'tags');

  const operators = legalOperators(field, metaDef);
  const valueless = VALUELESS_OPERATORS.includes(node.operator);

  // When the field changes, snap the operator to the first legal one and clear value.
  function handleFieldChange(key: string) {
    const field = parseFieldKey(key);
    const nextDef = field.source === 'metadata' ? fields.find((f) => f.slug === field.slug) : undefined;
    const ops = legalOperators(field, nextDef);
    const operator = ops[0] ?? 'equals';
    onChange({ field, operator, value: VALUELESS_OPERATORS.includes(operator) ? null : '' });
  }

  function handleOperatorChange(op: RuleOperator) {
    onChange({ operator: op, value: VALUELESS_OPERATORS.includes(op) ? null : (node.value ?? '') });
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        className="w-40"
        value={fieldKey(node.field)}
        onChange={(e) => handleFieldChange(e.target.value)}
        aria-label="Field"
      >
        <optgroup label="Built-in">
          {BUILTIN_FIELD_OPTIONS.map((o) => (
            <option key={o.field} value={`builtin:${o.field}`}>
              {o.label}
            </option>
          ))}
        </optgroup>
        {metadataFieldOptions.length > 0 && (
          <optgroup label="Metadata">
            {metadataFieldOptions.map((f) => (
              <option key={f.slug} value={`metadata:${f.slug}`}>
                {f.name}
              </option>
            ))}
          </optgroup>
        )}
      </Select>

      <Select
        className="w-36"
        value={node.operator}
        onChange={(e) => handleOperatorChange(e.target.value as RuleOperator)}
        aria-label="Operator"
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </Select>

      {!valueless && (
        <ValueInput
          field={node.field}
          def={metaDef}
          value={node.value ?? ''}
          onChange={(v) => onChange({ value: v })}
        />
      )}

      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onRemove}
        aria-label="Remove condition"
        className="flex-shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ValueInput({
  field,
  def,
  value,
  onChange,
}: {
  field: RuleFieldRef;
  def?: MetadataFieldDetail;
  value: string;
  onChange: (v: string) => void;
}) {
  // Status / file type — fixed enums
  if (field.source === 'builtin' && field.field === 'status') {
    return <EnumSelect options={STATUS_OPTIONS} value={value} onChange={onChange} />;
  }
  if (field.source === 'builtin' && field.field === 'fileType') {
    return <EnumSelect options={FILE_TYPE_OPTIONS} value={value} onChange={onChange} />;
  }
  if (field.source === 'builtin' && field.field === 'hasDuplicates') {
    return <EnumSelect options={['true', 'false']} value={value} onChange={onChange} />;
  }
  // Metadata enum / boolean
  if (def?.type === 'boolean') {
    return <EnumSelect options={['true', 'false']} value={value} onChange={onChange} />;
  }
  if (def?.type === 'enum' && def.config?.enumOptions?.length) {
    return <EnumSelect options={def.config.enumOptions} value={value} onChange={onChange} />;
  }
  // Tag — free text with a datalist of known tag values
  if (field.source === 'builtin' && field.field === 'tag') {
    return <TagValueInput value={value} onChange={onChange} />;
  }
  return (
    <Input
      className="w-48"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="value"
      aria-label="Value"
    />
  );
}

function EnumSelect({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select className="w-48" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Value">
      <option value="" disabled>
        Select…
      </option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </Select>
  );
}

function TagValueInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data } = useQuery({
    queryKey: ['field-values', 'tags'],
    queryFn: () => getFieldValues('tags'),
    staleTime: 60_000,
  });
  return (
    <>
      <Input
        className="w-48"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="tag name"
        list="smart-tag-values"
        aria-label="Value"
      />
      <datalist id="smart-tag-values">
        {(data ?? []).map((v) => (
          <option key={v.value} value={v.value} />
        ))}
      </datalist>
    </>
  );
}
