export function generateSlug(name: string): string {
  const suffix = Math.random().toString(36).slice(2, 6);

  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    // Slug columns are varchar(255); preserve room for the hyphen and suffix.
    .slice(0, 250)
    .replace(/-+$/g, '');

  return `${base}-${suffix}`;
}
