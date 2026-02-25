import { eq, asc } from 'drizzle-orm';
import type { Library as LibraryApi } from '@alexandria/shared';
import { pathTemplateSchema } from '@alexandria/shared';
import type { CreateLibraryInput, UpdateLibraryInput } from '@alexandria/shared';
import { db } from '../db/index.js';
import type { Database } from '../db/index.js';
import { libraries, models } from '../db/schema/index.js';
import { notFound, conflict, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';

type LibraryRow = typeof libraries.$inferSelect;

const logger = createLogger('LibraryService');

function toLibrary(row: LibraryRow): LibraryApi {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    rootPath: row.rootPath,
    pathTemplate: row.pathTemplate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class LibraryService {
  constructor(private readonly database: Database) {}

  async listLibraries(): Promise<LibraryApi[]> {
    logger.info({ service: 'LibraryService' }, 'Listing all libraries');

    const rows = await this.database
      .select()
      .from(libraries)
      .orderBy(asc(libraries.createdAt));

    return rows.map(toLibrary);
  }

  async getLibraryById(id: string): Promise<LibraryApi> {
    logger.info({ service: 'LibraryService', libraryId: id }, 'Getting library by id');

    const [row] = await this.database
      .select()
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);

    if (!row) {
      throw notFound(`Library not found: ${id}`);
    }

    return toLibrary(row);
  }

  async createLibrary(input: CreateLibraryInput): Promise<LibraryApi> {
    logger.info({ service: 'LibraryService', name: input.name }, 'Creating library');

    const templateResult = pathTemplateSchema.safeParse(input.pathTemplate);
    if (!templateResult.success) {
      throw validationError(
        templateResult.error.errors[0]?.message ?? 'Invalid path template',
        'pathTemplate',
      );
    }

    const slug = generateSlug(input.name);

    let row: LibraryRow;
    try {
      const [inserted] = await this.database
        .insert(libraries)
        .values({
          name: input.name,
          slug,
          rootPath: input.rootPath,
          pathTemplate: input.pathTemplate,
        })
        .returning();
      row = inserted;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        throw conflict(`A library named "${input.name}" already exists`);
      }
      throw err;
    }

    logger.info({ service: 'LibraryService', libraryId: row.id }, 'Library created');

    return toLibrary(row);
  }

  async updateLibrary(id: string, input: UpdateLibraryInput): Promise<LibraryApi> {
    logger.info({ service: 'LibraryService', libraryId: id }, 'Updating library');

    const [current] = await this.database
      .select()
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);

    if (!current) {
      throw notFound(`Library not found: ${id}`);
    }

    if (input.pathTemplate !== undefined) {
      const templateResult = pathTemplateSchema.safeParse(input.pathTemplate);
      if (!templateResult.success) {
        throw validationError(
          templateResult.error.errors[0]?.message ?? 'Invalid path template',
          'pathTemplate',
        );
      }
    }

    const updateValues: Partial<{
      name: string;
      rootPath: string;
      pathTemplate: string;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (input.name !== undefined) updateValues.name = input.name;
    // NOTE: Updating rootPath or pathTemplate does not retroactively re-path models
    // already stored at the old path. This is a known limitation for MVP.
    if (input.rootPath !== undefined) updateValues.rootPath = input.rootPath;
    if (input.pathTemplate !== undefined) updateValues.pathTemplate = input.pathTemplate;

    let updated: LibraryRow;
    try {
      const [result] = await this.database
        .update(libraries)
        .set(updateValues)
        .where(eq(libraries.id, id))
        .returning();
      updated = result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        throw conflict(`A library named "${input.name}" already exists`);
      }
      throw err;
    }

    logger.info({ service: 'LibraryService', libraryId: id }, 'Library updated');

    return toLibrary(updated);
  }

  async deleteLibrary(id: string): Promise<void> {
    logger.info({ service: 'LibraryService', libraryId: id }, 'Deleting library');

    const [row] = await this.database
      .select({ id: libraries.id })
      .from(libraries)
      .where(eq(libraries.id, id))
      .limit(1);

    if (!row) {
      throw notFound(`Library not found: ${id}`);
    }

    await this.database.delete(libraries).where(eq(libraries.id, id));

    logger.info({ service: 'LibraryService', libraryId: id }, 'Library deleted');
  }

  // Returns model IDs for models assigned to a library.
  // Full model card assembly (thumbnails, metadata) requires PresenterService
  // integration and is deferred to a future phase.
  async getModelsByLibraryId(libraryId: string): Promise<string[]> {
    logger.info({ service: 'LibraryService', libraryId }, 'Getting models by library id');

    const rows = await this.database
      .select({ id: models.id })
      .from(models)
      .where(eq(models.libraryId, libraryId))
      .orderBy(asc(models.createdAt));

    return rows.map((r) => r.id);
  }
}

export const libraryService = new LibraryService(db);
