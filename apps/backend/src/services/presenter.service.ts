import { eq, and, inArray, asc } from 'drizzle-orm';
import type {
  ModelCard,
  ModelDetail,
  ModelStatus,
  ModelSourceType,
  MetadataValue,
  MetadataFieldType,
  MetadataFieldDetail,
  CollectionDetail,
  CollectionSummary,
  ImageFile,
  FileTreeNode,
  FileType,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import {
  modelFiles,
  thumbnails,
  collectionModels,
  collections,
  modelMetadata,
  metadataFieldDefinitions,
  tags,
  modelTags,
} from '../db/schema/index.js';
import { modelService } from './model.service.js';
import { metadataService } from './metadata.service.js';
import { collectionService } from './collection.service.js';
import { createLogger } from '../utils/logger.js';
import { formatDisplayValue } from '../utils/format.js';

const logger = createLogger('PresenterService');

const GRID_THUMBNAIL_WIDTH = 400;
const DETAIL_THUMBNAIL_WIDTH = 800;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface IPresenterService {
  buildModelCard(modelId: string): Promise<ModelCard>;
  buildModelCardsFromRows(
    rows: ModelRow[],
    modelIds: string[],
  ): Promise<ModelCard[]>;
  buildModelDetail(modelId: string): Promise<ModelDetail>;
  buildFileTree(files: ModelFileRow[]): FileTreeNode[];
  buildCollectionDetail(collectionId: string): Promise<CollectionDetail>;
  buildMetadataFieldList(): Promise<MetadataFieldDetail[]>;
  buildCollectionList(userId: string, params: { depth?: number }): Promise<CollectionDetail[]>;
}

/** Minimal row shape expected from SearchService. */
export interface ModelRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  fileCount: number;
  totalSizeBytes: number;
  createdAt: Date;
}

/** Minimal model-file row shape needed for file-tree building. */
export interface ModelFileRow {
  id: string;
  filename: string;
  relativePath: string;
  fileType: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PresenterService implements IPresenterService {
  // -----------------------------------------------------------------------
  // buildModelCard — single model
  // -----------------------------------------------------------------------

  async buildModelCard(modelId: string): Promise<ModelCard> {
    const model = await modelService.getModelById(modelId);
    const metadata = await metadataService.getModelMetadata(modelId);
    const thumbnailUrl = await this._resolveGridThumbnailUrl(modelId);

    return {
      id: model.id,
      name: model.name,
      slug: model.slug,
      status: model.status as ModelStatus,
      fileCount: model.fileCount,
      totalSizeBytes: model.totalSizeBytes,
      createdAt: model.createdAt.toISOString(),
      thumbnailUrl,
      metadata,
    };
  }

  // -----------------------------------------------------------------------
  // buildModelCardsFromRows — batch assembly for SearchService
  // -----------------------------------------------------------------------

  async buildModelCardsFromRows(
    rows: ModelRow[],
    modelIds: string[],
  ): Promise<ModelCard[]> {
    if (rows.length === 0) return [];

    // Batch-load thumbnails ------------------------------------------------
    const thumbnailUrlByModel = await this._batchResolveGridThumbnails(modelIds);

    // Batch-load metadata --------------------------------------------------
    const { genericMetaByModel, tagsByModel } =
      await this._batchLoadMetadata(modelIds);

    // Assemble ModelCard results -------------------------------------------
    return rows.map((row) => {
      const metadata: MetadataValue[] = genericMetaByModel.get(row.id) ?? [];
      const tagNames = tagsByModel.get(row.id);
      if (tagNames && tagNames.length > 0) {
        metadata.push({
          fieldSlug: 'tags',
          fieldName: 'Tags',
          type: 'multi_enum',
          value: tagNames,
          displayValue: formatDisplayValue('multi_enum', tagNames),
        });
      }

      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status as ModelStatus,
        fileCount: row.fileCount,
        totalSizeBytes: row.totalSizeBytes,
        createdAt: row.createdAt.toISOString(),
        thumbnailUrl: thumbnailUrlByModel.get(row.id) ?? null,
        metadata,
      };
    });
  }

  // -----------------------------------------------------------------------
  // buildModelDetail — full detail page payload
  // -----------------------------------------------------------------------

