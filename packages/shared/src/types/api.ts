export interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta | null;
  errors: ApiError[] | null;
}

export interface ResponseMeta {
  total: number;
  cursor: string | null;
  pageSize: number;
}

export interface ApiError {
  code: string;
  field: string | null;
  message: string;
}

export interface BulkMetadataRequest {
  modelIds: string[];
  operations: BulkMetadataOperation[];
}

export interface BulkMetadataOperation {
  fieldSlug: string;
  action: 'set' | 'add' | 'remove';
  value?: string | string[] | number | boolean;
}

export interface BulkCollectionRequest {
  modelIds: string[];
  action: 'add' | 'remove' | 'move';
  collectionId: string;
}

export interface BulkDeleteRequest {
  modelIds: string[];
}
