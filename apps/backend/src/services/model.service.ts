import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, asc, and, inArray, sql } from 'drizzle-orm';
import type {
  ModelSourceType,
  ModelStatus,
  FileType,
  UpdateModelRequest,
  MergeModelsResponse,
  SplitModelFolderResponse,
  UpdateModelFileRequest,
  UpdateModelFolderRequest,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import type { DatabaseExecutor } from '../db/index.js';
import {
  models,
  modelFiles,
  modelFolders,
  thumbnails,
  collectionModels,
  modelMetadata,
  modelTags,
} from '../db/schema/index.js';
import { conflict, notFound, validationError } from '../utils/errors.js';
import type { Model } from '../db/schema/model.js';
import { libraryService } from './library.service.js';
import { storageService } from './storage.service.js';
import { generateSlug } from '../utils/slug.js';

export interface CreateModelData {
  id?: string;
  name: string;
  slug: string;
  description?: string | null;
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
}

export class ModelService {
  private normalizeFolderPath(input: string, field = 'path', allowRoot = false): string {
    const raw = input.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
    if (!raw) {
      if (allowRoot) return '';
      throw validationError('Folder path is required', field);
    }

    return this.normalizePathSegments(raw.split('/'), field);
  }

  private normalizeFileName(input: string, field = 'filename'): string {
    const name = input.trim();
    if (!name) {
      throw validationError('Name is required', field);
    }
    if (name.includes('/') || name.includes('\\')) {
      throw validationError('Name cannot contain path separators', field);
    }
    return this.normalizePathSegments([name], field);
  }

  private normalizePathSegments(segments: string[], field: string): string {
    const normalized = segments.map((segment) => segment.trim());
    if (normalized.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw validationError('Path cannot contain empty, . or .. segments', field);
    }
    if (normalized.some((segment) => /[\0-\x1f]/.test(segment))) {
      throw validationError('Path contains unsupported control characters', field);
    }
    if (normalized.some((segment) => segment.length > 255)) {
      throw validationError('Path segments must be 255 characters or fewer', field);
    }
    const joined = normalized.join('/');
    if (joined.length > 1000) {
      throw validationError('Path must be 1000 characters or fewer', field);
    }
    return joined;
  }

  private joinRelativePath(parentPath: string, name: string): string {
    return parentPath ? `${parentPath}/${name}` : name;
  }

  private parentPath(relativePath: string): string {
    const dir = path.posix.dirname(relativePath);
    return dir === '.' ? '' : dir;
  }

  private descendantFilter(column: unknown, folderPath: string) {
    return sql`${column} = ${folderPath} or ${this.strictDescendantFilter(column, folderPath)}`;
  }

  private strictDescendantFilter(column: unknown, folderPath: string) {
    const prefix = `${folderPath}/`;
    return sql`left(${column}, ${prefix.length}) = ${prefix}`;
  }

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

  async createModel(
    data: CreateModelData,
    executor: DatabaseExecutor = db,
  ): Promise<{ id: string }> {
    // Every model is scoped to a library (library_id NOT NULL since 0007).
    // Resolve the owner's default library when not explicitly provided.
    const libraryId = data.libraryId ?? (await libraryService.resolveDefaultLibraryId(data.userId));
    const [row] = await executor
      .insert(models)
      .values({
        ...(data.id ? { id: data.id } : {}),
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
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
      })
      .where(eq(models.id, modelId));
  }

  async recalculateModelStats(
    modelId: string,
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    const [stats] = await executor
      .select({
        fileCount: sql<number>`cast(count(${modelFiles.id}) as int)`,
        totalSizeBytes: sql<number>`cast(coalesce(sum(${modelFiles.sizeBytes}), 0) as bigint)`,
      })
      .from(modelFiles)
      .where(eq(modelFiles.modelId, modelId));

    await executor
      .update(models)
      .set({
        fileCount: Number(stats?.fileCount ?? 0),
        totalSizeBytes: Number(stats?.totalSizeBytes ?? 0),
        updatedAt: new Date(),
      })
      .where(eq(models.id, modelId));
  }

  async getModelById(id: string, executor: DatabaseExecutor = db): Promise<Model> {
    const [row] = await executor.select().from(models).where(eq(models.id, id)).limit(1);

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

  async requireOwnedModel(
    id: string,
    userId: string,
    libraryId?: string,
    executor: DatabaseExecutor = db,
  ): Promise<Model> {
    const whereClause = libraryId
      ? and(eq(models.id, id), eq(models.userId, userId), eq(models.libraryId, libraryId))
      : and(eq(models.id, id), eq(models.userId, userId));

    const [row] = await executor.select().from(models).where(whereClause).limit(1);

    if (!row) {
      throw notFound(`Model not found: ${id}`);
    }

    return row;
  }

  async listOwnedModelIds(
    userId: string,
    libraryId: string,
    limit: number,
    executor: DatabaseExecutor = db,
  ): Promise<string[]> {
    const rows = await executor
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.userId, userId), eq(models.libraryId, libraryId)))
      .orderBy(asc(models.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async requireOwnedModels(
    ids: string[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor = db,
  ): Promise<Model[]> {
    const uniqueIds = [...new Set(ids)].sort();
    const rows = await executor
      .select()
      .from(models)
      .where(and(
        inArray(models.id, uniqueIds),
        eq(models.userId, userId),
        eq(models.libraryId, libraryId),
      ))
      .orderBy(asc(models.id));
    if (rows.length !== uniqueIds.length) {
      throw notFound('One or more models were not found');
    }
    return rows;
  }

  async lockOwnedModels(
    ids: string[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor,
  ): Promise<Model[]> {
    const sortedIds = [...new Set(ids)].sort();
    const rows = await executor
      .select()
      .from(models)
      .where(and(
        inArray(models.id, sortedIds),
        eq(models.userId, userId),
        eq(models.libraryId, libraryId),
      ))
      .orderBy(asc(models.id))
      .for('update');

    if (rows.length !== sortedIds.length) {
      throw notFound('One or more models were not found');
    }
    return rows;
  }

  async updateModel(
    id: string,
    data: UpdateModelRequest,
    executor: DatabaseExecutor = db,
  ): Promise<Model> {
    await this.getModelById(id, executor);

    if (data.previewImageFileId != null) {
      const [file] = await executor
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

    const [updated] = await executor
      .update(models)
      .set(updateValues)
      .where(eq(models.id, id))
      .returning();

    return updated;
  }

  async getModelFiles(
    modelId: string,
    executor: DatabaseExecutor = db,
  ): Promise<Array<typeof modelFiles.$inferSelect>> {
    return executor
      .select()
      .from(modelFiles)
      .where(eq(modelFiles.modelId, modelId))
      .orderBy(asc(modelFiles.relativePath));
  }

  async listModelStoragePaths(
    modelIds: string[],
    executor: DatabaseExecutor = db,
  ): Promise<string[]> {
    if (modelIds.length === 0) return [];
    const rows = await executor
      .select({ storagePath: modelFiles.storagePath })
      .from(modelFiles)
      .where(inArray(modelFiles.modelId, modelIds))
      .orderBy(asc(modelFiles.storagePath));
    return rows.map((row) => row.storagePath);
  }

  async getModelFolders(modelId: string): Promise<Array<typeof modelFolders.$inferSelect>> {
    return db
      .select()
      .from(modelFolders)
      .where(eq(modelFolders.modelId, modelId))
      .orderBy(asc(modelFolders.path));
  }

  private async ensureFolderAncestors(
    modelId: string,
    folderPath: string,
    executor: DatabaseExecutor = db,
  ): Promise<void> {
    if (!folderPath) return;
    const paths = folderPath
      .split('/')
      .map((_, index, segments) => segments.slice(0, index + 1).join('/'));

    const fileConflicts = await executor
      .select({ id: modelFiles.id })
      .from(modelFiles)
      .where(and(eq(modelFiles.modelId, modelId), inArray(modelFiles.relativePath, paths)));
    if (fileConflicts.length > 0) {
      throw conflict('A file already exists at that folder path');
    }

    await executor.insert(modelFolders)
      .values(paths.map((pathValue) => ({ modelId, path: pathValue })))
      .onConflictDoNothing();
  }

  private async assertFileDestinationAvailable(
    modelId: string,
    relativePath: string,
    currentFileId: string,
  ): Promise<void> {
    const [fileConflict] = await db
      .select({ id: modelFiles.id })
      .from(modelFiles)
      .where(and(eq(modelFiles.modelId, modelId), eq(modelFiles.relativePath, relativePath)))
      .limit(1);
    if (fileConflict && fileConflict.id !== currentFileId) {
      throw conflict('A file already exists at that path');
    }

    const [folderConflict] = await db
      .select({ id: modelFolders.id })
      .from(modelFolders)
      .where(and(eq(modelFolders.modelId, modelId), eq(modelFolders.path, relativePath)))
      .limit(1);
    if (folderConflict) {
      throw conflict('A folder already exists at that path');
    }
  }

  private async assertFolderDestinationAvailable(
    modelId: string,
    currentPath: string,
    nextPath: string,
  ): Promise<void> {
    const [fileAtFolderPath] = await db
      .select({ id: modelFiles.id })
      .from(modelFiles)
      .where(and(eq(modelFiles.modelId, modelId), eq(modelFiles.relativePath, nextPath)))
      .limit(1);
    if (fileAtFolderPath) {
      throw conflict('A file already exists at that folder path');
    }

    const [folderAtPath] = await db
      .select({ id: modelFolders.id, path: modelFolders.path })
      .from(modelFolders)
      .where(and(eq(modelFolders.modelId, modelId), eq(modelFolders.path, nextPath)))
      .limit(1);
    if (folderAtPath && folderAtPath.path !== currentPath) {
      throw conflict('A folder already exists at that path');
    }
    if (!folderAtPath && await this.folderHasFiles(modelId, nextPath)) {
      throw conflict('A folder already exists at that path');
    }

    const [sourceFiles, sourceFolders] = await Promise.all([
      db
        .select({ id: modelFiles.id, relativePath: modelFiles.relativePath })
        .from(modelFiles)
        .where(and(
          eq(modelFiles.modelId, modelId),
          this.strictDescendantFilter(modelFiles.relativePath, currentPath),
        )),
      db
        .select({ id: modelFolders.id, path: modelFolders.path })
        .from(modelFolders)
        .where(and(eq(modelFolders.modelId, modelId), this.descendantFilter(modelFolders.path, currentPath))),
    ]);

    const sourceFileIds = new Set(sourceFiles.map((file) => file.id));
    const sourceFolderIds = new Set(sourceFolders.map((folder) => folder.id));
    const destinationFilePaths = sourceFiles.map(
      (file) => `${nextPath}${file.relativePath.slice(currentPath.length)}`,
    );
    const destinationFolderPaths = sourceFolders.map(
      (folder) => `${nextPath}${folder.path.slice(currentPath.length)}`,
    );

    if (destinationFilePaths.length > 0) {
      const conflicts = await db
        .select({ id: modelFiles.id })
        .from(modelFiles)
        .where(and(eq(modelFiles.modelId, modelId), inArray(modelFiles.relativePath, destinationFilePaths)));
      if (conflicts.some((row) => !sourceFileIds.has(row.id))) {
        throw conflict('A file already exists in the destination folder');
      }
    }

    if (destinationFolderPaths.length > 0) {
      const conflicts = await db
        .select({ id: modelFolders.id })
        .from(modelFolders)
        .where(and(eq(modelFolders.modelId, modelId), inArray(modelFolders.path, destinationFolderPaths)));
      if (conflicts.some((row) => !sourceFolderIds.has(row.id))) {
        throw conflict('A folder already exists in the destination folder');
      }
    }
  }

  async createModelFolder(modelId: string, requestedPath: string): Promise<void> {
    const folderPath = this.normalizeFolderPath(requestedPath);
    const foldersToCreate = folderPath
      .split('/')
      .map((_, index, segments) => segments.slice(0, index + 1).join('/'));

    const fileConflicts = await db
      .select({ relativePath: modelFiles.relativePath })
      .from(modelFiles)
      .where(
        and(
          eq(modelFiles.modelId, modelId),
          inArray(modelFiles.relativePath, foldersToCreate),
        ),
      );
    if (fileConflicts.length > 0) {
      throw conflict('A file already exists at that folder path');
    }

    const [existing] = await db
      .select({ id: modelFolders.id })
      .from(modelFolders)
      .where(and(eq(modelFolders.modelId, modelId), eq(modelFolders.path, folderPath)))
      .limit(1);
    if (existing || await this.folderHasFiles(modelId, folderPath)) {
      throw conflict('Folder already exists');
    }

    await db.insert(modelFolders)
      .values(foldersToCreate.map((pathValue) => ({ modelId, path: pathValue })))
      .onConflictDoNothing();

    await db
      .update(models)
      .set({ updatedAt: new Date() })
      .where(eq(models.id, modelId));
  }

  async updateModelFileLocation(
    modelId: string,
    fileId: string,
    data: UpdateModelFileRequest,
  ): Promise<void> {
    const [file] = await db
      .select()
      .from(modelFiles)
      .where(and(eq(modelFiles.modelId, modelId), eq(modelFiles.id, fileId)))
      .limit(1);
    if (!file) {
      throw notFound(`File not found: ${fileId}`);
    }

    const filename = data.filename !== undefined
      ? this.normalizeFileName(data.filename)
      : file.filename;
    const parentPath = data.parentPath !== undefined
      ? this.normalizeFolderPath(data.parentPath, 'parentPath', true)
      : this.parentPath(file.relativePath);
    const relativePath = this.joinRelativePath(parentPath, filename);
    const storagePath = `models/${modelId}/${relativePath}`;

    if (relativePath === file.relativePath && filename === file.filename) {
      return;
    }

    await this.assertFileDestinationAvailable(modelId, relativePath, fileId);
    await storageService.copy(file.storagePath, storagePath);
    try {
      await db.transaction(async (tx) => {
        if (parentPath) {
          await this.ensureFolderAncestors(modelId, parentPath, tx);
        }
        const [updatedFile] = await tx
          .update(modelFiles)
          .set({ filename, relativePath, storagePath })
          .where(and(
            eq(modelFiles.id, file.id),
            eq(modelFiles.modelId, modelId),
            eq(modelFiles.relativePath, file.relativePath),
            eq(modelFiles.storagePath, file.storagePath),
          ))
          .returning({ id: modelFiles.id });
        if (!updatedFile) {
          throw conflict('File changed while it was being updated; try again');
        }
        await tx
          .update(models)
          .set({ updatedAt: new Date() })
          .where(eq(models.id, modelId));
      });
    } catch (err) {
      await storageService.delete(storagePath).catch(() => {});
      throw err;
    }

    await storageService.delete(file.storagePath).catch(() => {});
  }

  async updateModelFolderLocation(
    modelId: string,
    data: UpdateModelFolderRequest,
  ): Promise<void> {
    const currentPath = this.normalizeFolderPath(data.path);
    const [folder] = await db
      .select()
      .from(modelFolders)
      .where(and(eq(modelFolders.modelId, modelId), eq(modelFolders.path, currentPath)))
      .limit(1);
    if (!folder && !(await this.folderHasFiles(modelId, currentPath))) {
      throw notFound(`Folder not found: ${currentPath}`);
    }

    const name = data.name !== undefined
      ? this.normalizeFileName(data.name, 'name')
      : path.posix.basename(currentPath);
    const parentPath = data.parentPath !== undefined
      ? this.normalizeFolderPath(data.parentPath, 'parentPath', true)
      : this.parentPath(currentPath);
    const nextPath = this.joinRelativePath(parentPath, name);

    if (nextPath === currentPath) {
      return;
    }
    if (nextPath.startsWith(`${currentPath}/`)) {
      throw validationError('Cannot move a folder inside itself', 'parentPath');
    }

    await this.assertFolderDestinationAvailable(modelId, currentPath, nextPath);
    const [filesInFolder, foldersInFolder] = await Promise.all([
      db
        .select()
        .from(modelFiles)
        .where(and(
          eq(modelFiles.modelId, modelId),
          this.strictDescendantFilter(modelFiles.relativePath, currentPath),
        ))
        .orderBy(asc(modelFiles.relativePath)),
      db
        .select()
        .from(modelFolders)
        .where(and(eq(modelFolders.modelId, modelId), this.descendantFilter(modelFolders.path, currentPath)))
        .orderBy(asc(modelFolders.path)),
    ]);

    const fileMoves = filesInFolder.map((file) => {
      const relativePath = `${nextPath}${file.relativePath.slice(currentPath.length)}`;
      return {
        file,
        relativePath,
        storagePath: `models/${modelId}/${relativePath}`,
      };
    });

    for (const move of fileMoves) {
      await storageService.copy(move.file.storagePath, move.storagePath);
    }

    try {
      await db.transaction(async (tx) => {
        if (parentPath) {
          await this.ensureFolderAncestors(modelId, parentPath, tx);
        }
        for (const folderRow of foldersInFolder) {
          const pathValue = `${nextPath}${folderRow.path.slice(currentPath.length)}`;
          const [updatedFolder] = await tx
            .update(modelFolders)
            .set({ path: pathValue })
            .where(and(
              eq(modelFolders.id, folderRow.id),
              eq(modelFolders.modelId, modelId),
              eq(modelFolders.path, folderRow.path),
            ))
            .returning({ id: modelFolders.id });
          if (!updatedFolder) {
            throw conflict('Folder changed while it was being updated; try again');
          }
        }

        for (const move of fileMoves) {
          const [updatedFile] = await tx
            .update(modelFiles)
            .set({ relativePath: move.relativePath, storagePath: move.storagePath })
            .where(and(
              eq(modelFiles.id, move.file.id),
              eq(modelFiles.modelId, modelId),
              eq(modelFiles.relativePath, move.file.relativePath),
              eq(modelFiles.storagePath, move.file.storagePath),
            ))
            .returning({ id: modelFiles.id });
          if (!updatedFile) {
            throw conflict('Folder changed while it was being updated; try again');
          }
        }

        await tx
          .update(models)
          .set({ updatedAt: new Date() })
          .where(eq(models.id, modelId));
      });
    } catch (err) {
      await Promise.all(fileMoves.map((move) => storageService.delete(move.storagePath).catch(() => {})));
      throw err;
    }

    await Promise.all(fileMoves.map((move) => storageService.delete(move.file.storagePath).catch(() => {})));
  }

  async deleteModelFile(modelId: string, fileId: string): Promise<void> {
    const [file] = await db
      .select()
      .from(modelFiles)
      .where(and(eq(modelFiles.modelId, modelId), eq(modelFiles.id, fileId)))
      .limit(1);
    if (!file) {
      throw notFound(`File not found: ${fileId}`);
    }

    const [deletedFile] = await db
      .delete(modelFiles)
      .where(and(
        eq(modelFiles.id, file.id),
        eq(modelFiles.modelId, modelId),
        eq(modelFiles.relativePath, file.relativePath),
        eq(modelFiles.storagePath, file.storagePath),
      ))
      .returning({ id: modelFiles.id });
    if (!deletedFile) {
      throw conflict('File changed while it was being deleted; try again');
    }
    await this.recalculateModelStats(modelId);
    await storageService.delete(file.storagePath).catch(() => {});
  }

  async deleteModelFolder(modelId: string, requestedPath: string): Promise<void> {
    const folderPath = this.normalizeFolderPath(requestedPath);
    const [folder] = await db
      .select({ id: modelFolders.id })
      .from(modelFolders)
      .where(and(eq(modelFolders.modelId, modelId), eq(modelFolders.path, folderPath)))
      .limit(1);
    if (!folder && !(await this.folderHasFiles(modelId, folderPath))) {
      throw notFound(`Folder not found: ${folderPath}`);
    }

    const files = await db
      .select()
      .from(modelFiles)
      .where(and(
        eq(modelFiles.modelId, modelId),
        this.strictDescendantFilter(modelFiles.relativePath, folderPath),
      ));

    await db.transaction(async (tx) => {
      await tx
        .delete(modelFiles)
        .where(and(
          eq(modelFiles.modelId, modelId),
          this.strictDescendantFilter(modelFiles.relativePath, folderPath),
        ));
      await tx
        .delete(modelFolders)
        .where(and(eq(modelFolders.modelId, modelId), this.descendantFilter(modelFolders.path, folderPath)));
    });

    await this.recalculateModelStats(modelId);
    await Promise.all(files.map((file) => storageService.delete(file.storagePath).catch(() => {})));
  }

  async splitModelFolder(
    sourceModelId: string,
    requestedPath: string,
    requestedName: string,
    userId: string,
    libraryId: string,
  ): Promise<SplitModelFolderResponse> {
    const folderPath = this.normalizeFolderPath(requestedPath);
    const name = requestedName.trim();
    if (!name) {
      throw validationError('Model name is required', 'name');
    }
    if (name.length > 255) {
      throw validationError('Model name must be 255 characters or fewer', 'name');
    }

    const source = await this.requireOwnedModel(sourceModelId, userId, libraryId);
    if (source.status !== 'ready') {
      throw validationError('Source model must be ready before splitting', 'sourceModelId');
    }

    const [folder, files, folders] = await Promise.all([
      db
        .select({ id: modelFolders.id })
        .from(modelFolders)
        .where(and(eq(modelFolders.modelId, sourceModelId), eq(modelFolders.path, folderPath)))
        .limit(1),
      db
        .select()
        .from(modelFiles)
        .where(and(
          eq(modelFiles.modelId, sourceModelId),
          this.strictDescendantFilter(modelFiles.relativePath, folderPath),
        ))
        .orderBy(asc(modelFiles.relativePath)),
      db
        .select()
        .from(modelFolders)
        .where(and(
          eq(modelFolders.modelId, sourceModelId),
          this.descendantFilter(modelFolders.path, folderPath),
        ))
        .orderBy(asc(modelFolders.path)),
    ]);

    if (folder.length === 0 && files.length === 0) {
      throw notFound(`Folder not found: ${folderPath}`);
    }
    if (files.length === 0) {
      throw validationError('Folder must contain at least one file before it can be split', 'path');
    }

    const newModelId = randomUUID();
    const fileIds = files.map((file) => file.id);
    const movedFileIds = new Set(fileIds);
    const thumbnailRows = await db
      .select()
      .from(thumbnails)
      .where(inArray(thumbnails.sourceFileId, fileIds));
    const fileMoves = files.map((file) => {
      const relativePath = file.relativePath.slice(folderPath.length + 1);
      return {
        file,
        relativePath,
        storagePath: `models/${newModelId}/${relativePath}`,
      };
    });
    const thumbnailMoves = thumbnailRows.map((thumbnail) => ({
      thumbnail,
      storagePath: `thumbnails/${newModelId}/${path.posix.basename(thumbnail.storagePath)}`,
    }));
    const copiedPaths: string[] = [];

    try {
      for (const move of [...fileMoves, ...thumbnailMoves]) {
        const sourcePath = 'file' in move ? move.file.storagePath : move.thumbnail.storagePath;
        await storageService.copy(sourcePath, move.storagePath);
        copiedPaths.push(move.storagePath);
      }

      await db.transaction(async (tx) => {
        const [lockedSource] = await this.lockOwnedModels(
          [sourceModelId],
          userId,
          libraryId,
          tx,
        );
        if (lockedSource.status !== 'ready') {
          throw validationError('Source model must be ready before splitting', 'sourceModelId');
        }

        const currentFiles = await tx
          .select({
            id: modelFiles.id,
            relativePath: modelFiles.relativePath,
            storagePath: modelFiles.storagePath,
          })
          .from(modelFiles)
          .where(and(
            eq(modelFiles.modelId, sourceModelId),
            this.strictDescendantFilter(modelFiles.relativePath, folderPath),
          ))
          .orderBy(asc(modelFiles.relativePath))
          .for('update');
        const unchanged = currentFiles.length === files.length && currentFiles.every((file, index) =>
          file.id === files[index]?.id &&
          file.relativePath === files[index]?.relativePath &&
          file.storagePath === files[index]?.storagePath,
        );
        if (!unchanged) {
          throw conflict('Folder changed while it was being split; try again');
        }

        const currentFolders = await tx
          .select({ id: modelFolders.id, path: modelFolders.path })
          .from(modelFolders)
          .where(and(
            eq(modelFolders.modelId, sourceModelId),
            this.descendantFilter(modelFolders.path, folderPath),
          ))
          .orderBy(asc(modelFolders.path))
          .for('update');
        const foldersUnchanged = currentFolders.length === folders.length &&
          currentFolders.every((folderRow, index) =>
            folderRow.id === folders[index]?.id && folderRow.path === folders[index]?.path,
          );
        if (!foldersUnchanged) {
          throw conflict('Folder changed while it was being split; try again');
        }

        await this.createModel({
          id: newModelId,
          name,
          slug: generateSlug(name),
          userId,
          libraryId,
          sourceType: 'manual',
          status: 'ready',
        }, tx);

        for (const folderRow of folders) {
          if (folderRow.path === folderPath) {
            await tx.delete(modelFolders).where(eq(modelFolders.id, folderRow.id));
            continue;
          }
          await tx
            .update(modelFolders)
            .set({
              modelId: newModelId,
              path: folderRow.path.slice(folderPath.length + 1),
            })
            .where(eq(modelFolders.id, folderRow.id));
        }

        for (const move of fileMoves) {
          await tx
            .update(modelFiles)
            .set({
              modelId: newModelId,
              relativePath: move.relativePath,
              storagePath: move.storagePath,
            })
            .where(eq(modelFiles.id, move.file.id));
        }

        for (const move of thumbnailMoves) {
          await tx
            .update(thumbnails)
            .set({ storagePath: move.storagePath })
            .where(eq(thumbnails.id, move.thumbnail.id));
        }

        if (lockedSource.previewImageFileId && movedFileIds.has(lockedSource.previewImageFileId)) {
          await tx
            .update(models)
            .set({
              previewImageFileId: null,
              previewCropX: null,
              previewCropY: null,
              previewCropScale: null,
            })
            .where(eq(models.id, sourceModelId));
          await tx
            .update(models)
            .set({
              previewImageFileId: lockedSource.previewImageFileId,
              previewCropX: lockedSource.previewCropX,
              previewCropY: lockedSource.previewCropY,
              previewCropScale: lockedSource.previewCropScale,
            })
            .where(eq(models.id, newModelId));
        }

        await this.recalculateModelStats(sourceModelId, tx);
        await this.recalculateModelStats(newModelId, tx);
      });
    } catch (error) {
      await Promise.all(copiedPaths.map((storagePath) =>
        storageService.delete(storagePath).catch(() => {})));
      throw error;
    }

    await Promise.all([
      ...fileMoves.map((move) => storageService.delete(move.file.storagePath).catch(() => {})),
      ...thumbnailMoves.map((move) =>
        storageService.delete(move.thumbnail.storagePath).catch(() => {})),
    ]);

    return {
      sourceModelId,
      newModelId,
      movedFileCount: files.length,
    };
  }

  private async folderHasFiles(modelId: string, folderPath: string): Promise<boolean> {
    const [file] = await db
      .select({ id: modelFiles.id })
      .from(modelFiles)
      .where(and(
        eq(modelFiles.modelId, modelId),
        this.strictDescendantFilter(modelFiles.relativePath, folderPath),
      ))
      .limit(1);
    return Boolean(file);
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

      await storageService.copy(file.storagePath, storagePath);
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

  async deleteModels(
    ids: string[],
    executor: DatabaseExecutor = db,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const deleted = await executor
      .delete(models)
      .where(inArray(models.id, ids))
      .returning({ id: models.id });
    return deleted.map((row) => row.id);
  }
}

export const modelService = new ModelService();
