import { useState } from 'react';
import { Upload, FolderOpen } from 'lucide-react';
import { cn } from '../lib/utils';
import { DropZone } from '../components/upload/DropZone';
import { FolderImport } from '../components/upload/FolderImport';
import { RecentUploads } from '../components/upload/RecentUploads';

type Tab = 'zip' | 'folder';

export function UploadPage() {
  const [activeTab, setActiveTab] = useState<Tab>('zip');

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 space-y-8">
      {/* Page heading */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Add Models</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload a zip archive or import from a folder on the server.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
        <button
          onClick={() => setActiveTab('zip')}
          className={cn(
            'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'zip'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <Upload className="h-4 w-4" />
          Upload Zip
        </button>
        <button
          onClick={() => setActiveTab('folder')}
          className={cn(
            'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
            activeTab === 'folder'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <FolderOpen className="h-4 w-4" />
          Import Folder
        </button>
      </div>

      {/* Tab content */}
      <div>
        {activeTab === 'zip' && <DropZone />}
        {activeTab === 'folder' && <FolderImport />}
      </div>

      {/* Recent uploads */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">Recent models</h2>
        <RecentUploads />
      </div>
    </div>
  );
}
