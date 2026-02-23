export interface Collection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  userId: string;
  parentCollectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionSummary {
  id: string;
  name: string;
  slug: string;
}

export interface CollectionDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentCollectionId: string | null;
  children: CollectionSummary[];
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionRequest {
  name: string;
  description?: string;
  parentCollectionId?: string;
}

export interface UpdateCollectionRequest {
  name?: string;
  description?: string | null;
  parentCollectionId?: string | null;
}

export interface AddModelsToCollectionRequest {
  modelIds: string[];
}

export interface CollectionListParams {
  depth?: number;
}
