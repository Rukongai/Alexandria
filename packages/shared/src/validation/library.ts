import { z } from 'zod';
import { LIBRARY_COLORS, type LibraryColor } from '../types/library.js';

const colorEnum = z.enum(LIBRARY_COLORS as unknown as [LibraryColor, ...LibraryColor[]]);

export const createLibrarySchema = z.object({
  name: z.string().trim().min(1).max(255),
  color: colorEnum.optional(),
});

export const updateLibrarySchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    color: colorEnum.optional(),
  })
  .refine((d) => d.name !== undefined || d.color !== undefined, {
    message: 'At least one field must be provided',
  });
