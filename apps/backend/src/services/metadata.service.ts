import { eq, and, desc, inArray, sql } from 'drizzle-orm';
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
import type { DatabaseExecutor } from '../db/index.js';
import { models, metadataFieldDefinitions, modelMetadata } from '../db/schema/index.js';
import { tags, modelTags } from '../db/schema/index.js';
import type { MetadataFieldDefinition as MetadataFieldDefinitionRow } from '../db/schema/metadata.js';
import { notFound, forbidden, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { generateSlug } from '../utils/slug.js';
import { formatDisplayValue } from '../utils/format.js';
import { RE2 } from 're2-wasm';

const logger = createLogger('MetadataService');
const MAX_METADATA_STRING_LENGTH = 10_000;
const MAX_METADATA_ARRAY_ITEMS = 100;
const MAX_VALIDATION_PATTERN_LENGTH = 512;
const MAX_TAG_NAME_LENGTH = 255;
const MAX_BULK_MODELS = 500;
const MAX_BULK_METADATA_OPERATIONS = 25;

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

  private normalizeTagNames(value: unknown, requireAtLeastOne: boolean): string[] {
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) {
      throw validationError('Tags must be an array of strings');
    }
    if (requireAtLeastOne && values.length === 0) {
      throw validationError('Add operations require one or more tag names');
    }

    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const item of values) {
      const name = (item as string).trim();
      if (!name) throw validationError('Tag names cannot be blank');
      if (name.length > MAX_TAG_NAME_LENGTH) {
        throw validationError(`Tag names must be at most ${MAX_TAG_NAME_LENGTH} characters`);
      }
      if (generateSlug(name).length > MAX_TAG_NAME_LENGTH) {
        throw validationError(`Generated tag slugs must be at most ${MAX_TAG_NAME_LENGTH} characters`);
      }
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(name);
      }
    }
    if (requireAtLeastOne && normalized.length === 0) {
      throw validationError('Add operations require one or more tag names');
    }
    return normalized;
  }

  private coerceToString(value: string | string[] | number | boolean): string {
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.join(',');
    return value;
  }

  /** Validate one metadata value against its configured field definition. */
  validateFieldValue(field: MetadataFieldDefinitionRow, value: unknown): void {
    if (value === null) return;
    const config = (field.config as MetadataFieldConfig | null) ?? null;
    const invalid = (message: string): never => {
      throw validationError(message, field.slug);
    };

    if (typeof value === 'string' && value.length > MAX_METADATA_STRING_LENGTH) {
      invalid(`Value must be at most ${MAX_METADATA_STRING_LENGTH} characters`);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_METADATA_ARRAY_ITEMS) {
        invalid(`Value must contain at most ${MAX_METADATA_ARRAY_ITEMS} items`);
      }
      if (value.some((item) => typeof item === 'string'
        && item.length > MAX_METADATA_STRING_LENGTH)) {
        invalid(`Each value must be at most ${MAX_METADATA_STRING_LENGTH} characters`);
      }
    }

    if (field.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid('Value must be a finite number');
      return;
    }
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') invalid('Value must be a boolean');
      return;
    }
    if (field.type === 'date') {
      if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
        invalid('Value must be a valid date');
      }
      return;
    }
    if (field.type === 'url') {
      if (typeof value !== 'string') invalid('Value must be an HTTP or HTTPS URL');
      const stringValue = value as string;
      try {
        const parsed = new URL(stringValue);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          invalid('Value must be an HTTP or HTTPS URL');
        }
      } catch {
        invalid('Value must be an HTTP or HTTPS URL');
      }
      return;
    }
    if (field.type === 'multi_enum') {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        invalid('Value must be an array of strings');
      }
      const values = value as string[];
      if (config?.enumOptions && values.some((item) => !config.enumOptions!.includes(item))) {
        invalid('Value contains an option that is not allowed');
      }
      return;
    }
    if (typeof value !== 'string') invalid('Value must be a string');
    const stringValue = value as string;
    if (field.type === 'enum' && config?.enumOptions && !config.enumOptions.includes(stringValue)) {
      invalid('Value is not an allowed option');
    }
    if (field.type === 'text' && config?.validationPattern) {
      if (config.validationPattern.length > MAX_VALIDATION_PATTERN_LENGTH) {
        invalid('Metadata field validation pattern is too long');
      }
      let pattern: RE2 | null = null;
      try {
        // RE2 uses a non-backtracking engine, providing linear-time matching
        // for user-configured patterns. Unsupported constructs such as
        // backreferences and lookarounds are rejected instead of falling back
        // to JavaScript's potentially exponential RegExp implementation.
        pattern = new RE2(config.validationPattern, 'u');
      } catch {
        invalid('Metadata field has an invalid validation pattern');
      }
      if (!pattern || !pattern.test(stringValue)) invalid('Value does not match the required format');
    }
  }

  /** Normalize special field values, then apply the same semantic validation used by writes. */
  normalizeAndValidateFieldValue(
    field: MetadataFieldDefinitionRow,
    value: unknown,
  ): string | string[] | number | boolean | null {
    const normalizedValue = value !== null && this.isTagField(field)
      ? this.normalizeTagNames(value, false)
      : value;
    this.validateFieldValue(field, normalizedValue);
    return normalizedValue as string | string[] | number | boolean | null;
  }

  // ---------------------------------------------------------------------------
  // Field Definition CRUD
  // ---------------------------------------------------------------------------

  async listFields(params: { limit?: number } = {}): Promise<MetadataFieldDetail[]> {
    logger.debug({ service: 'MetadataService' }, 'Listing all metadata field definitions');

    const query = db
      .select()
      .from(metadataFieldDefinitions)
      .orderBy(metadataFieldDefinitions.sortOrder, metadataFieldDefinitions.createdAt);
    const rows = params.limit === undefined ? await query : await query.limit(params.limit);

    return rows.map(toFieldDetail);
  }

  async getFieldBySlug(
    slug: string,
    executor: DatabaseExecutor = db,
  ): Promise<MetadataFieldDefinitionRow> {
    const [row] = await executor
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

  async getModelMetadata(
    modelId: string,
    executor: DatabaseExecutor = db,
  ): Promise<MetadataValue[]> {
    logger.debug(
      { service: 'MetadataService', modelId },
      'Loading metadata for model',
    );

    const results: MetadataValue[] = [];

    // 1. Load generic model_metadata values joined with field definitions
    const genericRows = await executor
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
    const tagRows = await executor
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
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    // Verify the model exists before writing metadata
    const [model] = await executor
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

    const validatedEntries: Array<[
      string,
      string | string[] | number | boolean | null,
      MetadataFieldDefinitionRow,
    ]> = [];
    for (const [fieldSlug, rawValue] of Object.entries(data)) {
      const field = await this.getFieldBySlug(fieldSlug, executor);
      const normalizedValue = this.normalizeAndValidateFieldValue(field, rawValue);
      validatedEntries.push([fieldSlug, normalizedValue, field]);
    }

    for (const [fieldSlug, rawValue, field] of validatedEntries) {
      if (rawValue === null) {
        // Remove metadata for this field
        if (this.isTagField(field)) {
          await executor.delete(modelTags).where(eq(modelTags.modelId, modelId));
          logger.debug(
            { service: 'MetadataService', modelId, fieldSlug },
            'Removed all model tags',
          );
        } else {
          await executor
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

          const [existingTag] = await executor
            .select({ id: tags.id })
            .from(tags)
            .where(sql`lower(${tags.name}) = lower(${trimmedName})`)
            .limit(1);

          if (existingTag) {
            tagIds.push(existingTag.id);
          } else {
            const tagSlug = generateSlug(trimmedName);
            const [newTag] = await executor
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
        await executor.delete(modelTags).where(eq(modelTags.modelId, modelId));

        if (tagIds.length > 0) {
          await executor.insert(modelTags).values(
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

        await executor
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

  async listFieldValues(
    slug: string,
    libraryId: string,
    params: { limit?: number } = {},
  ): Promise<MetadataFieldValue[]> {
    const field = await this.getFieldBySlug(slug);

    logger.debug(
      { service: 'MetadataService', slug, libraryId },
      'Listing known values for metadata field',
    );

    if (this.isTagField(field)) {
      // Count models per tag, scoped to the current library.
      // Inner joins naturally exclude tags with zero models in this library.
      const query = db
        .select({
          value: tags.name,
          modelCount: sql<number>`cast(count(${modelTags.modelId}) as int)`,
        })
        .from(tags)
        .innerJoin(modelTags, eq(modelTags.tagId, tags.id))
        .innerJoin(models, eq(modelTags.modelId, models.id))
        .where(eq(models.libraryId, libraryId))
        .groupBy(tags.id, tags.name)
        .orderBy(desc(sql`count(${modelTags.modelId})`));
      const rows = params.limit === undefined ? await query : await query.limit(params.limit);

      return rows.map((r) => ({ value: r.value, modelCount: r.modelCount }));
    }

    // Generic field — group by value in model_metadata, scoped to the current library.
    const query = db
      .select({
        value: modelMetadata.value,
        modelCount: sql<number>`cast(count(distinct ${modelMetadata.modelId}) as int)`,
      })
      .from(modelMetadata)
      .innerJoin(models, eq(modelMetadata.modelId, models.id))
      .where(
        and(
          eq(modelMetadata.fieldDefinitionId, field.id),
          eq(models.libraryId, libraryId),
        ),
      )
      .groupBy(modelMetadata.value)
      .orderBy(desc(sql`count(distinct ${modelMetadata.modelId})`));
    const rows = params.limit === undefined ? await query : await query.limit(params.limit);

    return rows.map((r) => ({ value: r.value, modelCount: r.modelCount }));
  }

  // ---------------------------------------------------------------------------
  // Bulk Operations
  // ---------------------------------------------------------------------------

  async validateBulkOperations(
    operations: BulkMetadataOperation[],
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    if (operations.length === 0 || operations.length > MAX_BULK_METADATA_OPERATIONS) {
      throw validationError(
        `Bulk metadata requires between 1 and ${MAX_BULK_METADATA_OPERATIONS} operations`,
      );
    }
    for (const operation of operations) {
      const field = await this.getFieldBySlug(operation.fieldSlug, executor);
      if (operation.action === 'remove') continue;
      if (operation.action === 'add') {
        if (!this.isTagField(field)) {
          throw validationError("The 'add' bulk metadata action is only supported for tags");
        }
        const tagNames = this.normalizeTagNames(operation.value, true);
        this.normalizeAndValidateFieldValue(field, tagNames);
        continue;
      }
      if (operation.value !== undefined) {
        this.normalizeAndValidateFieldValue(field, operation.value);
      }
    }
  }

  async bulkSetMetadata(
    modelIds: string[],
    operations: BulkMetadataOperation[],
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    if (modelIds.length === 0 || modelIds.length > MAX_BULK_MODELS) {
      throw validationError(`Bulk metadata requires between 1 and ${MAX_BULK_MODELS} models`);
    }
    const uniqueModelIds = [...new Set(modelIds)];
    if (uniqueModelIds.length !== modelIds.length) {
      throw validationError('Bulk metadata model IDs must be unique');
    }
    logger.info(
      {
        service: 'MetadataService',
        modelCount: uniqueModelIds.length,
        operationCount: operations.length,
      },
      'Starting bulk metadata update',
    );

    if (uniqueModelIds.length === 0) return;
    const existingModels = await executor
      .select({ id: models.id })
      .from(models)
      .where(inArray(models.id, uniqueModelIds));
    if (existingModels.length !== uniqueModelIds.length) {
      throw notFound('One or more models were not found');
    }

    await this.validateBulkOperations(operations, executor);
    const validatedOperations = [];
    for (const operation of operations) {
      const field = await this.getFieldBySlug(operation.fieldSlug, executor);
      validatedOperations.push({ operation, field });
    }

    for (const { operation, field } of validatedOperations) {
      const removesValue = operation.action === 'remove'
        || (operation.action === 'set' && operation.value === undefined);
      if (this.isTagField(field)) {
        if (removesValue || operation.action === 'set') {
          await executor
            .delete(modelTags)
            .where(inArray(modelTags.modelId, uniqueModelIds));
        }
        if (removesValue) continue;

        const tagNames = this.normalizeTagNames(
          operation.value,
          operation.action === 'add',
        );
        const tagIds: string[] = [];
        for (const tagName of tagNames) {
          const [existingTag] = await executor
            .select({ id: tags.id })
            .from(tags)
            .where(sql`lower(${tags.name}) = lower(${tagName})`)
            .limit(1);
          if (existingTag) {
            tagIds.push(existingTag.id);
          } else {
            const [createdTag] = await executor
              .insert(tags)
              .values({ name: tagName, slug: generateSlug(tagName) })
              .returning({ id: tags.id });
            tagIds.push(createdTag.id);
          }
        }
        if (tagIds.length > 0) {
          const relationships = uniqueModelIds.flatMap((modelId) =>
            tagIds.map((tagId) => ({ modelId, tagId })));
          // Stay comfortably below PostgreSQL's parameter limit for the
          // maximum 500-model/100-tag proposal.
          for (let offset = 0; offset < relationships.length; offset += 5_000) {
            await executor
              .insert(modelTags)
              .values(relationships.slice(offset, offset + 5_000))
              .onConflictDoNothing();
          }
        }
        continue;
      }

      if (removesValue) {
        await executor
          .delete(modelMetadata)
          .where(and(
            inArray(modelMetadata.modelId, uniqueModelIds),
            eq(modelMetadata.fieldDefinitionId, field.id),
          ));
        continue;
      }

      const stringValue = this.coerceToString(
        operation.value as string | string[] | number | boolean,
      );
      await executor
        .insert(modelMetadata)
        .values(uniqueModelIds.map((modelId) => ({
          modelId,
          fieldDefinitionId: field.id,
          value: stringValue,
        })))
        .onConflictDoUpdate({
          target: [modelMetadata.modelId, modelMetadata.fieldDefinitionId],
          set: { value: stringValue },
        });
    }

    logger.info(
      {
        service: 'MetadataService',
        modelCount: uniqueModelIds.length,
        operationCount: operations.length,
      },
      'Bulk metadata update complete',
    );
  }
}

export const metadataService = new MetadataService();
