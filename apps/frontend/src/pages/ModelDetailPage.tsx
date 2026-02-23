import { useParams } from 'react-router-dom';

export function ModelDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div>
      <h2 className="text-2xl font-semibold text-foreground">Model Detail</h2>
      <p className="mt-1 text-muted-foreground font-mono text-sm">ID: {id}</p>
    </div>
  );
}
