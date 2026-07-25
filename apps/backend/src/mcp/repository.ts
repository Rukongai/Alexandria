import { asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  collections,
  collectionModels,
  metadataFieldDefinitions,
  modelFiles,
  modelFolders,
  modelMetadata,
  modelTags,
  tags,
  thumbnails,
} from '../db/schema/index.js';

export interface RawModelInformation {
  model: Record<string, unknown>;
  modelFiles: Array<Record<string, unknown>>;
  modelFolders: Array<Record<string, unknown>>;
  metadata: Array<{
    modelMetadata: Record<string, unknown>;
    fieldDefinition: Record<string, unknown>;
  }>;
  tags: {
    rows: Array<Record<string, unknown>>;
    memberships: Array<Record<string, unknown>>;
  };
  collections: {
    rows: Array<Record<string, unknown>>;
    memberships: Array<Record<string, unknown>>;
  };
  thumbnails: Array<Record<string, unknown>>;
}

export interface RawModelRepository {
  getRelatedModelInformation(modelId: string): Promise<Omit<RawModelInformation, 'model'>>;
}

export class PostgresRawModelRepository implements RawModelRepository {
  async getRelatedModelInformation(
    modelId: string,
  ): Promise<Omit<RawModelInformation, 'model'>> {
    const [files, folders, metadata, tagResults, collectionResults, thumbnailRows] =
      await Promise.all([
        db.select().from(modelFiles)
          .where(eq(modelFiles.modelId, modelId))
          .orderBy(asc(modelFiles.relativePath)),
        db.select().from(modelFolders)
          .where(eq(modelFolders.modelId, modelId))
          .orderBy(asc(modelFolders.path)),
        db.select({
          modelMetadata,
          fieldDefinition: metadataFieldDefinitions,
        })
          .from(modelMetadata)
          .innerJoin(
            metadataFieldDefinitions,
            eq(modelMetadata.fieldDefinitionId, metadataFieldDefinitions.id),
          )
          .where(eq(modelMetadata.modelId, modelId)),
        db.select({ membership: modelTags, tag: tags })
          .from(modelTags)
          .innerJoin(tags, eq(modelTags.tagId, tags.id))
          .where(eq(modelTags.modelId, modelId)),
        db.select({ membership: collectionModels, collection: collections })
          .from(collectionModels)
          .innerJoin(collections, eq(collectionModels.collectionId, collections.id))
          .where(eq(collectionModels.modelId, modelId)),
        db.select({ thumbnail: thumbnails })
          .from(thumbnails)
          .innerJoin(modelFiles, eq(thumbnails.sourceFileId, modelFiles.id))
          .where(eq(modelFiles.modelId, modelId)),
      ]);

    return {
      modelFiles: files,
      modelFolders: folders,
      metadata,
      tags: {
        rows: tagResults.map((row) => row.tag),
        memberships: tagResults.map((row) => row.membership),
      },
      collections: {
        rows: collectionResults.map((row) => row.collection),
        memberships: collectionResults.map((row) => row.membership),
      },
      thumbnails: thumbnailRows.map((row) => row.thumbnail),
    };
  }
}

export const rawModelRepository = new PostgresRawModelRepository();
