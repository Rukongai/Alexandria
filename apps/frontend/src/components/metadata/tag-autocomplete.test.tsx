import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MetadataFieldValue } from '@alexandria/shared';
import { TagAutocomplete } from './tag-autocomplete';

const suggestions: MetadataFieldValue[] = [
  { value: 'Dragon', modelCount: 8 },
  { value: 'Forest', modelCount: 5 },
  { value: 'Terrain', modelCount: 3 },
];

function Harness({ initialValue = [] }: { initialValue?: string[] }) {
  const [value, setValue] = useState(initialValue);
  const [inputValue, setInputValue] = useState('');

  return (
    <>
      <TagAutocomplete
        value={value}
        onChange={setValue}
        inputValue={inputValue}
        onInputChange={setInputValue}
        suggestions={suggestions}
        inputAriaLabel="Tag name"
      />
      <button type="button">After tags</button>
    </>
  );
}

describe('TagAutocomplete', () => {
  it('should filter suggestions case-insensitively and exclude selected tags', async () => {
    const user = userEvent.setup();
    render(<Harness initialValue={['dragon']} />);

    await user.type(screen.getByRole('combobox', { name: 'Tag name' }), 'ORE');

    expect(screen.getByRole('option', { name: /Forest/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Dragon/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Terrain/ })).not.toBeInTheDocument();
  });

  it('should add a suggestion when it is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    await user.click(input);
    await user.click(screen.getByRole('option', { name: /Dragon/ }));

    expect(screen.getByRole('button', { name: 'Remove tag Dragon' })).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('should add a highlighted suggestion with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    await user.click(input);
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(screen.getByRole('option', { name: /Forest/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Remove tag Forest' })).toBeInTheDocument();
    expect(input).toHaveValue('');
  });

  it('should navigate suggestions upward from the first option', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    await user.click(input);
    await user.keyboard('{ArrowUp}{Enter}');

    expect(screen.getByRole('button', { name: 'Remove tag Terrain' })).toBeInTheDocument();
  });

  it('should create free-form tags with Enter or comma and reject case-insensitive duplicates', async () => {
    const user = userEvent.setup();
    render(<Harness initialValue={['Forest']} />);

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    await user.type(input, 'New tag{Enter}');
    expect(screen.getByRole('button', { name: 'Remove tag New tag' })).toBeInTheDocument();

    await user.type(input, 'Another tag,');
    expect(screen.getByRole('button', { name: 'Remove tag Another tag' })).toBeInTheDocument();

    await user.type(input, 'forest{Enter}');
    expect(screen.getAllByRole('button', { name: /Remove tag Forest/i })).toHaveLength(1);
    expect(input).toHaveValue('');
  });

  it('should skip listbox options when tabbing away from the combobox', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole('combobox', { name: 'Tag name' });
    await user.click(input);

    for (const option of screen.getAllByRole('option')) {
      expect(option).toHaveAttribute('tabindex', '-1');
    }

    await user.tab();
    expect(screen.getByRole('button', { name: 'After tags' })).toHaveFocus();
  });
});
