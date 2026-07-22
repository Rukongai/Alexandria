import * as React from 'react';
import { Plus, Tag, X } from 'lucide-react';
import type { MetadataFieldValue } from '@alexandria/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface TagAutocompleteProps {
  value: string[];
  onChange: (value: string[]) => void;
  inputValue: string;
  onInputChange: (value: string) => void;
  suggestions: MetadataFieldValue[];
  placeholder?: string;
  inputAriaLabel?: string;
  autoFocus?: boolean;
  showAddButton?: boolean;
  className?: string;
  inputClassName?: string;
  chipClassName?: string;
}

const MAX_SUGGESTIONS = 6;

function normalizeTag(tag: string) {
  return tag.trim().toLowerCase();
}

export function TagAutocomplete({
  value,
  onChange,
  inputValue,
  onInputChange,
  suggestions,
  placeholder = 'Add or create tags',
  inputAriaLabel = 'Tag name',
  autoFocus,
  showAddButton = false,
  className,
  inputClassName,
  chipClassName,
}: TagAutocompleteProps) {
  const listboxId = React.useId();
  const [focused, setFocused] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const selectedKeys = React.useMemo(
    () => new Set(value.map(normalizeTag)),
    [value],
  );
  const query = normalizeTag(inputValue);
  const filteredSuggestions = suggestions
    .filter((suggestion) => !selectedKeys.has(normalizeTag(suggestion.value)))
    .filter((suggestion) => !query || normalizeTag(suggestion.value).includes(query))
    .slice(0, MAX_SUGGESTIONS);
  const isOpen = focused && filteredSuggestions.length > 0;

  React.useEffect(() => {
    setActiveIndex((current) =>
      current >= filteredSuggestions.length ? filteredSuggestions.length - 1 : current,
    );
  }, [filteredSuggestions.length]);

  function addTag(rawTag: string) {
    const tag = rawTag.trim();
    if (!tag || selectedKeys.has(normalizeTag(tag))) {
      onInputChange('');
      setActiveIndex(-1);
      return;
    }

    onChange([...value, tag]);
    onInputChange('');
    setActiveIndex(-1);
  }

  function removeTag(tag: string) {
    onChange(value.filter((item) => item !== tag));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && filteredSuggestions.length > 0) {
      event.preventDefault();
      setFocused(true);
      setActiveIndex((current) => (current + 1) % filteredSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp' && filteredSuggestions.length > 0) {
      event.preventDefault();
      setFocused(true);
      setActiveIndex((current) =>
        current <= 0 ? filteredSuggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === 'Escape') {
      setFocused(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (event.key === 'Enter' && activeIndex >= 0) {
        addTag(filteredSuggestions[activeIndex].value);
      } else {
        addTag(inputValue);
      }
    }
  }

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-1.5', className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setActiveIndex(-1);
        }
      }}
    >
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <span
              key={tag}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full bg-secondary px-2 text-xs font-medium text-secondary-foreground',
                chipClassName,
              )}
            >
              <Tag className="h-3 w-3" aria-hidden="true" />
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                aria-label={`Remove tag ${tag}`}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-1">
        <Input
          value={inputValue}
          onChange={(event) => {
            onInputChange(event.target.value);
            setFocused(true);
            setActiveIndex(-1);
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={inputAriaLabel}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-activedescendant={
            isOpen && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          autoFocus={autoFocus}
          className={inputClassName}
        />
        {showAddButton && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => addTag(inputValue)}
            aria-label="Add tag"
            className="h-7 px-2"
          >
            <Plus className="h-3 w-3" />
          </Button>
        )}
      </div>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Tag suggestions"
          className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filteredSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.value}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={activeIndex === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(suggestion.value)}
              className={cn(
                'flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                activeIndex === index && 'bg-accent',
              )}
            >
              <span className="truncate">{suggestion.value}</span>
              <span className="ml-3 text-xs tabular-nums text-muted-foreground">
                {suggestion.modelCount}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
