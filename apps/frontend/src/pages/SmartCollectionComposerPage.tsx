import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import type { RuleNode, SmartCollectionDetail } from '@alexandria/shared';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { RuleGroupEditor } from '../components/smart/RuleGroupEditor';
import { PreviewPane } from '../components/smart/PreviewPane';
import { useSmartCollectionDraft } from '../hooks/use-smart-collection-draft';
import { useLibraryPath } from '../hooks/use-libraries';
import {
  getSmartCollection,
  createSmartCollection,
  updateSmartCollection,
} from '../api/smart-collections';
import { getFields } from '../api/metadata';
import { useToast } from '../hooks/use-toast';
import { ApiRequestError } from '../api/client';

/** Router state passed from the search page's "Save as Smart Collection" button. */
interface ComposerSeed {
  name?: string;
  definition?: RuleNode;
}

export function SmartCollectionComposerPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const location = useLocation();
  const libPath = useLibraryPath();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const seed = (location.state as ComposerSeed | null) ?? {};

  const [name, setName] = useState(seed.name ?? '');
  const [description, setDescription] = useState('');
  const draft = useSmartCollectionDraft(seed.definition);

  const { data: fields = [] } = useQuery({ queryKey: ['metadata-fields'], queryFn: getFields });

  // Edit mode: load the existing collection and seed the form once.
  const existing = useQuery({
    queryKey: ['smart-collection', id],
    queryFn: () => getSmartCollection(id!),
    enabled: isEdit,
  });
  const seededRef = useRef(false);
  useEffect(() => {
    if (existing.data && !seededRef.current) {
      seededRef.current = true;
      setName(existing.data.name);
      setDescription(existing.data.description ?? '');
      draft.reset(existing.data.definition);
    }
  }, [existing.data, draft]);

  const save = useMutation({
    mutationFn: async (): Promise<SmartCollectionDetail> => {
      const payload = { name: name.trim(), description: description.trim() || undefined, definition: draft.definition };
      return isEdit
        ? updateSmartCollection(id!, payload)
        : createSmartCollection(payload);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['smart-collections'] });
      queryClient.invalidateQueries({ queryKey: ['smart-collection', data.id] });
      toast({ title: isEdit ? 'Smart collection updated' : 'Smart collection created' });
      navigate(`${libPath('/')}?axis=smart&smartCollectionId=${data.id}`);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Failed to save smart collection',
        variant: 'destructive',
      });
    },
  });

  const canSave = name.trim().length > 0 && !save.isPending;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-base font-semibold">
          {isEdit ? 'Edit smart collection' : 'New smart collection'}
        </h1>
        <div className="flex-1" />
        <Button onClick={() => save.mutate()} disabled={!canSave}>
          {save.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {isEdit ? 'Save changes' : 'Create'}
        </Button>
      </header>

      {/* Two-pane body */}
      <div className="grid flex-1 grid-cols-2 gap-6 overflow-hidden p-6">
        {/* Left: definition */}
        <div className="flex flex-col gap-4 overflow-y-auto pr-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sc-name">Name</Label>
            <Input
              id="sc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pre-supported dragons"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sc-desc">Description</Label>
            <Textarea
              id="sc-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
              rows={2}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Rules</Label>
            <RuleGroupEditor node={draft.tree} fields={fields} draft={draft} depth={1} isRoot />
          </div>
        </div>

        {/* Right: live preview */}
        <div className="overflow-hidden rounded-lg border border-border p-4">
          <PreviewPane definition={draft.definition} />
        </div>
      </div>
    </div>
  );
}
