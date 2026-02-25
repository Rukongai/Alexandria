export interface Library {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  pathTemplate: string;
  createdAt: string;
  updatedAt: string;
}

export interface LibrarySummary {
  id: string;
  name: string;
  slug: string;
}

export interface CreateLibraryRequest {
  name: string;
  rootPath: string;
  pathTemplate: string;
}

export interface UpdateLibraryRequest {
  name?: string;
  rootPath?: string;
  pathTemplate?: string;
}
