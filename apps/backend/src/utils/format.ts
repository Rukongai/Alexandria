import type { MetadataFieldType } from '@alexandria/shared';

/**
 * Format a metadata value for display. Centralised utility — all consumers
 * should reference this function rather than maintaining their own copy.
 */
export function formatDisplayValue(
  type: MetadataFieldType,
  value: string | string[],
): string {
  if (type === 'boolean') {
    return value === 'true' ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value;
}
