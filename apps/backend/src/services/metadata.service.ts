import { eq, and, desc, sql } from 'drizzle-orm';
import type {
  MetadataFieldDetail,
  MetadataFieldValue,
  MetadataValue,
  MetadataFieldType,
  MetadataFieldConfig,
  CreateMetadataFieldRequest,
  UpdateMetadataFieldRequest,
  SetModelMetadataRequest,
  BulkMetadataOperation,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { models, metadataFieldDefinitions, modelMetadata } from '../db/schema/index.js';
import { tags, modelTags } from '../db/schema/index.js';
import type { MetadataFieldDefinition as MetadataFieldDefinitionRow } from '../db/schema/metadata.js';
import { notFound, forbidden } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';
import { formatDisplayValue } from '../utils/format.js';

const logger = createLogger('MetadataService');

// Map a DB row to the API-facing MetadataFieldDetail shape.
function toFieldDetail(row: MetadataFieldDefinitionRow): MetadataFieldDetail {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as MetadataFieldType,
    isDefault: row.isDefault,
    isFilterable: row.isFilterable,
    isBrowsable: row.isBrowsable,
    config: (row.config as MetadataFieldConfig | null) ?? null,
    sortOrder: row.sortOrder,
  };
}

export class MetadataService {
  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isTagField(field: MetadataFieldDefinitionRow): boolean {
    return (
      field.slug === 'tags' &&
      field.type === 'multi_enum' &&
      field.isDefault === true
    );
  }

