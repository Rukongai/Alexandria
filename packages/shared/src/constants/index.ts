export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff'] as const;
export const SUPPORTED_DOCUMENT_FORMATS = ['pdf', 'txt', 'md'] as const;
export const STL_EXTENSIONS = ['stl'] as const;

export const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.tgz', '.zip', '.rar', '.7z'] as const;
export type SupportedArchiveExtension = typeof SUPPORTED_ARCHIVE_EXTENSIONS[number];

export const THUMBNAIL_SIZES = {
  grid: { width: 400, height: 400 },
  detail: { width: 800, height: 800 },
} as const;

export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  IMPORT_FAILED: 'IMPORT_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const DEFAULT_METADATA_FIELDS = [
  { name: 'Tags', slug: 'tags', type: 'multi_enum' as const, isFilterable: true, isBrowsable: true },
  { name: 'Artist', slug: 'artist', type: 'text' as const, isFilterable: true, isBrowsable: true },
  { name: 'Year', slug: 'year', type: 'number' as const, isFilterable: true, isBrowsable: false },
  { name: 'NSFW', slug: 'nsfw', type: 'boolean' as const, isFilterable: true, isBrowsable: false },
  { name: 'URL', slug: 'url', type: 'url' as const, isFilterable: false, isBrowsable: false },
  { name: 'Pre-supported', slug: 'pre-supported', type: 'boolean' as const, isFilterable: true, isBrowsable: false },
] as const;
