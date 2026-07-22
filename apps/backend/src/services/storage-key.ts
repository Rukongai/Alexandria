import { storageError } from '../utils/errors.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function validateStorageKey(key: string): string {
  if (key.length === 0) {
    throw storageError('Storage key must not be empty');
  }
  if (key.startsWith('/') || key.includes('\\') || CONTROL_CHARACTERS.test(key)) {
    throw storageError(`Invalid storage key: ${key}`);
  }

  const segments = key.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw storageError(`Invalid storage key: ${key}`);
  }

  const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  if (!normalized) {
    throw storageError('Storage key must not be empty');
  }

  return normalized;
}

export function normalizeStoragePrefix(prefix: string | undefined): string {
  if (!prefix) return '';

  return validateStorageKey(prefix);
}
