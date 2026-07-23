import { and, eq, gt, sql } from 'drizzle-orm';
import type {
  AiApplyProposalResponse,
  AiChange,
  AiChangePreview,
  AiChangePreviewDisplay,
  BulkMetadataOperation,
} from '@alexandria/shared';
import { aiBulkChangeSetSchema, aiChangeSetSchema, ErrorCodes } from '@alexandria/shared';
import { db } from '../db/index.js';
import type { DatabaseExecutor, DatabaseTransaction } from '../db/index.js';
import { aiChangeProposals } from '../db/schema/index.js';
import { collectionService } from './collection.service.js';
import { metadataService } from './metadata.service.js';
import { modelService } from './model.service.js';
import { importSessionService } from './import-session.service.js';
import { AppError, conflict, notFound, processingError, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AiProposalService');
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
// Bounds frozen proposal JSON/API response size while still covering substantial
// personal libraries. Larger libraries must be handled by a future background job.
export const MAX_AI_BULK_MODELS = 500;

type ModelDependency = Pick<
  typeof modelService,
  | 'requireOwnedModel'
  | 'requireOwnedModels'
  | 'listOwnedModelIds'
  | 'lockOwnedModels'
  | 'getModelFiles'
  | 'updateModel'
>;

export interface AiProposalOperation {
  signal?: AbortSignal;
  deadline?: number;
}
type MetadataDependency = Pick<
  typeof metadataService,
  | 'getFieldBySlug'
  | 'setModelMetadata'
  | 'validateBulkOperations'
  | 'bulkSetMetadata'
  | 'normalizeAndValidateFieldValue'
>;
type CollectionDependency = Pick<
  typeof collectionService,
  | 'requireOwnedCollection'
  | 'getCollectionById'
  | 'addModelsToCollection'
  | 'removeModelFromCollection'
  | 'removeModelsFromCollection'
>;
type ImportSessionDependency = Pick<
  typeof importSessionService,
  | 'getOwnedReadyForReviewRow'
  | 'lockOwnedReadyForReviewSessions'
  | 'updateDraftMetadata'
>;

export class AiProposalService {
  constructor(
    private readonly models: ModelDependency = modelService,
    private readonly metadata: MetadataDependency = metadataService,
    private readonly collections: CollectionDependency = collectionService,
    private readonly database: typeof db = db,
    private readonly now: () => Date = () => new Date(),
    private readonly importSessions: ImportSessionDependency = importSessionService,
  ) {}

  async createPreview(
    userId: string,
    libraryId: string,
    input: unknown,
    operation: AiProposalOperation = {},
  ): Promise<AiChangePreview> {
    const parsed = aiChangeSetSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw validationError(issue?.message ?? 'Invalid AI change proposal', issue?.path.join('.'));
    }

    // Clone the validated payload before checking and persisting so no caller
    // can mutate the object after preview creation.
    const payload = structuredClone(parsed.data) as { summary: string; changes: AiChange[] };
    const expiresAt = new Date(this.now().getTime() + PROPOSAL_TTL_MS);
    const result = await this.database.transaction(async (tx) => {
      await this.configureOperationTransaction(tx, operation);
      assertOperationActive(operation);
      const display = await this.validateChanges(
        payload.changes,
        userId,
        libraryId,
        tx,
        operation,
      );
      assertOperationActive(operation);
      const [row] = await tx
        .insert(aiChangeProposals)
        .values({
          userId,
          libraryId,
          status: 'pending',
          summary: payload.summary,
          changes: payload.changes,
          expiresAt,
        })
        .returning({ id: aiChangeProposals.id });
      // If cancellation/deadline happened while INSERT was in flight, throwing
      // here rolls it back instead of committing a proposal after the caller left.
      assertOperationActive(operation);
      return { row, display };
    });

    logger.info(
      { service: 'AiProposalService', proposalId: result.row.id, userId, libraryId },
      'AI change proposal preview created',
    );
    return {
      proposalId: result.row.id,
      summary: payload.summary,
      changes: payload.changes,
      expiresAt: expiresAt.toISOString(),
      display: result.display,
    };
  }

  async createBulkPreview(
    userId: string,
    libraryId: string,
    input: unknown,
    currentModelIds: string[],
    operation: AiProposalOperation = {},
  ): Promise<AiChangePreview> {
    const parsed = aiBulkChangeSetSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw validationError(issue?.message ?? 'Invalid AI bulk change proposal', issue?.path.join('.'));
    }

    const expiresAt = new Date(this.now().getTime() + PROPOSAL_TTL_MS);
    const result = await this.database.transaction(async (tx) => {
      await this.configureOperationTransaction(tx, operation);
      assertOperationActive(operation);

      let resolvedModelIds: string[];
      if (parsed.data.target.scope === 'current_models') {
        resolvedModelIds = [...new Set(currentModelIds)].sort();
        if (resolvedModelIds.length === 0) {
          throw validationError(
            'No current model targets are available for this bulk proposal',
            'target.scope',
          );
        }
        if (resolvedModelIds.length > MAX_AI_BULK_MODELS) {
          throw validationError(
            `Bulk proposals support at most ${MAX_AI_BULK_MODELS} models`,
            'target.scope',
          );
        }
      } else {
        // Fetch one extra ID so a proposal never stores an unbounded library
        // snapshot or silently applies only part of a larger library.
        resolvedModelIds = await this.models.listOwnedModelIds(
          userId,
          libraryId,
          MAX_AI_BULK_MODELS + 1,
          tx,
        );
        assertOperationActive(operation);
        if (resolvedModelIds.length > MAX_AI_BULK_MODELS) {
          throw validationError(
            `Active-library bulk proposals support at most ${MAX_AI_BULK_MODELS} models`,
            'target.scope',
          );
        }
        if (resolvedModelIds.length === 0) {
          throw validationError('The active library has no models', 'target.scope');
        }
        resolvedModelIds = [...new Set(resolvedModelIds)].sort();
      }

      const changes: AiChange[] = [];
      if (parsed.data.metadataOperations) {
        changes.push({
          type: 'bulk_metadata',
          modelIds: resolvedModelIds,
          operations: parsed.data.metadataOperations,
        });
      }
      if (parsed.data.collectionOperations) {
        changes.push({
          type: 'bulk_collections',
          modelIds: resolvedModelIds,
          operations: parsed.data.collectionOperations,
        });
      }
      const payload = structuredClone({ summary: parsed.data.summary, changes });
      const canonical = aiChangeSetSchema.parse(payload) as { summary: string; changes: AiChange[] };
      const display = await this.validateChanges(
        canonical.changes,
        userId,
        libraryId,
        tx,
        operation,
        parsed.data.target.scope,
      );
      assertOperationActive(operation);
      const [row] = await tx
        .insert(aiChangeProposals)
        .values({
          userId,
          libraryId,
          status: 'pending',
          summary: canonical.summary,
          changes: canonical.changes,
          expiresAt,
        })
        .returning({ id: aiChangeProposals.id });
      assertOperationActive(operation);
      return { row, display, payload: canonical };
    });

    logger.info(
      {
        service: 'AiProposalService',
        proposalId: result.row.id,
        userId,
        libraryId,
        modelCount: result.payload.changes[0]
          && (result.payload.changes[0].type === 'bulk_metadata'
            || result.payload.changes[0].type === 'bulk_collections')
          ? result.payload.changes[0].modelIds.length
          : 0,
      },
      'AI bulk change proposal preview created',
    );
    return {
      proposalId: result.row.id,
      summary: result.payload.summary,
      changes: result.payload.changes,
      expiresAt: expiresAt.toISOString(),
      display: result.display,
    };
  }

  async apply(
    proposalId: string,
    userId: string,
    libraryId: string,
  ): Promise<AiApplyProposalResponse> {
    const [row] = await this.database
      .select({
        id: aiChangeProposals.id,
        userId: aiChangeProposals.userId,
        libraryId: aiChangeProposals.libraryId,
        status: aiChangeProposals.status,
        summary: aiChangeProposals.summary,
        changes: aiChangeProposals.changes,
        expiresAt: aiChangeProposals.expiresAt,
        isExpired: sql<boolean>`${aiChangeProposals.expiresAt} <= now()`,
      })
      .from(aiChangeProposals)
      .where(and(
        eq(aiChangeProposals.id, proposalId),
        eq(aiChangeProposals.userId, userId),
        eq(aiChangeProposals.libraryId, libraryId),
      ))
      .limit(1);

    if (!row) throw notFound('AI change proposal not found');
    if (row.status !== 'pending') throw conflict('AI change proposal has already been used');
    if (row.isExpired) throw conflict('AI change proposal has expired');

    const parsed = aiChangeSetSchema.safeParse({ summary: row.summary, changes: row.changes });
    if (!parsed.success) {
      throw conflict('Stored AI change proposal is invalid');
    }
    const changes = parsed.data.changes as AiChange[];

    const changedModelIds = new Set(changes.flatMap((change) => {
      if (change.type === 'update_import_session') return [];
      if (change.type === 'bulk_metadata' || change.type === 'bulk_collections') {
        return change.modelIds;
      }
      return [change.modelId];
    }));
    const changedImportSessionIds = new Set(changes.flatMap((change) =>
      change.type === 'update_import_session' ? [change.importSessionId] : []));
    await this.database.transaction(async (tx) => {
      // Deterministic model-row locking serializes proposals that were prepared
      // from the same state and prevents a stale modelName check from racing.
      if (changedModelIds.size > 0) {
        await this.models.lockOwnedModels(
          [...changedModelIds],
          userId,
          libraryId,
          tx,
        );
      }
      if (changedImportSessionIds.size > 0) {
        await this.importSessions.lockOwnedReadyForReviewSessions(
          [...changedImportSessionIds],
          userId,
          libraryId,
          tx,
        );
      }
      await this.validateChanges(changes, userId, libraryId, tx);

      const [claimed] = await tx
        .update(aiChangeProposals)
        .set({ status: 'applying' })
        .where(and(
          eq(aiChangeProposals.id, proposalId),
          eq(aiChangeProposals.userId, userId),
          eq(aiChangeProposals.libraryId, libraryId),
          eq(aiChangeProposals.status, 'pending'),
          gt(aiChangeProposals.expiresAt, sql`now()`),
        ))
        .returning({ id: aiChangeProposals.id });
      if (!claimed) throw conflict('AI change proposal is expired or already being applied');

      for (const change of changes) {
        if (change.type === 'update_import_session') {
          await this.importSessions.updateDraftMetadata(
            change.importSessionId,
            change.patch,
            tx,
          );
          continue;
        }
        if (change.type === 'update_model') {
          await this.models.updateModel(change.modelId, change.patch, tx);
          continue;
        }
        if (change.type === 'set_metadata') {
          await this.metadata.setModelMetadata(change.modelId, change.values, tx);
          continue;
        }
        if (change.type === 'bulk_metadata') {
          await this.metadata.bulkSetMetadata(change.modelIds, change.operations, tx);
          continue;
        }
        if (change.type === 'bulk_collections') {
          for (const operation of change.operations) {
            if (operation.action === 'add') {
              await this.collections.addModelsToCollection(
                operation.collectionId,
                change.modelIds,
                tx,
              );
            } else {
              await this.collections.removeModelsFromCollection(
                operation.collectionId,
                change.modelIds,
                tx,
              );
            }
          }
          continue;
        }
        for (const collectionId of change.addCollectionIds) {
          await this.collections.addModelsToCollection(collectionId, [change.modelId], tx);
        }
        for (const collectionId of change.removeCollectionIds) {
          await this.collections.removeModelFromCollection(collectionId, change.modelId, tx);
        }
      }

      await tx
        .update(aiChangeProposals)
        .set({ status: 'applied', appliedAt: sql`now()` })
        .where(and(eq(aiChangeProposals.id, proposalId), eq(aiChangeProposals.status, 'applying')));
    });

    logger.info(
      { service: 'AiProposalService', proposalId, userId, libraryId },
      'AI change proposal applied',
    );
    return {
      proposalId,
      status: 'applied',
      changedModelIds: [...changedModelIds],
      changedImportSessionIds: [...changedImportSessionIds],
    };
  }

  private async validateChanges(
    changes: AiChange[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor = db,
    operation: AiProposalOperation = {},
    bulkTargetScope?: 'current_models' | 'active_library',
  ): Promise<AiChangePreviewDisplay> {
    const display: AiChangePreviewDisplay = { collections: {}, images: {} };
    let validatedBulkKey: string | null = null;
    let validatedBulkModels: Awaited<ReturnType<ModelDependency['requireOwnedModels']>> = [];
    for (const [index, change] of changes.entries()) {
      assertOperationActive(operation);
      if (change.type === 'update_import_session') {
        const session = await this.importSessions.getOwnedReadyForReviewRow(
          change.importSessionId,
          userId,
          libraryId,
          executor,
        );
        assertOperationActive(operation);
        if (change.originalFilename !== session.originalFilename) {
          throw validationError(
            'Original filename does not match the referenced import session',
            `changes.${index}.originalFilename`,
          );
        }
        if (change.expectedUpdatedAt !== session.updatedAt.toISOString()) {
          throw validationError(
            'Import session changed after this proposal was prepared',
            `changes.${index}.expectedUpdatedAt`,
          );
        }
        if (change.patch.metadata) {
          await this.validateMetadataValues(
            change.patch.metadata,
            `changes.${index}.patch.metadata`,
            executor,
            operation,
          );
        }
        if (change.patch.collectionId) {
          await this.resolveCollectionDisplay(
            change.patch.collectionId,
            userId,
            libraryId,
            display,
            executor,
            operation,
          );
        }
        continue;
      }
      if (change.type === 'bulk_metadata' || change.type === 'bulk_collections') {
        const bulkKey = change.modelIds.join(',');
        if (validatedBulkKey !== bulkKey) {
          validatedBulkModels = await this.models.requireOwnedModels(
            change.modelIds,
            userId,
            libraryId,
            executor,
          );
          validatedBulkKey = bulkKey;
        }
        assertOperationActive(operation);
        if (bulkTargetScope && !display.bulkTarget) {
          display.bulkTarget = {
            scope: bulkTargetScope,
            modelCount: validatedBulkModels.length,
            sampleModelNames: validatedBulkModels.slice(0, 5).map((model) => model.name),
          };
        }
        if (change.type === 'bulk_metadata') {
          await this.validateBulkMetadataOperations(
            change.operations,
            `changes.${index}.operations`,
            executor,
            operation,
          );
        } else {
          for (const [operationIndex, collectionOperation] of change.operations.entries()) {
            await this.resolveCollectionDisplay(
              collectionOperation.collectionId,
              userId,
              libraryId,
              display,
              executor,
              operation,
            );
            assertOperationActive(operation);
            if (change.operations.some((candidate, candidateIndex) =>
              candidateIndex !== operationIndex
              && candidate.collectionId === collectionOperation.collectionId)) {
              throw validationError(
                'A collection may have only one bulk operation',
                `changes.${index}.operations.${operationIndex}`,
              );
            }
          }
        }
        continue;
      }
      const model = await this.models.requireOwnedModel(
        change.modelId,
        userId,
        libraryId,
        executor,
      );
      assertOperationActive(operation);
      if (change.modelName !== model.name) {
        throw validationError('Model name does not match the referenced model', `changes.${index}.modelName`);
      }

      if (change.type === 'update_model' && change.patch.previewImageFileId) {
        const files = await this.models.getModelFiles(change.modelId, executor);
        assertOperationActive(operation);
        const image = files.find(
          (file) => file.id === change.patch.previewImageFileId && file.fileType === 'image',
        );
        if (!image) {
          throw validationError(
            'Preview image must belong to the referenced model',
            `changes.${index}.patch.previewImageFileId`,
          );
        }
        display.images[image.id] = {
          filename: image.filename,
          thumbnailUrl: `/files/models/${change.modelId}/${encodeRelativePath(image.relativePath)}`,
        };
      }

      if (change.type === 'set_metadata') {
        await this.validateMetadataValues(
          change.values,
          `changes.${index}.values`,
          executor,
          operation,
        );
      }

      if (change.type === 'update_collections') {
        const overlap = change.addCollectionIds.find((id) => change.removeCollectionIds.includes(id));
        if (overlap) {
          throw validationError(
            'A collection cannot be both added and removed',
            `changes.${index}`,
          );
        }
        const ids = new Set([...change.addCollectionIds, ...change.removeCollectionIds]);
        for (const collectionId of ids) {
          await this.resolveCollectionDisplay(
            collectionId,
            userId,
            libraryId,
            display,
            executor,
            operation,
          );
        }
      }
    }
    return display;
  }

  private async validateBulkMetadataOperations(
    operations: BulkMetadataOperation[],
    path: string,
    executor: DatabaseExecutor,
    operationContext: AiProposalOperation,
  ): Promise<void> {
    try {
      await this.metadata.validateBulkOperations(operations, executor);
      assertOperationActive(operationContext);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCodes.NOT_FOUND) {
        throw validationError('Metadata field does not exist', path);
      }
      if (error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR) {
        throw validationError(error.message, path);
      }
      throw error;
    }
  }

  private async validateMetadataValues(
    values: Record<string, unknown>,
    path: string,
    executor: DatabaseExecutor,
    operation: AiProposalOperation,
  ): Promise<void> {
    for (const [slug, value] of Object.entries(values)) {
      let field;
      try {
        field = await this.metadata.getFieldBySlug(slug, executor);
        assertOperationActive(operation);
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCodes.NOT_FOUND) {
          throw validationError('Metadata field does not exist', `${path}.${slug}`);
        }
        throw error;
      }
      try {
        this.metadata.normalizeAndValidateFieldValue(field, value);
      } catch (error) {
        if (error instanceof AppError && error.code === ErrorCodes.VALIDATION_ERROR) {
          throw validationError(error.message, `${path}.${slug}`);
        }
        throw error;
      }
    }
  }

  private async resolveCollectionDisplay(
    collectionId: string,
    userId: string,
    libraryId: string,
    display: AiChangePreviewDisplay,
    executor: DatabaseExecutor,
    operation: AiProposalOperation,
  ): Promise<void> {
    await this.collections.requireOwnedCollection(
      collectionId,
      userId,
      libraryId,
      executor,
    );
    assertOperationActive(operation);
    if (!display.collections[collectionId]) {
      const collection = await this.collections.getCollectionById(collectionId, executor);
      assertOperationActive(operation);
      display.collections[collectionId] = { name: collection.name };
    }
  }

  private async configureOperationTransaction(
    tx: DatabaseTransaction,
    operation: AiProposalOperation,
  ): Promise<void> {
    assertOperationActive(operation);
    if (operation.deadline === undefined) return;
    const remainingMs = Math.max(1, Math.floor(operation.deadline - Date.now()));
    await tx.execute(sql`select set_config('statement_timeout', ${`${remainingMs}ms`}, true)`);
    assertOperationActive(operation);
  }

}

function encodeRelativePath(relativePath: string): string {
  return relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function assertOperationActive(operation: AiProposalOperation): void {
  if (operation.signal?.aborted) {
    throw processingError('AI assistant request was cancelled');
  }
  if (operation.deadline !== undefined && Date.now() >= operation.deadline) {
    throw processingError('AI assistant exceeded the request deadline');
  }
}

export const aiProposalService = new AiProposalService();
