import path from 'node:path';
import { eq, asc, and, inArray, sql } from 'drizzle-orm';
import type {
  ModelSourceType,
  ModelStatus,
  FileType,
  UpdateModelRequest,
  MergeModelsResponse,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import {
  models,
  modelFiles,
  thumbnails,
  collectionModels,
  modelMetadata,
  modelTags,
} from '../db/schema/index.js';
import { notFound, validationError } from '../utils/errors.js';
import type { Model } from '../db/schema/model.js';
import { libraryService } from './library.service.js';
import { storageService } from './storage.service.js';

export interface CreateModelData {
  name: string;
  slug: string;
  userId: string;
  // Library scope. Optional at the call site — defaults to the owner's default
  // library — but the DB column is NOT NULL (resolved before insert).
  libraryId?: string;
  sourceType: ModelSourceType;
  status: ModelStatus;
  originalFilename?: string;
}

export interface CreateModelFileData {
  filename: string;
  relativePath: string;
  fileType: FileType;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  hash: string;
}

export interface CreateThumbnailData {
  sourceFileId: string;
  storagePath: string;
  width: number;
  height: number;
  format: string;
}

export interface UpdateModelStatusData {
  totalSizeBytes?: number;
  fileCount?: number;
  fileHash?: string;
}

export class ModelService {
  private uniqueRelativePath(requestedPath: string, usedPaths: Set<string>): string {
    const normalized = requestedPath.replace(/\\/g, '/');
    if (!usedPaths.has(normalized)) {
      usedPaths.add(normalized);
      return normalized;
    }

    const dir = path.posix.dirname(normalized);
    const ext = path.posix.extname(normalized);
    const basename = path.posix.basename(normalized, ext);
    const prefix = dir === '.' ? '' : `${dir}/`;

    let index = 2;
    while (true) {
      const candidate = `${prefix}${basename}-${index}${ext}`;
      if (!usedPaths.has(candidate)) {
        usedPaths.add(candidate);
        return candidate;
      }
      index += 1;
    }
  }

  async createModel(data: CreateModelData): Promise<{ id: string }> {
    // Every model is scoped to a library (library_id NOT NULL since 0007).
    // Resolve the owner's default library when not explicitly provided.
    const libraryId = data.libraryId ?? (await libraryService.resolveDefaultLibraryId(data.userId));
    const [row] = await db
      .insert(models)
      .values({
        name: data.name,
        slug: data.slug,
        userId: data.userId,
        libraryId,
        sourceType: data.sourceType,
        status: data.status,
        originalFilename: data.originalFilename ?? null,
      })
      .returning({ id: models.id });

    return { id: row.id };
  }

  async createModelFiles(
    modelId: string,
    files: CreateModelFileData[],
  ): Promise<Array<{ id: string; fileType: string }>> {
    if (files.length === 0) return [];

    const rows = await db
      .insert(modelFiles)
      .values(
        files.map((f) => ({
          modelId,
          filename: f.filename,
          relativePath: f.relativePath,
          fileType: f.fileType,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          storagePath: f.storagePath,
          hash: f.hash,
        })),
      )
      .returning({ id: modelFiles.id, fileType: modelFiles.fileType });

    return rows;
  }

  async buildAdditionalFileInputs(
    modelId: string,
    files: CreateModelFileData[],
  ): Promise<CreateModelFileData[]> {
    const existingFiles = await this.getModelFiles(modelId);
    const usedPaths = new Set(existingFiles.map((file) => file.relativePath));

    return files.map((file) => {
      const relativePath = this.uniqueRelativePath(file.relativePath, usedPaths);
      return {
        ...file,
        relativePath,
        storagePath: `models/${modelId}/${relativePath}`,
      };
    });
  }

  async createThumbnails(thumbnailData: CreateThumbnailData[]): Promise<void> {
    if (thumbnailData.length === 0) return;

    await db.insert(thumbnails).values(
      thumbnailData.map((t) => ({
        sourceFileId: t.sourceFileId,
        storagePath: t.storagePath,
        width: t.width,
        height: t.height,
        format: t.format,
      })),
    );
  }

  async updateModelStatus(
    modelId: string,
    status: ModelStatus,
    updates?: UpdateModelStatusData,
  ): Promise<void> {
    await db
      .update(models)
      .set({
        status,
        updatedAt: new Date(),
        ...(updates?.totalSizeBytes !== undefined && { totalSizeBytes: updates.totalSizeBytes }),
        ...(updates?.fileCount !== undefined && { fileCount: updates.fileCount }),
        ...(updates?.fileHash !== undefined && { fileHash: updates.fileHash }),
      })
      .where(eq(models.id, modelId));
  }

  async recalculateModelStats(modelId: string): Promise<void> {
    const [stats] = await db
      .select({
        fileCount: sql<number>`cast(count(${modelFiles.id}) as int)`,
        totalSizeBytes: sql<number>`cast(coalesce(sum(${modelFiles.sizeBytes}), 0) as bigint)`,
      })
      .from(modelFiles)
      .where(eq(modelFiles.modelId, modelId));

    await db
      .update(models)
      .set({
        fileCount: Number(stats?.fileCount ?? 0),
        totalSizeBytes: Number(stats?.totalSizeBytes ?? 0),
        updatedAt: new Date(),
      })
      .where(eq(models.id, modelId));
  }

  async getModelById(id: string): Promise<Model> {
    const [row] = await db.select().from(models).where(eq(models.id, id)).limit(1);

    if (!row) {
      throw notFound(`Model not found: ${id}`);
    }

    return row;
  }

  /**
   * Verify a model exists AND belongs to the active library. Throws NOT_FOUND
   * otherwise, so a stale deep link to a model in another library 404s after the
   * user switches libraries instead of rendering cross-library content.
   */
  async requireModelInLibrary(id: string, libraryId: string): Promise<Model> {
    const model = await this.getModelById(id);
    if (model.libraryId !== libraryId) {
      throw notFound(`Model not found: ${id}`);
    }
    return model;
  }

  async requireOwnedModel(id: string, userId: string, libraryId?: string): Promise<Model> {
    const whereClause = libraryId
      ? and(eq(models.id, id), eq(models.userId, userId), eq(models.libraryId, libraryId))
      : and(eq(models.id, id), eq(models.userId, userId));

    const [row] = await db.select().from(models).where(whereClause).limit(1);

    if (!row) {
      throw notFound(`Model not found: ${id}`);
    }

    return row;
  }

  async updateModel(id: string, data: UpdateModelRequest): Promise<Model> {
    await this.getModelById(id);

    if (data.previewImageFileId != null) {
      const [file] = await db
        .select({ id: modelFiles.id })
        .from(modelFiles)
        .where(
          and(
            eq(modelFiles.id, data.previewImageFileId),
            eq(modelFiles.modelId, id),
            eq(modelFiles.fileType, 'image'),
          ),
        )
        .limit(1);
      if (!file) {
        throw validationError(
          'previewImageFileId must reference an image file belonging to this model',
          'previewImageFileId',
        );
      }
    }

    const updateValues: Partial<{
      name: string;
      description: string | null;
      previewImageFileId: string | null;
      previewCropX: number | null;
      previewCropY: number | null;
      previewCropScale: number | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) updateValues.name = data.name;
    if (data.description !== undefined) updateValues.description = data.description;
    if (data.previewImageFileId !== undefined) updateValues.previewImageFileId = data.previewImageFileId;
    if (data.previewCropX !== undefined) updateValues.previewCropX = data.previewCropX;
    if (data.previewCropY !== undefined) updateValues.previewCropY = data.previewCropY;
    if (data.previewCropScale !== undefined) updateValues.previewCropScale = data.previewCropScale;

    const [updated] = await db
      .update(models)
      .set(updateValues)
      .where(eq(models.id, id))
      .returning();

    return updated;
  }

  async getModelFiles(modelId: string): Promise<Array<typeof modelFiles.$inferSelect>> {
    return db
      .select()
      .from(modelFiles)
      .where(eq(modelFiles.modelId, modelId))
      .orderBy(asc(modelFiles.relativePath));
  }

  async mergeModels(
    targetModelId: string,
    sourceModelIds: string[],
    userId: string,
    libraryId: string,
  ): Promise<MergeModelsResponse> {
    const uniqueSourceIds = [...new Set(sourceModelIds)];
    if (uniqueSourceIds.includes(targetModelId)) {
      throw validationError('A model cannot be merged into itself', 'sourceModelIds');
    }

    const target = await this.requireOwnedModel(targetModelId, userId, libraryId);
    if (target.status !== 'ready') {
      throw validationError('Target model must be ready before merging', 'targetModelId');
    }

    if (uniqueSourceIds.length === 0) {
      throw validationError('At least one source model is required', 'sourceModelIds');
    }

    const sourceRows = await db
      .select()
      .from(models)
      .where(
        and(
          inArray(models.id, uniqueSourceIds),
          eq(models.userId, userId),
          eq(models.libraryId, libraryId),
        ),
      );

    if (sourceRows.length !== uniqueSourceIds.length) {
      throw notFound('One or more source models were not found');
    }
    if (sourceRows.some((source) => source.status !== 'ready')) {
      throw validationError('Source models must be ready before merging', 'sourceModelIds');
    }

    const existingTargetFiles = await this.getModelFiles(targetModelId);
    const usedPaths = new Set(existingTargetFiles.map((file) => file.relativePath));
    const sourceFiles = await db
      .select()
      .from(modelFiles)
      .where(inArray(modelFiles.modelId, uniqueSourceIds))
      .orderBy(asc(modelFiles.relativePath));

    let fallbackPreviewImageFileId: string | null = null;

    for (const file of sourceFiles) {
      const relativePath = this.uniqueRelativePath(file.relativePath, usedPaths);
      const storagePath = `models/${targetModelId}/${relativePath}`;

      await storageService.store(storagePath, storageService.retrieveStream(file.storagePath));
      try {
        await db
          .update(modelFiles)
          .set({
            modelId: targetModelId,
            relativePath,
            storagePath,
          })
          .where(eq(modelFiles.id, file.id));
      } catch (err) {
        await storageService.delete(storagePath).catch(() => {});
        throw err;
      }

      await storageService.delete(file.storagePath).catch(() => {});

      if (
        fallbackPreviewImageFileId === null &&
        file.fileType === 'image' &&
        sourceRows.some((source) => source.previewImageFileId === file.id)
      ) {
        fallbackPreviewImageFileId = file.id;
      }
    }

    await db.transaction(async (tx) => {
      const sourceCollections = await tx
        .select({ collectionId: collectionModels.collectionId })
        .from(collectionModels)
        .where(inArray(collectionModels.modelId, uniqueSourceIds));

      if (sourceCollections.length > 0) {
        await tx
          .insert(collectionModels)
          .values(
            sourceCollections.map((row) => ({
              collectionId: row.collectionId,
              modelId: targetModelId,
            })),
          )
          .onConflictDoNothing();
      }

      const targetMetadataRows = await tx
        .select({ fieldDefinitionId: modelMetadata.fieldDefinitionId })
        .from(modelMetadata)
        .where(eq(modelMetadata.modelId, targetModelId));
      const targetMetadataFieldIds = new Set(
        targetMetadataRows.map((row) => row.fieldDefinitionId),
      );

      const sourceMetadataRows = await tx
        .select({
          fieldDefinitionId: modelMetadata.fieldDefinitionId,
          value: modelMetadata.value,
        })
        .from(modelMetadata)
        .where(inArray(modelMetadata.modelId, uniqueSourceIds));

      const metadataToCopy = sourceMetadataRows.filter((row) => {
        if (targetMetadataFieldIds.has(row.fieldDefinitionId)) return false;
        targetMetadataFieldIds.add(row.fieldDefinitionId);
        return true;
      });

      if (metadataToCopy.length > 0) {
        await tx.insert(modelMetadata).values(
          metadataToCopy.map((row) => ({
            modelId: targetModelId,
            fieldDefinitionId: row.fieldDefinitionId,
            value: row.value,
          })),
        );
      }

      const sourceTags = await tx
        .select({ tagId: modelTags.tagId })
        .from(modelTags)
        .where(inArray(modelTags.modelId, uniqueSourceIds));

      if (sourceTags.length > 0) {
        await tx
          .insert(modelTags)
          .values(sourceTags.map((row) => ({ modelId: targetModelId, tagId: row.tagId })))
          .onConflictDoNothing();
      }

      if (!target.previewImageFileId && fallbackPreviewImageFileId) {
        await tx
          .update(models)
          .set({
            previewImageFileId: fallbackPreviewImageFileId,
            updatedAt: new Date(),
          })
          .where(eq(models.id, targetModelId));
      }

      await tx.delete(models).where(inArray(models.id, uniqueSourceIds));
    });

    await this.recalculateModelStats(targetModelId);

    return {
      targetModelId,
      mergedModelIds: uniqueSourceIds,
      movedFileCount: sourceFiles.length,
    };
  }

  async deleteModel(id: string): Promise<void> {
    await this.getModelById(id);
    await db.delete(models).where(eq(models.id, id));
  }

  async deleteModels(ids: string[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const id of ids) {
      const [row] = await db.select({ id: models.id }).from(models).where(eq(models.id, id)).limit(1);
      if (row) {
        await db.delete(models).where(eq(models.id, id));
        deleted.push(id);
      }
    }
    return deleted;
  }
}

export const modelService = new ModelService();
