import type {
  BulkCollectionRequest,
  BulkDeleteRequest,
  BulkMetadataRequest,
} from '@alexandria/shared';
import { db } from '../db/index.js';
import { collectionService } from './collection.service.js';
import { metadataService } from './metadata.service.js';
import { modelService } from './model.service.js';
import { storageService } from './storage.service.js';
import { validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('BulkService');
const MAX_BULK_MODELS = 500;
const MAX_BULK_METADATA_OPERATIONS = 25;

type ModelDependency = Pick<
  typeof modelService,
  'lockOwnedModels' | 'listModelStoragePaths' | 'deleteModels'
>;
type MetadataDependency = Pick<typeof metadataService, 'bulkSetMetadata'>;
type CollectionDependency = Pick<
  typeof collectionService,
  'lockOwnedCollection' | 'bulkCollectionOperation'
>;
type StorageDependency = Pick<typeof storageService, 'deleteMany'>;

export interface BulkDeleteResult {
  deletedCount: number;
  deletedIds: string[];
}

export class BulkService {
  constructor(
    private readonly models: ModelDependency = modelService,
    private readonly metadata: MetadataDependency = metadataService,
    private readonly collections: CollectionDependency = collectionService,
    private readonly storage: StorageDependency = storageService,
    private readonly database: typeof db = db,
  ) {}

  async setMetadata(
    request: BulkMetadataRequest,
    userId: string,
    libraryId: string,
  ): Promise<void> {
    const modelIds = this.validateModelIds(request.modelIds);
    if (request.operations.length === 0
      || request.operations.length > MAX_BULK_METADATA_OPERATIONS) {
      throw validationError(
        `Bulk metadata requires between 1 and ${MAX_BULK_METADATA_OPERATIONS} operations`,
      );
    }
    await this.database.transaction(async (tx) => {
      await this.models.lockOwnedModels(modelIds, userId, libraryId, tx);
      await this.metadata.bulkSetMetadata(modelIds, request.operations, tx);
    });
  }

  async updateCollection(
    request: BulkCollectionRequest,
    userId: string,
    libraryId: string,
  ): Promise<void> {
    const modelIds = this.validateModelIds(request.modelIds);
    await this.database.transaction(async (tx) => {
      await this.models.lockOwnedModels(modelIds, userId, libraryId, tx);
      await this.collections.lockOwnedCollection(
        request.collectionId,
        userId,
        libraryId,
        tx,
      );
      await this.collections.bulkCollectionOperation({ ...request, modelIds }, tx);
    });
  }

  async deleteModels(
    request: BulkDeleteRequest,
    userId: string,
    libraryId: string,
  ): Promise<BulkDeleteResult> {
    const modelIds = this.validateModelIds(request.modelIds);
    const result = await this.database.transaction(async (tx) => {
      await this.models.lockOwnedModels(modelIds, userId, libraryId, tx);
      const storagePaths = await this.models.listModelStoragePaths(modelIds, tx);
      const deletedIds = (await this.models.deleteModels(modelIds, tx)).sort();
      return { deletedIds, storagePaths };
    });

    // One request per ~100 objects rather than one per object: a bulk delete of
    // a few models is otherwise thousands of sequential round trips.
    const failures = await this.storage.deleteMany(result.storagePaths);
    for (const failure of failures) {
      logger.warn(
        { service: 'BulkService', storagePath: failure.filePath, err: failure.reason },
        'Best-effort bulk model storage cleanup failed',
      );
    }
    return { deletedCount: result.deletedIds.length, deletedIds: result.deletedIds };
  }

  private validateModelIds(modelIds: string[]): string[] {
    if (modelIds.length === 0 || modelIds.length > MAX_BULK_MODELS) {
      throw validationError(`Bulk operations require between 1 and ${MAX_BULK_MODELS} models`);
    }
    const uniqueIds = [...new Set(modelIds)].sort();
    if (uniqueIds.length !== modelIds.length) {
      throw validationError('Bulk model IDs must be unique');
    }
    return uniqueIds;
  }
}

export const bulkService = new BulkService();
