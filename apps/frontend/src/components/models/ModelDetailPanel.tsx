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
}

/**
 * Tabbed right panel of the model detail page. Hosts the existing detail
 * sub-components under Info / Collections / Files tabs.
 */
export function ModelDetailPanel({
  model,
  fileTree,
  onOpenStl,
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
        <FileTree tree={fileTree} modelId={model.id} onOpenStl={onOpenStl} />
      )}
    </div>
  );
}
