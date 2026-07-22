import * as React from 'react';
import type { ModelDetail, FileTreeNode } from '@alexandria/shared';
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
import type { StlFileRef } from '../../lib/model-files';

type PanelTabValue = 'info' | 'collections' | 'files';

interface ModelDetailPanelProps {
  model: ModelDetail;
  fileTree: FileTreeNode[];
  onOpenStl: (stl: StlFileRef) => void;
  selectedImageFileId: string | null;
  onSelectImageFile: (fileId: string) => void;
  fileActionsDisabled?: boolean;
  onCreateFolder?: (path: string) => void;
  onRenameFile?: (fileId: string, filename: string) => void;
  onMoveFile?: (fileId: string, parentPath: string) => void;
  onDeleteFile?: (fileId: string, name: string) => void;
  onMoveFiles?: (fileIds: string[], parentPath: string) => void;
  onDeleteFiles?: (fileIds: string[]) => void;
  onRenameFolder?: (path: string, name: string) => void;
  onMoveFolder?: (path: string, parentPath: string) => void;
  onDeleteFolder?: (path: string, name: string) => void;
}

/**
 * Tabbed right panel of the model detail page. Hosts the existing detail
 * sub-components under Info / Collections / Files tabs.
 */
export function ModelDetailPanel({
  model,
  fileTree,
  onOpenStl,
  selectedImageFileId,
  onSelectImageFile,
  fileActionsDisabled,
  onCreateFolder,
  onRenameFile,
  onMoveFile,
  onDeleteFile,
  onMoveFiles,
  onDeleteFiles,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
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

      {tab === 'collections' && <CollectionsList collections={model.collections} />}

      {tab === 'files' && (
        <FileTree
          tree={fileTree}
          modelId={model.id}
          onOpenStl={onOpenStl}
          selectedImageFileId={selectedImageFileId}
          onSelectImageFile={onSelectImageFile}
          disabled={fileActionsDisabled}
          onCreateFolder={onCreateFolder}
          onRenameFile={onRenameFile}
          onMoveFile={onMoveFile}
          onDeleteFile={onDeleteFile}
          onMoveFiles={onMoveFiles}
          onDeleteFiles={onDeleteFiles}
          onRenameFolder={onRenameFolder}
          onMoveFolder={onMoveFolder}
          onDeleteFolder={onDeleteFolder}
        />
      )}
    </div>
  );
}