  private coerceToString(value: string | string[] | number | boolean): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.join(',');
    return value;
  }

  // ---------------------------------------------------------------------------
  // Field Definition CRUD
  // ---------------------------------------------------------------------------

  async listFields(): Promise<MetadataFieldDetail[]> {
    logger.debug({ service: 'MetadataService' }, 'Listing all metadata field definitions');

    const rows = await db
      .select()
      .from(metadataFieldDefinitions)
      .orderBy(metadataFieldDefinitions.sortOrder, metadataFieldDefinitions.createdAt);

    return rows.map(toFieldDetail);
  }

  async getFieldBySlug(slug: string): Promise<MetadataFieldDefinitionRow> {
    const [row] = await db
      .select()
      .from(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.slug, slug))
      .limit(1);

    if (!row) {
      throw notFound(`Metadata field not found: ${slug}`);
    }

    return row;
  }

  async getFieldById(id: string): Promise<MetadataFieldDefinitionRow> {
    const [row] = await db
      .select()
      .from(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.id, id))
      .limit(1);

    if (!row) {
      throw notFound(`Metadata field not found: ${id}`);
    }

    return row;
  }

  async createField(data: CreateMetadataFieldRequest): Promise<MetadataFieldDetail> {
    const slug = generateSlug(data.name);

    logger.info(
      { service: 'MetadataService', slug, type: data.type },
      'Creating metadata field definition',
    );

    const [row] = await db
      .insert(metadataFieldDefinitions)
      .values({
        name: data.name,
        slug,
        type: data.type,
        isDefault: false,
        isFilterable: data.isFilterable ?? false,
        isBrowsable: data.isBrowsable ?? false,
        config: data.config ?? null,
        sortOrder: 0,
      })
      .returning();

    logger.info(
      { service: 'MetadataService', fieldId: row.id, slug: row.slug },
      'Metadata field definition created',
    );

    return toFieldDetail(row);
  }

  async updateField(
    id: string,
    data: UpdateMetadataFieldRequest,
  ): Promise<MetadataFieldDetail> {
    // Verify exists first
    await this.getFieldById(id);

    logger.info(
      { service: 'MetadataService', fieldId: id },
      'Updating metadata field definition',
    );

    const updateValues: Partial<{
      name: string;
      isFilterable: boolean;
      isBrowsable: boolean;
      config: MetadataFieldConfig | null;
    }> = {};

    if (data.name !== undefined) updateValues.name = data.name;
    if (data.isFilterable !== undefined) updateValues.isFilterable = data.isFilterable;
    if (data.isBrowsable !== undefined) updateValues.isBrowsable = data.isBrowsable;
    if (data.config !== undefined) updateValues.config = data.config;

    const [row] = await db
      .update(metadataFieldDefinitions)
      .set(updateValues)
      .where(eq(metadataFieldDefinitions.id, id))
      .returning();

    return toFieldDetail(row);
  }

  async deleteField(id: string): Promise<void> {
    const field = await this.getFieldById(id);

    if (field.isDefault) {
      throw forbidden(
        `Cannot delete default metadata field: ${field.name}`,
      );
    }

    logger.info(
      { service: 'MetadataService', fieldId: id, slug: field.slug },
      'Deleting metadata field definition',
    );

    await db
      .delete(metadataFieldDefinitions)
      .where(eq(metadataFieldDefinitions.id, id));
  }

  // ---------------------------------------------------------------------------
  // Metadata Value Operations
  // ---------------------------------------------------------------------------

  async getModelMetadata(modelId: string): Promise<MetadataValue[]> {
    logger.debug(
      { service: 'MetadataService', modelId },
      'Loading metadata for model',
    );

    const results: MetadataValue[] = [];

    // 1. Load generic model_metadata values joined with field definitions
    const genericRows = await db
      .select({
        fieldSlug: metadataFieldDefinitions.slug,
        fieldName: metadataFieldDefinitions.name,
        fieldType: metadataFieldDefinitions.type,
        value: modelMetadata.value,
      })
      .from(modelMetadata)
      .innerJoin(
        metadataFieldDefinitions,
        eq(modelMetadata.fieldDefinitionId, metadataFieldDefinitions.id),
      )
      .where(eq(modelMetadata.modelId, modelId));

    for (const row of genericRows) {
      const type = row.fieldType as MetadataFieldType;
      const value = row.value;
      results.push({
        fieldSlug: row.fieldSlug,
        fieldName: row.fieldName,
        type,
        value,
        displayValue: formatDisplayValue(type, value),
      });
    }

    // 2. Load tags via model_tags join, if any exist for this model
    const tagRows = await db
      .select({
        name: tags.name,
      })
      .from(modelTags)
      .innerJoin(tags, eq(modelTags.tagId, tags.id))
      .where(eq(modelTags.modelId, modelId));

    if (tagRows.length > 0) {
      const tagNames = tagRows.map((r) => r.name);
      results.push({
        fieldSlug: 'tags',
        fieldName: 'Tags',
        type: 'multi_enum',
        value: tagNames,
        displayValue: formatDisplayValue('multi_enum', tagNames),
      });
    }

    return results;
  }

  async setModelMetadata(
    modelId: string,
    data: SetModelMetadataRequest,
  ): Promise<void> {
    // Verify the model exists before writing metadata
    const [model] = await db
      .select({ id: models.id })
      .from(models)
      .where(eq(models.id, modelId))
      .limit(1);

    if (!model) {
      throw notFound(`Model not found: ${modelId}`);
    }

    logger.info(
      { service: 'MetadataService', modelId },
      'Setting metadata for model',
    );

    for (const [fieldSlug, rawValue] of Object.entries(data)) {
      const field = await this.getFieldBySlug(fieldSlug);

      if (rawValue === null) {
        // Remove metadata for this field
        if (this.isTagField(field)) {
          await db.delete(modelTags).where(eq(modelTags.modelId, modelId));
          logger.debug(
            { service: 'MetadataService', modelId, fieldSlug },
            'Removed all model tags',
          );
        } else {
          await db
            .delete(modelMetadata)
            .where(
              and(
                eq(modelMetadata.modelId, modelId),
                eq(modelMetadata.fieldDefinitionId, field.id),
              ),
            );
          logger.debug(
            { service: 'MetadataService', modelId, fieldSlug },
            'Removed model metadata value',
          );
        }
        continue;
      }

      if (this.isTagField(field)) {
        // Tags must be an array of tag name strings
        const tagNames = Array.isArray(rawValue)
          ? (rawValue as string[])
          : [String(rawValue)];

        // Find-or-create each tag, collecting tag IDs
        const tagIds: string[] = [];
        for (const tagName of tagNames) {
          const trimmedName = tagName.trim();
          if (!trimmedName) continue;

          const [existingTag] = await db
            .select({ id: tags.id })
            .from(tags)
            .where(sql`lower(${tags.name}) = lower(${trimmedName})`)
            .limit(1);

          if (existingTag) {
            tagIds.push(existingTag.id);
          } else {
            const tagSlug = generateSlug(trimmedName);
            const [newTag] = await db
              .insert(tags)
              .values({ name: trimmedName, slug: tagSlug })
              .returning({ id: tags.id });
            tagIds.push(newTag.id);
            logger.debug(
              { service: 'MetadataService', tagName: trimmedName, tagSlug },
              'Created new tag',
            );
          }
        }

        // Replace all existing model_tags for this model
        await db.delete(modelTags).where(eq(modelTags.modelId, modelId));

        if (tagIds.length > 0) {
          await db.insert(modelTags).values(
            tagIds.map((tagId) => ({ modelId, tagId })),
          );
        }

        logger.debug(
          { service: 'MetadataService', modelId, tagCount: tagIds.length },
          'Updated model tags',
        );
      } else {
        // Generic field — upsert into model_metadata
        const stringValue = this.coerceToString(
          rawValue as string | string[] | number | boolean,
        );

        await db
          .insert(modelMetadata)
          .values({
            modelId,
            fieldDefinitionId: field.id,
            value: stringValue,
          })
          .onConflictDoUpdate({
            target: [modelMetadata.modelId, modelMetadata.fieldDefinitionId],
            set: { value: stringValue },
          });

        logger.debug(
          { service: 'MetadataService', modelId, fieldSlug },
          'Upserted model metadata value',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Value Listing
  // ---------------------------------------------------------------------------

  async listFieldValues(slug: string): Promise<MetadataFieldValue[]> {
    const field = await this.getFieldBySlug(slug);

    logger.debug(
      { service: 'MetadataService', slug },
      'Listing known values for metadata field',
    );

    if (this.isTagField(field)) {
      // Count models per tag
      const rows = await db
        .select({
          value: tags.name,
          modelCount: sql<number>`cast(count(${modelTags.modelId}) as int)`,
        })
        .from(tags)
        .innerJoin(modelTags, eq(modelTags.tagId, tags.id))
        .groupBy(tags.id, tags.name)
        .orderBy(desc(sql`count(${modelTags.modelId})`));

      return rows.map((r) => ({ value: r.value, modelCount: r.modelCount }));
    }

    // Generic field — group by value in model_metadata
    const rows = await db
      .select({
        value: modelMetadata.value,
        modelCount: sql<number>`cast(count(distinct ${modelMetadata.modelId}) as int)`,
      })
      .from(modelMetadata)
      .where(eq(modelMetadata.fieldDefinitionId, field.id))
      .groupBy(modelMetadata.value)
      .orderBy(desc(sql`count(distinct ${modelMetadata.modelId})`));

    return rows.map((r) => ({ value: r.value, modelCount: r.modelCount }));
  }

  // ---------------------------------------------------------------------------
  // Bulk Operations
  // ---------------------------------------------------------------------------

  async bulkSetMetadata(
    modelIds: string[],
    operations: BulkMetadataOperation[],
  ): Promise<void> {
    logger.info(
      {
        service: 'MetadataService',
        modelCount: modelIds.length,
        operationCount: operations.length,
      },
      'Starting bulk metadata update',
    );

    for (const modelId of modelIds) {
      const data: SetModelMetadataRequest = {};

      for (const operation of operations) {
        if (operation.action === 'remove') {
          data[operation.fieldSlug] = null;
        } else {
          // action === 'set'
          data[operation.fieldSlug] =
            operation.value !== undefined
              ? (operation.value as string | string[] | number | boolean)
              : null;
        }
      }

      await this.setModelMetadata(modelId, data);
    }

    logger.info(
      {
        service: 'MetadataService',
        modelCount: modelIds.length,
        operationCount: operations.length,
      },
      'Bulk metadata update complete',
    );
  }
}

export const metadataService = new MetadataService();
