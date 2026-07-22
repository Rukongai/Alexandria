import { and, eq, gt, sql } from 'drizzle-orm';
import type {
  AiApplyProposalResponse,
  AiChange,
  AiChangePreview,
  AiChangePreviewDisplay,
} from '@alexandria/shared';
import { aiChangeSetSchema, ErrorCodes } from '@alexandria/shared';
import { db } from '../db/index.js';
import type { DatabaseExecutor, DatabaseTransaction } from '../db/index.js';
import { aiChangeProposals } from '../db/schema/index.js';
import { collectionService } from './collection.service.js';
import { metadataService } from './metadata.service.js';
import { modelService } from './model.service.js';
import { AppError, conflict, notFound, processingError, validationError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AiProposalService');
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

type ModelDependency = Pick<
  typeof modelService,
  'requireOwnedModel' | 'lockOwnedModels' | 'getModelFiles' | 'updateModel'
>;

export interface AiProposalOperation {
  signal?: AbortSignal;
  deadline?: number;
}
type MetadataDependency = Pick<
  typeof metadataService,
  'getFieldBySlug' | 'setModelMetadata'
>;
type CollectionDependency = Pick<
  typeof collectionService,
  'requireOwnedCollection' | 'getCollectionById' | 'addModelsToCollection' | 'removeModelFromCollection'
>;

export class AiProposalService {
  constructor(
    private readonly models: ModelDependency = modelService,
    private readonly metadata: MetadataDependency = metadataService,
    private readonly collections: CollectionDependency = collectionService,
    private readonly database: typeof db = db,
    private readonly now: () => Date = () => new Date(),
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

    const changedModelIds = new Set(changes.map((change) => change.modelId));
    await this.database.transaction(async (tx) => {
      // Deterministic model-row locking serializes proposals that were prepared
      // from the same state and prevents a stale modelName check from racing.
      await this.models.lockOwnedModels(
        [...changedModelIds],
        userId,
        libraryId,
        tx,
      );
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
        if (change.type === 'update_model') {
          await this.models.updateModel(change.modelId, change.patch, tx);
          continue;
        }
        if (change.type === 'set_metadata') {
          await this.metadata.setModelMetadata(change.modelId, change.values, tx);
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
    return { proposalId, status: 'applied', changedModelIds: [...changedModelIds] };
  }

  private async validateChanges(
    changes: AiChange[],
    userId: string,
    libraryId: string,
    executor: DatabaseExecutor = db,
    operation: AiProposalOperation = {},
  ): Promise<AiChangePreviewDisplay> {
    const display: AiChangePreviewDisplay = { collections: {}, images: {} };
    for (const [index, change] of changes.entries()) {
      assertOperationActive(operation);
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
        for (const [slug, value] of Object.entries(change.values)) {
          let field;
          try {
            field = await this.metadata.getFieldBySlug(slug, executor);
            assertOperationActive(operation);
          } catch (error) {
            if (error instanceof AppError && error.code === ErrorCodes.NOT_FOUND) {
              throw validationError('Metadata field does not exist', `changes.${index}.values.${slug}`);
            }
            throw error;
          }
          if (!this.isValidMetadataValue(field.type, value)) {
            throw validationError(
              `Value does not match metadata field type ${field.type}`,
              `changes.${index}.values.${slug}`,
            );
          }
        }
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
      }
    }
    return display;
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

  private isValidMetadataValue(type: string, value: unknown): boolean {
    if (value === null) return true;
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'boolean') return typeof value === 'boolean';
    if (type === 'multi_enum') {
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    }
    return typeof value === 'string';
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
