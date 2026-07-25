import * as React from 'react';
import type { CollectionDetail, ModelDetail, FileTreeNode } from '@alexandria/shared';
import { ModelInfo } from './ModelInfo';
import { MetadataPanel } from './MetadataPanel';
import { CollectionsList } from './CollectionsList';
import { FileTree } from './FileTree';
import { PanelTabs, type PanelTab } from './PanelTabs';
import {
  CollectionsIcon,
  SettingsIcon,
  GroupViewIcon,
} from '../icons';
import type { StlFileRef, TextFileRef } from '../../lib/model-files';

type PanelTabValue = 'info' | 'collections' | 'files';

interface ModelDetailPanelProps {
  model: ModelDetail;
  fileTree: FileTreeNode[];
  onOpenStl: (stl: StlFileRef) => void;
  onOpenText: (file: TextFileRef) => void;
  selectedImageFileId: string | null;
  onSelectImageFile: (fileId: string) => void;
  fileActionsDisabled?: boolean;
  fileActionStatus?: string;
  onCreateFolder?: (path: string) => void;
  onRenameFile?: (fileId: string, filename: string) => void;
  onMoveFile?: (fileId: string, parentPath: string) => Promise<void>;
  onDeleteFile?: (fileId: string, name: string) => void;
  onExtractArchive?: (fileId: string, name: string) => void;
  onMoveFiles?: (fileIds: string[], parentPath: string) => Promise<void>;
  onDeleteFiles?: (fileIds: string[]) => void;
  onSplitFiles?: (fileIds: string[], initialName: string) => void;
  onRenameFolder?: (path: string, name: string) => void;
  onMoveFolder?: (path: string, parentPath: string) => Promise<void>;
  onCompressFolder?: (path: string, name: string) => void;
  onDeleteFolder?: (path: string, name: string) => void;
  onSplitFolder?: (path: string, name: string) => void;
  allCollections: CollectionDetail[];
  collectionsLoading: boolean;
  collectionsError: boolean;
  collectionAddPending: boolean;
  onRetryCollections: () => void;
  onAddToCollections: (collectionIds: string[]) => Promise<void>;
}

/**
 * Tabbed right panel of the model detail page. Hosts the existing detail
 * sub-components under Info / Collections / Files tabs.
 */
export function ModelDetailPanel({
  model,
  fileTree,
  onOpenStl,
  onOpenText,
  selectedImageFileId,
  onSelectImageFile,
  fileActionsDisabled,
  fileActionStatus,
  onCreateFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onExtractArchive,
  onMoveFiles,
  onDeleteFiles,
  onSplitFiles,
  onRenameFolder,
  onMoveFolder,
  onCompressFolder,
  onDeleteFolder,
  onSplitFolder,
  allCollections,
  collectionsLoading,
  collectionsError,
  collectionAddPending,
  onRetryCollections,
  onAddToCollections,
}: ModelDetailPanelProps) {
  const [tab, setTab] = React.useState<PanelTabValue>('info');

  const tabs: PanelTab<PanelTabValue>[] = [
    { value: 'info', label: 'Info', Icon: SettingsIcon },
    {
      value: 'collections',
      label: 'Collections',
      Icon: CollectionsIcon,
      count: model.collections.length,
    },
    { value: 'files', label: 'Files', Icon: GroupViewIcon, count: model.fileCount },
  ];

  return (
    <div className="flex flex-col gap-3">
      <PanelTabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'info' && (
        <div className="flex flex-col gap-3">
          <ModelInfo model={model} />
          <MetadataPanel metadata={model.metadata} modelId={model.id} />
        </div>
      )}

      {tab === 'collections' && (
        <CollectionsList
          collections={model.collections}
          allCollections={allCollections}
          isLoading={collectionsLoading}
          isError={collectionsError}
          isAdding={collectionAddPending}
          onRetry={onRetryCollections}
          onAdd={onAddToCollections}
        />
      )}

      {tab === 'files' && (
        <FileTree
          tree={fileTree}
          modelId={model.id}
          onOpenStl={onOpenStl}
          onOpenText={onOpenText}
          selectedImageFileId={selectedImageFileId}
          onSelectImageFile={onSelectImageFile}
          disabled={fileActionsDisabled}
          operationStatus={fileActionStatus}
          onCreateFolder={onCreateFolder}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onExtractArchive={onExtractArchive}
          onMoveFiles={onMoveFiles}
          onDeleteFiles={onDeleteFiles}
          onSplitFiles={onSplitFiles}
          onRenameFolder={onRenameFolder}
          onMoveFolder={onMoveFolder}
          onCompressFolder={onCompressFolder}
          onDeleteFolder={onDeleteFolder}
          onSplitFolder={onSplitFolder}
        />
      )}
    </div>
  );
}
