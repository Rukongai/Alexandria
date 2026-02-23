import type {
  BulkMetadataRequest,
  BulkCollectionRequest,
  BulkDeleteRequest,
} from '@alexandria/shared';
import { post } from './client';

export async function bulkMetadata(data: BulkMetadataRequest): Promise<void> {
  await post('/bulk/metadata', data);
}

export async function bulkCollection(data: BulkCollectionRequest): Promise<void> {
  await post('/bulk/collection', data);
}

export async function bulkDelete(data: BulkDeleteRequest): Promise<void> {
  await post('/bulk/delete', data);
}
