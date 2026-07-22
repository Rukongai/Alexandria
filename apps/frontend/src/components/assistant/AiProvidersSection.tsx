import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProvider } from '@alexandria/shared';
import { Bot, KeyRound, Pencil, Plus, Server, Star, Trash2 } from 'lucide-react';
import { deleteAiProvider, listAiProviders } from '../../api/ai';
import { useToast } from '../../hooks/use-toast';
import { AlertDialog } from '../ui/alert-dialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { ProviderDialog } from './ProviderDialog';

function maskedKey(provider: AiProvider): string {
  if (!provider.hasApiKey) return 'No API key';
  return provider.apiKeyHint ? `•••••••• ${provider.apiKeyHint}` : '•••••••• saved';
}

export function AiProvidersSection() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AiProvider>();
  const [deleteTarget, setDeleteTarget] = useState<AiProvider>();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const providersQuery = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => listAiProviders().then((response) => response.data),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAiProvider(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['ai-providers'] });
      toast({ title: 'Provider deleted' });
      setDeleteTarget(undefined);
    },
    onError: (error) => {
      toast({
        title: 'Could not delete provider',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    },
  });

  const providers = providersQuery.data ?? [];

  return (
    <section className="flex flex-col gap-4" aria-labelledby="ai-providers-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="ai-providers-heading" className="text-base font-semibold text-foreground">AI Providers</h2>
          <p className="text-sm text-muted-foreground">Connect OpenAI-compatible services for the library assistant.</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Add provider
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border">
        {providersQuery.isLoading ? (
          <div className="space-y-0 divide-y">
            {[0, 1].map((item) => (
              <div key={item} className="flex items-center gap-3 p-4">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div className="flex-1 space-y-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-52" /></div>
              </div>
            ))}
          </div>
        ) : providersQuery.isError ? (
          <div className="p-8 text-center">
            <p className="text-sm text-muted-foreground">AI providers could not be loaded.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => providersQuery.refetch()}>Try again</Button>
          </div>
        ) : providers.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <div className="mb-3 grid h-11 w-11 place-items-center rounded-xl bg-muted"><Bot className="h-5 w-5 text-muted-foreground" /></div>
            <p className="text-sm font-medium">No AI providers configured</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Add a provider to enable assistant conversations and change previews.</p>
            <Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> Add your first provider</Button>
          </div>
        ) : (
          <div className="divide-y">
            {providers.map((provider) => (
              <article key={provider.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10"><Server className="h-5 w-5 text-primary" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-foreground">{provider.name}</h3>
                    {provider.isDefault && <Badge variant="accent" className="gap-1"><Star className="h-3 w-3" /> Default</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{provider.baseUrl}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{provider.model}</span>
                    <span className="inline-flex items-center gap-1"><KeyRound className="h-3 w-3" /> {maskedKey(provider)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 self-end sm:self-auto">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditTarget(provider)} aria-label={`Edit ${provider.name}`}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(provider)} aria-label={`Delete ${provider.name}`}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <ProviderDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && <ProviderDialog open provider={editTarget} onOpenChange={(nextOpen) => { if (!nextOpen) setEditTarget(undefined); }} />}
      {deleteTarget && (
        <AlertDialog
          open
          onOpenChange={(nextOpen) => { if (!nextOpen) setDeleteTarget(undefined); }}
          title={`Delete “${deleteTarget.name}”?`}
          description="The assistant will no longer be able to use this provider. This cannot be undone."
          confirmLabel="Delete provider"
          destructive
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      )}
    </section>
  );
}
