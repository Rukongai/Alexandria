import { eq } from 'drizzle-orm';
import type { ModelSourceType, ModelStatus, FileType } from '@alexandria/shared';
import { db } from '../db/index.js';
import { models, modelFiles, thumbnails } from '../db/schema/index.js';
import { notFound } from '../utils/errors.js';
import type { Model } from '../db/schema/model.js';

export interface CreateModelData {
  name: string;
  slug: string;
  userId: string;
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
  async createModel(data: CreateModelData): Promise<{ id: string }> {
    const [row] = await db
      .insert(models)
      .values({
        name: data.name,
        slug: data.slug,
        userId: data.userId,
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

  async getModelById(id: string): Promise<Model> {
    const [row] = await db.select().from(models).where(eq(models.id, id)).limit(1);

    if (!row) {
      throw notFound(`Model not found: ${id}`);
    }

    return row;
  }

  async deleteModel(id: string): Promise<void> {
    await db.delete(models).where(eq(models.id, id));
  }
}

export const modelService = new ModelService();
