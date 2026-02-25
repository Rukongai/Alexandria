import { z } from 'zod';

function validatePathTemplate(template: string): boolean {
  if (!template) return false;

  const tokenPattern = /\{([^}]+)\}/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(template)) !== null) {
    tokens.push(match[1]);
  }

  if (tokens.length === 0) return false;

  if (!tokens.includes('library')) return false;

  if (tokens[tokens.length - 1] !== 'model') return false;

  const libraryIndex = tokens.indexOf('library');

  if (libraryIndex !== 0) return false;

  const metadataSlugPattern = /^metadata\.[a-z0-9-]+$/;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (!metadataSlugPattern.test(tokens[i])) return false;
  }

  return true;
}

export const pathTemplateSchema = z
  .string()
  .min(1)
  .refine(validatePathTemplate, {
    message:
      'Path template must start with {library}, end with {model}, and intermediate tokens must be {metadata.<slug>} where slug is lowercase alphanumeric + hyphens',
  });

export const createLibrarySchema = z.object({
  name: z.string().min(1).max(255),
  rootPath: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('/'), { message: 'rootPath must be an absolute path starting with /' }),
  pathTemplate: pathTemplateSchema,
});

export const updateLibrarySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    rootPath: z
      .string()
      .min(1)
      .refine((v) => v.startsWith('/'), { message: 'rootPath must be an absolute path starting with /' })
      .optional(),
    pathTemplate: pathTemplateSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export type CreateLibraryInput = z.infer<typeof createLibrarySchema>;
export type UpdateLibraryInput = z.infer<typeof updateLibrarySchema>;
