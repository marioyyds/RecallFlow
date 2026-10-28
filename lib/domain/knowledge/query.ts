export interface SortableItem {
  createdAt?: number;
  updatedAt?: number;
  status?: number | string;
}

export function sortItems<T extends SortableItem>(list: T[], sortBy: string): T[] {
  const arr = list.slice();
  const status = (item: SortableItem) => {
    const value = Number(item.status);
    return Number.isFinite(value) ? value : 0;
  };
  switch (sortBy) {
    case 'created':
      arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      break;
    case 'star-desc':
      arr.sort(
        (a, b) =>
          status(b) - status(a) ||
          (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    case 'star-asc':
      arr.sort(
        (a, b) =>
          status(a) - status(b) ||
          (b.updatedAt || 0) - (a.updatedAt || 0)
      );
      break;
    default:
      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return arr;
}
