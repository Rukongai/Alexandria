import type { ModelCard } from '@alexandria/shared';
import { ModelCard as ModelCardComponent } from './ModelCard';
import { getMetadataAxisSlug } from '../../hooks/use-model-filters';
import type { PivotAxis } from '../../hooks/use-model-filters';
import type { ActiveAxisValue } from '../../hooks/use-model-filters';

export interface ModelGroupViewProps {
  models: ModelCard[];
  axis: PivotAxis;
  activeAxisValue: ActiveAxisValue;
  metadataFieldName?: string;
  selectable?: boolean;
  isSelected?: (id: string) => boolean;
  onToggleSelect?: (id: string) => void;
}

interface ModelGroup {
  label: string;
  models: ModelCard[];
}

const FALLBACK_ARTIST = 'Unknown artist';
const FALLBACK_TAG = 'Untagged';

/**
 * Compute groups for axis='artists'.
 * Each model belongs to exactly one group keyed by its artist displayValue.
 * Models without an artist entry go in the "Unknown artist" fallback group.
 */
function groupByArtist(models: ModelCard[]): ModelGroup[] {
  const map = new Map<string, ModelCard[]>();

  for (const model of models) {
    const artistMeta = model.metadata.find((m) => m.fieldSlug === 'artist');
    const label = artistMeta
      ? (Array.isArray(artistMeta.value) ? artistMeta.value[0] : artistMeta.value) || FALLBACK_ARTIST
      : FALLBACK_ARTIST;

    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(model);
  }

  return sortGroups(map);
}

/**
 * Compute groups for axis='tags'.
 * A model with N tags appears in N groups (one per tag). Models with no tags
 * appear in the "Untagged" fallback group.
 */
function groupByTags(models: ModelCard[]): ModelGroup[] {
  const map = new Map<string, ModelCard[]>();

  for (const model of models) {
    const tagsMeta = model.metadata.find((m) => m.fieldSlug === 'tags');
    const tagValues = tagsMeta
      ? (Array.isArray(tagsMeta.value) ? tagsMeta.value : [tagsMeta.value]).filter(Boolean)
      : [];

    if (tagValues.length === 0) {
      if (!map.has(FALLBACK_TAG)) map.set(FALLBACK_TAG, []);
      map.get(FALLBACK_TAG)!.push(model);
    } else {
      for (const tag of tagValues) {
        if (!map.has(tag)) map.set(tag, []);
        map.get(tag)!.push(model);
      }
    }
  }

  return sortGroups(map);
}

/** Group each model by the complete stored/display value for a metadata field. */
function groupByMetadata(
  models: ModelCard[],
  slug: string,
  fieldName?: string,
): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  const resolvedFieldName = fieldName
    ?? models.flatMap((model) => model.metadata).find((item) => item.fieldSlug === slug)?.fieldName
    ?? slug;
  const fallbackLabel = `No ${resolvedFieldName}`;

  for (const model of models) {
    const metadata = model.metadata.find((item) => item.fieldSlug === slug);
    const hasValue = metadata
      && (Array.isArray(metadata.value) ? metadata.value.length > 0 : metadata.value.length > 0);
    const label = hasValue && metadata.displayValue ? metadata.displayValue : fallbackLabel;
    // Array-valued metadata represents one stored selection combination here.
    // Keep it paired with its display value instead of splitting it like Tags.
    const key = hasValue
      ? JSON.stringify([metadata.value, metadata.displayValue])
      : '__missing__';
    const group = groups.get(key) ?? { label, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }

  const result = Array.from(groups.values());
  result.sort((a, b) => {
    if (a.label === fallbackLabel && b.label !== fallbackLabel) return 1;
    if (a.label !== fallbackLabel && b.label === fallbackLabel) return -1;
    if (b.models.length !== a.models.length) return b.models.length - a.models.length;
    return a.label.localeCompare(b.label);
  });
  return result;
}

/** Sort groups: largest first, then alphabetically. "Untagged"/"Unknown artist" always last. */
function sortGroups(map: Map<string, ModelCard[]>): ModelGroup[] {
  const FALLBACK_LABELS = new Set([FALLBACK_ARTIST, FALLBACK_TAG]);
  const groups: ModelGroup[] = Array.from(map.entries()).map(([label, models]) => ({ label, models }));

  groups.sort((a, b) => {
    const aIsFallback = FALLBACK_LABELS.has(a.label);
    const bIsFallback = FALLBACK_LABELS.has(b.label);
    if (aIsFallback && !bIsFallback) return 1;
    if (!aIsFallback && bIsFallback) return -1;
    if (b.models.length !== a.models.length) return b.models.length - a.models.length;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

/**
 * Renders a sticky group header followed by a card grid.
 * Note: model counts shown here reflect LOADED models only, not the full
 * library total. The server does not return per-group totals; infinite scroll
 * continues loading more models, which will fill groups over time.
 */
function GroupSection({
  group,
  selectable,
  isSelected,
  onToggleSelect,
}: {
  group: ModelGroup;
  selectable?: boolean;
  isSelected?: (id: string) => boolean;
  onToggleSelect?: (id: string) => void;
}) {
  return (
    <section>
      {/* Sticky header */}
      <div
        className="sticky top-0 z-10 flex items-baseline gap-2 px-1 py-2"
        style={{
          background: 'var(--ax-bg, hsl(var(--background)))',
          borderBottom: '1px solid var(--ax-border, hsl(var(--border)))',
        }}
      >
        <h2
          className="text-sm font-semibold truncate"
          style={{ color: 'var(--ax-fg, hsl(var(--foreground)))' }}
        >
          {group.label}
        </h2>
        <span
          className="text-xs flex-shrink-0"
          style={{ color: 'var(--ax-fg-muted, hsl(var(--muted-foreground)))' }}
        >
          {group.models.length}
        </span>
      </div>

      {/* Model grid */}
      <div
        className="grid gap-4 pt-3 pb-6"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
      >
        {group.models.map((model) => (
          <ModelCardComponent
            key={model.id}
            model={model}
            selectable={selectable}
            selected={isSelected?.(model.id) ?? false}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Groups the currently-loaded models under sticky headers keyed by the active axis.
 *
 * Grouping rules:
 *   - axis='artists': one group per artist; "Unknown artist" for models without one.
 *   - axis='tags': a model with N tags appears in N groups; "Untagged" for tagless models.
 *   - axis='collections': TRUE per-collection grouping requires server support — the
 *     ModelCard type does not include collection membership. This renders a single group
 *     (labelled with the selected collection name if known, else "All models"). A future
 *     enhancement should add per-model collection membership to the ModelCard response
 *     and move grouping logic to the server so it can return paginated per-group results.
 */
export function ModelGroupView({
  models,
  axis,
  activeAxisValue,
  metadataFieldName,
  selectable,
  isSelected,
  onToggleSelect,
}: ModelGroupViewProps) {
  let groups: ModelGroup[];

  if (axis === 'artists') {
    groups = groupByArtist(models);
  } else if (axis === 'tags') {
    groups = groupByTags(models);
  } else if (getMetadataAxisSlug(axis)) {
    groups = groupByMetadata(models, getMetadataAxisSlug(axis)!, metadataFieldName);
  } else {
    // axis === 'collections'
    // Per-collection grouping is impossible client-side: ModelCard has no
    // collection membership field. Render a single group with all loaded models.
    const label = activeAxisValue.collectionId ? 'Collection' : 'All models';
    groups = [{ label, models }];
  }

  return (
    <div>
      {groups.map((group) => (
        <GroupSection
          key={group.label}
          group={group}
          selectable={selectable}
          isSelected={isSelected}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}
