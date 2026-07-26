import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DraftCondition } from '../../hooks/use-smart-collection-draft';
import { ConditionRow } from './ConditionRow';

const manualPreviewField = 'manualPreview';
const hasDuplicatesField = 'hasDuplicates';

function makeNode(overrides: Partial<DraftCondition> = {}): DraftCondition {
  return {
    _id: 'condition-1',
    kind: 'condition',
    field: { source: 'builtin', field: 'name' },
    operator: 'contains',
    value: '',
    ...overrides,
  };
}

describe('ConditionRow', () => {
  it('should clear the value when manually set preview is selected', () => {
    const onChange = vi.fn();
    render(
      <ConditionRow
        node={makeNode()}
        fields={[]}
        onChange={onChange}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Field' }), {
      target: { value: 'builtin:manualPreview' },
    });

    expect(onChange).toHaveBeenCalledWith({
      field: { source: 'builtin', field: manualPreviewField },
      operator: 'exists',
      value: null,
    });
  });

  it('should offer only presence operators without a value input for manually set preview', () => {
    render(
      <ConditionRow
        node={makeNode({
          field: { source: 'builtin', field: manualPreviewField },
          operator: 'exists',
          value: null,
        })}
        fields={[]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    const fieldPicker = screen.getByRole('combobox', { name: 'Field' });
    expect(fieldPicker).toHaveDisplayValue('Manually set preview');

    const operatorPicker = screen.getByRole('combobox', { name: 'Operator' });
    expect(operatorPicker).toHaveTextContent('is set');
    expect(operatorPicker).toHaveTextContent('is not set');
    expect(operatorPicker.querySelectorAll('option')).toHaveLength(2);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.queryByRole('textbox', { name: 'Value' })).not.toBeInTheDocument();
  });

  it('should offer a boolean value for the has duplicates rule', () => {
    render(
      <ConditionRow
        node={makeNode({
          field: { source: 'builtin', field: hasDuplicatesField },
          operator: 'is',
          value: 'true',
        })}
        fields={[]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Field' })).toHaveDisplayValue('Has duplicates');
    expect(screen.getByRole('combobox', { name: 'Value' })).toHaveDisplayValue('true');
    expect(screen.getByRole('combobox', { name: 'Value' })).toHaveTextContent('false');
  });
});
