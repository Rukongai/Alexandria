import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  aiChangeProposals,
  importSessions,
  libraries,
  models,
  users,
} from '../db/schema/index.js';
import { collectionService } from './collection.service.js';
import { jobService } from './job.service.js';
import { modelService } from './model.service.js';
import { AiProposalService } from './ai-proposal.service.js';
import { IngestionService } from './ingestion.service.js';

vi.mock('./job.service.js', async () => {
  const actual = await vi.importActual<typeof import('./job.service.js')>('./job.service.js');
  return {
    ...actual,
    jobService: {
      enqueueCommitJob: vi.fn().mockResolvedValue('integration-commit-job'),
    },
  };
});

describe('IngestionService real-database commit claim', () => {
  it('serializes two real commit transactions so only one model is created', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [user] = await db.insert(users).values({
      email: `ingestion-commit-race-${suffix}@example.com`,
      displayName: 'Ingestion Commit Race Test',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    }).returning();
    const [library] = await db.insert(libraries).values({
      name: 'Ingestion Commit Race Library',
      slug: `ingestion-commit-race-library-${suffix}`,
      userId: user.id,
      isDefault: true,
    }).returning();
    const [session] = await db.insert(importSessions).values({
      userId: user.id,
      libraryId: library.id,
      originalFilename: 'Concurrent Dragon.zip',
      status: 'ready_for_review',
    }).returning();
    const service = new IngestionService();
    vi.mocked(jobService.enqueueCommitJob).mockClear();

    try {
      const outcomes = await Promise.allSettled([
        service.handleCommit(session.id, { modelName: 'Concurrent Dragon' }, user.id, library.id),
        service.handleCommit(session.id, { modelName: 'Concurrent Dragon' }, user.id, library.id),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const createdModels = await db.select({ id: models.id })
        .from(models)
        .where(eq(models.libraryId, library.id));
      expect(createdModels).toHaveLength(1);
      expect(jobService.enqueueCommitJob).toHaveBeenCalledTimes(1);
    } finally {
      await db.delete(importSessions).where(eq(importSessions.id, session.id));
      await db.delete(models).where(eq(models.libraryId, library.id));
      await db.delete(libraries).where(eq(libraries.id, library.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});

describe('AiProposalService real-database transaction', () => {
  it('serializes stale-name proposals so only one can overwrite a model', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [user] = await db.insert(users).values({
      email: `ai-proposal-race-${suffix}@example.com`,
      displayName: 'AI Proposal Race Test',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    }).returning();
    const [library] = await db.insert(libraries).values({
      name: 'AI Proposal Race Library',
      slug: `ai-proposal-race-library-${suffix}`,
      userId: user.id,
      isDefault: true,
    }).returning();
    const originalName = 'Concurrent Dragon';
    const [model] = await db.insert(models).values({
      name: originalName,
      slug: `ai-proposal-race-model-${suffix}`,
      userId: user.id,
      libraryId: library.id,
      sourceType: 'manual',
      status: 'ready',
    }).returning();
    const proposals = await db.insert(aiChangeProposals).values([
      {
        userId: user.id,
        libraryId: library.id,
        status: 'pending' as const,
        summary: 'First concurrent rename',
        changes: [{
          type: 'update_model' as const,
          modelId: model.id,
          modelName: originalName,
          patch: { name: 'Concurrent Dragon A' },
        }],
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        userId: user.id,
        libraryId: library.id,
        status: 'pending' as const,
        summary: 'Second concurrent rename',
        changes: [{
          type: 'update_model' as const,
          modelId: model.id,
          modelName: originalName,
          patch: { name: 'Concurrent Dragon B' },
        }],
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]).returning();
    const service = new AiProposalService();

    try {
      const outcomes = await Promise.allSettled(proposals.map(
        (proposal) => service.apply(proposal.id, user.id, library.id),
      ));

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const [storedModel] = await db.select({ name: models.name })
        .from(models)
        .where(eq(models.id, model.id));
      expect(['Concurrent Dragon A', 'Concurrent Dragon B']).toContain(storedModel.name);
      const storedProposals = await Promise.all(proposals.map(async (proposal) => {
        const [stored] = await db.select({ status: aiChangeProposals.status })
          .from(aiChangeProposals)
          .where(eq(aiChangeProposals.id, proposal.id));
        return stored.status;
      }));
      expect(storedProposals.sort()).toEqual(['applied', 'pending']);
    } finally {
      for (const proposal of proposals) {
        await db.delete(aiChangeProposals).where(eq(aiChangeProposals.id, proposal.id));
      }
      await db.delete(models).where(eq(models.id, model.id));
      await db.delete(libraries).where(eq(libraries.id, library.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });

  it('rolls back an earlier domain mutation when a later mutation fails', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [user] = await db.insert(users).values({
      email: `ai-proposal-rollback-${suffix}@example.com`,
      displayName: 'AI Proposal Rollback Test',
      passwordHash: 'not-a-real-hash',
      role: 'admin',
    }).returning();
    const [library] = await db.insert(libraries).values({
      name: 'AI Proposal Rollback Library',
      slug: `ai-proposal-rollback-library-${suffix}`,
      userId: user.id,
      isDefault: true,
    }).returning();
    const originalName = 'Rollback Dragon';
    const [model] = await db.insert(models).values({
      name: originalName,
      slug: `ai-proposal-rollback-model-${suffix}`,
      userId: user.id,
      libraryId: library.id,
      sourceType: 'manual',
      status: 'ready',
    }).returning();
    const [proposal] = await db.insert(aiChangeProposals).values({
      userId: user.id,
      libraryId: library.id,
      status: 'pending',
      summary: 'Rename then update metadata',
      changes: [
        {
          type: 'update_model',
          modelId: model.id,
          modelName: originalName,
          patch: { name: 'Name That Must Roll Back' },
        },
        {
          type: 'set_metadata',
          modelId: model.id,
          modelName: originalName,
          values: { artist: 'Example Artist' },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();

    const metadata = {
      getFieldBySlug: vi.fn().mockResolvedValue({ slug: 'artist', type: 'text' }),
      normalizeAndValidateFieldValue: vi.fn((_field, value) => value),
      setModelMetadata: vi.fn().mockRejectedValue(new Error('forced later mutation failure')),
    };
    const service = new AiProposalService(
      modelService,
      metadata as never,
      collectionService,
      db,
    );

    try {
      await expect(service.apply(proposal.id, user.id, library.id))
        .rejects.toThrow('forced later mutation failure');

      const [storedModel] = await db.select({ name: models.name })
        .from(models)
        .where(eq(models.id, model.id));
      const [storedProposal] = await db.select({ status: aiChangeProposals.status })
        .from(aiChangeProposals)
        .where(eq(aiChangeProposals.id, proposal.id));
      expect(storedModel.name).toBe(originalName);
      expect(storedProposal.status).toBe('pending');
      expect(metadata.setModelMetadata).toHaveBeenCalledWith(
        model.id,
        { artist: 'Example Artist' },
        expect.anything(),
      );
    } finally {
      await db.delete(aiChangeProposals).where(eq(aiChangeProposals.id, proposal.id));
      await db.delete(models).where(eq(models.id, model.id));
      await db.delete(libraries).where(eq(libraries.id, library.id));
      await db.delete(users).where(eq(users.id, user.id));
    }
  });
});
