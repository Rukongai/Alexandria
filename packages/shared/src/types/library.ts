/** Palette-accent names a library badge can use. */
export const LIBRARY_COLORS = ['amber', 'teal', 'sage', 'plum', 'slate'] as const;
export type LibraryColor = (typeof LIBRARY_COLORS)[number];

export interface Library {
  id: string;
  name: string;
  slug: string;
  userId: string;
  isDefault: boolean;
  color: string;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

/** A library plus the derived counts shown on the All-Libraries cards. */
export interface LibrarySummary extends Library {
  modelCount: number;
  collectionCount: number;
}

export interface CreateLibraryRequest {
  name: string;
  color?: LibraryColor;
}

export interface UpdateLibraryRequest {
  name?: string;
  color?: LibraryColor;
}
