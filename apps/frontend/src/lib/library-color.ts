import { LIBRARY_COLORS, type LibraryColor } from '@alexandria/shared';

export { LIBRARY_COLORS };
export type { LibraryColor };

/**
 * CSS gradient + on-color text for each library accent. amber/teal reuse the ax
 * design tokens; sage/plum/slate are given explicit stops (no ax accent vars
 * exist for them). Rendered as the square badge on the cards and rail switcher.
 */
const GRADIENTS: Record<string, { background: string; color: string }> = {
  amber: {
    background: 'linear-gradient(135deg, var(--ax-amber) 0%, var(--ax-amber-deep) 100%)',
    color: 'var(--ax-amber-fg)',
  },
  teal: {
    background: 'linear-gradient(135deg, var(--ax-teal) 0%, var(--ax-teal-deep) 100%)',
    color: 'var(--ax-teal-fg)',
  },
  sage: { background: 'linear-gradient(135deg, #6f9e7b 0%, #4a7d57 100%)', color: '#fff' },
  plum: { background: 'linear-gradient(135deg, #9d6ba0 0%, #6f4a7d 100%)', color: '#fff' },
  slate: { background: 'linear-gradient(135deg, #6b7a9e 0%, #45527a 100%)', color: '#fff' },
};

export function libraryGradient(color: string): { background: string; color: string } {
  return GRADIENTS[color] ?? GRADIENTS.amber;
}

/** Two-letter monogram from a library name for the badge. */
export function libraryInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'L';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
