export type MetadataFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'url'
  | 'enum'
  | 'multi_enum';

export interface MetadataFieldConfig {
  enumOptions?: string[];
  validationPattern?: string;
  displayHint?: string;
}

export interface MetadataFieldDefinition {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
  isDefault: boolean;
  isFilterable: boolean;
  isBrowsable: boolean;
  config: MetadataFieldConfig | null;
  sortOrder: number;
  createdAt: string;
}

export interface ModelMetadata {
  id: string;
  modelId: string;
  fieldDefinitionId: string;
  value: string;
}

export interface Tag {
  id: string;
  name: string;
  slug: string;
}

export interface MetadataValue {
  fieldSlug: string;
  fieldName: string;
  type: MetadataFieldType;
  value: string | string[];
  displayValue: string;
}

export interface MetadataFieldSummary {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
}

export interface MetadataFieldDetail {
  id: string;
  name: string;
  slug: string;
  type: MetadataFieldType;
  isDefault: boolean;
  isFilterable: boolean;
  isBrowsable: boolean;
  config: MetadataFieldConfig | null;
  sortOrder: number;
}

export interface MetadataFieldValue {
  value: string;
  modelCount: number;
}

export interface CreateMetadataFieldRequest {
  name: string;
  type: MetadataFieldType;
  isFilterable?: boolean;
  isBrowsable?: boolean;
  config?: MetadataFieldConfig;
}

export interface UpdateMetadataFieldRequest {
  name?: string;
  isFilterable?: boolean;
  isBrowsable?: boolean;
  config?: MetadataFieldConfig;
}

export interface SetModelMetadataRequest {
  [fieldSlug: string]: string | string[] | number | boolean | null;
}