  async buildModelDetail(modelId: string): Promise<ModelDetail> {
    const model = await modelService.getModelById(modelId);
    const metadata = await metadataService.getModelMetadata(modelId);

    // Collections this model belongs to
    const membershipRows = await db
      .select({
        id: collections.id,
        name: collections.name,
        slug: collections.slug,
      })
      .from(collectionModels)
      .innerJoin(collections, eq(collectionModels.collectionId, collections.id))
      .where(eq(collectionModels.modelId, modelId));

    const modelCollections: CollectionSummary[] = membershipRows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
    }));

    // Image files + their thumbnails
    const imageFiles = await db
      .select({
        id: modelFiles.id,
        filename: modelFiles.filename,
        relativePath: modelFiles.relativePath,
        modelId: modelFiles.modelId,
      })
      .from(modelFiles)
      .where(
        and(
          eq(modelFiles.modelId, modelId),
          eq(modelFiles.fileType, 'image'),
        ),
      )
      .orderBy(asc(modelFiles.createdAt));

    let images: ImageFile[] = [];
    let thumbnailUrl: string | null = null;

    if (imageFiles.length > 0) {
      const imageFileIds = imageFiles.map((f) => f.id);

      // Load all thumbnails for these image files
      const thumbRows = await db
        .select({
          id: thumbnails.id,
          sourceFileId: thumbnails.sourceFileId,
          width: thumbnails.width,
        })
        .from(thumbnails)
        .where(inArray(thumbnails.sourceFileId, imageFileIds));

      // Index by sourceFileId and size
      const detailThumbByFile = new Map<string, string>();
      const gridThumbByFile = new Map<string, string>();
      for (const t of thumbRows) {
        if (t.width === DETAIL_THUMBNAIL_WIDTH) {
          detailThumbByFile.set(t.sourceFileId, t.id);
        }
        if (t.width === GRID_THUMBNAIL_WIDTH) {
          gridThumbByFile.set(t.sourceFileId, t.id);
        }
      }

      images = imageFiles.map((f) => {
        const detailThumbId = detailThumbByFile.get(f.id);
        const thumbUrl = detailThumbId
          ? `/files/thumbnails/${detailThumbId}.webp`
          : `/files/models/${modelId}/${f.relativePath}`;

        return {
          id: f.id,
          filename: f.filename,
          thumbnailUrl: thumbUrl,
          originalUrl: `/files/models/${modelId}/${f.relativePath}`,
        };
      });

      // Primary thumbnail = grid-size of first image
      const firstGridThumb = gridThumbByFile.get(imageFiles[0].id);
      if (firstGridThumb) {
        thumbnailUrl = `/files/thumbnails/${firstGridThumb}.webp`;
      }
    }

    return {
      id: model.id,
      name: model.name,
      slug: model.slug,
      description: model.description,
      thumbnailUrl,
      metadata,
      sourceType: model.sourceType as ModelSourceType,
      originalFilename: model.originalFilename,
      fileCount: model.fileCount,
      totalSizeBytes: model.totalSizeBytes,
      status: model.status as ModelStatus,
      collections: modelCollections,
      images,
      createdAt: model.createdAt.toISOString(),
      updatedAt: model.updatedAt.toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // buildFileTree — flat relativePaths → nested FileTreeNode[]
  // -----------------------------------------------------------------------

  buildFileTree(files: ModelFileRow[]): FileTreeNode[] {
    const root: FileTreeNode[] = [];

    for (const file of files) {
      const segments = file.relativePath.split('/').filter(Boolean);
      let current = root;

      // Walk/create directory nodes for all but the last segment
      for (let i = 0; i < segments.length - 1; i++) {
        const dirName = segments[i];
        let dirNode = current.find(
          (n) => n.type === 'directory' && n.name === dirName,
        );
        if (!dirNode) {
          dirNode = { name: dirName, type: 'directory', children: [] };
          current.push(dirNode);
        }
        current = dirNode.children!;
      }

      // Add the file node as a leaf
      const fileName = segments[segments.length - 1];
      current.push({
        name: fileName,
        type: 'file',
        fileType: file.fileType as FileType,
        sizeBytes: file.sizeBytes,
        id: file.id,
      });
    }

    // Sort recursively: directories first (alphabetical), then files (alphabetical)
    this._sortTree(root);

    return root;
  }

  // -----------------------------------------------------------------------
  // buildCollectionDetail — delegate to CollectionService
  // -----------------------------------------------------------------------

  async buildCollectionDetail(collectionId: string): Promise<CollectionDetail> {
    return collectionService.getCollectionDetail(collectionId);
  }

  // -----------------------------------------------------------------------
  // buildMetadataFieldList — delegate to MetadataService
  // -----------------------------------------------------------------------

  async buildMetadataFieldList(): Promise<MetadataFieldDetail[]> {
    return metadataService.listFields();
  }

  // -----------------------------------------------------------------------
  // buildCollectionList — delegate to CollectionService
  // -----------------------------------------------------------------------

  async buildCollectionList(
    userId: string,
    params: { depth?: number },
  ): Promise<CollectionDetail[]> {
    return collectionService.listCollections(userId, params);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the grid-size thumbnail URL for a single model.
   */
  private async _resolveGridThumbnailUrl(
    modelId: string,
  ): Promise<string | null> {
    const map = await this._batchResolveGridThumbnails([modelId]);
    return map.get(modelId) ?? null;
  }

  /**
   * Batch-resolve grid-size thumbnail URLs for multiple models.
   * Returns a Map of modelId → thumbnail URL string.
   */
  private async _batchResolveGridThumbnails(
    modelIds: string[],
  ): Promise<Map<string, string>> {
    if (modelIds.length === 0) return new Map();

    // Step 1: find first image file per model
    const imageFileRows = await db
      .select({
        modelId: modelFiles.modelId,
        fileId: modelFiles.id,
      })
      .from(modelFiles)
      .where(
        and(
          inArray(modelFiles.modelId, modelIds),
          eq(modelFiles.fileType, 'image'),
        ),
      )
      .orderBy(asc(modelFiles.createdAt));

    const firstImageFileByModel = new Map<string, string>();
    for (const row of imageFileRows) {
      if (!firstImageFileByModel.has(row.modelId)) {
        firstImageFileByModel.set(row.modelId, row.fileId);
      }
    }

    const imageFileIds = [...firstImageFileByModel.values()];
    if (imageFileIds.length === 0) return new Map();

    // Step 2: find grid-size thumbnail for each image file
    const thumbRows = await db
      .select({
        id: thumbnails.id,
        sourceFileId: thumbnails.sourceFileId,
      })
      .from(thumbnails)
      .where(
        and(
          inArray(thumbnails.sourceFileId, imageFileIds),
          eq(thumbnails.width, GRID_THUMBNAIL_WIDTH),
        ),
      );

    const thumbnailByFileId = new Map<string, string>();
    for (const t of thumbRows) {
      thumbnailByFileId.set(t.sourceFileId, t.id);
    }

    // Step 3: map modelId → URL
    const result = new Map<string, string>();
    for (const [modelId, fileId] of firstImageFileByModel.entries()) {
      const thumbId = thumbnailByFileId.get(fileId);
      if (thumbId) {
        result.set(modelId, `/files/thumbnails/${thumbId}.webp`);
      }
    }

    return result;
  }

  /**
   * Batch-load generic metadata and tags for multiple models.
   */
  private async _batchLoadMetadata(modelIds: string[]): Promise<{
    genericMetaByModel: Map<string, MetadataValue[]>;
    tagsByModel: Map<string, string[]>;
  }> {
    if (modelIds.length === 0) {
      return { genericMetaByModel: new Map(), tagsByModel: new Map() };
    }

    // Generic metadata
    const genericMetaRows = await db
      .select({
        modelId: modelMetadata.modelId,
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
      .where(inArray(modelMetadata.modelId, modelIds));

    const genericMetaByModel = new Map<string, MetadataValue[]>();
    for (const row of genericMetaRows) {
      if (!genericMetaByModel.has(row.modelId)) {
        genericMetaByModel.set(row.modelId, []);
      }
      const type = row.fieldType as MetadataFieldType;
      genericMetaByModel.get(row.modelId)!.push({
        fieldSlug: row.fieldSlug,
        fieldName: row.fieldName,
        type,
        value: row.value,
        displayValue: formatDisplayValue(type, row.value),
      });
    }

    // Tags
    const tagMetaRows = await db
      .select({
        modelId: modelTags.modelId,
        tagName: tags.name,
      })
      .from(modelTags)
      .innerJoin(tags, eq(modelTags.tagId, tags.id))
      .where(inArray(modelTags.modelId, modelIds));

    const tagsByModel = new Map<string, string[]>();
    for (const row of tagMetaRows) {
      if (!tagsByModel.has(row.modelId)) {
        tagsByModel.set(row.modelId, []);
      }
      tagsByModel.get(row.modelId)!.push(row.tagName);
    }

    return { genericMetaByModel, tagsByModel };
  }

  /**
   * Recursively sort a FileTreeNode array: directories first, then files,
   * each group sorted alphabetically by name (case-insensitive).
   */
  private _sortTree(nodes: FileTreeNode[]): void {
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    for (const node of nodes) {
      if (node.children) {
        this._sortTree(node.children);
      }
    }
  }
}

export const presenterService = new PresenterService();
