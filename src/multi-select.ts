/** Pure ID-based selection state for the history/drawer list. */
export class MultiSelectState {
  private selectedIds = new Set<string>();
  active = false;

  enter(): void {
    this.active = true;
  }

  exit(): void {
    this.active = false;
    this.selectedIds.clear();
  }

  toggle(id: string): void {
    if (!this.active) return;
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
  }

  has(id: string): boolean {
    return this.selectedIds.has(id);
  }

  get size(): number {
    return this.selectedIds.size;
  }

  idsInOrder(ids: readonly string[]): string[] {
    return ids.filter((id) => this.selectedIds.has(id));
  }

  toggleAllVisible(ids: readonly string[]): void {
    if (!this.active || ids.length === 0) return;
    const allSelected = ids.every((id) => this.selectedIds.has(id));
    for (const id of ids) {
      if (allSelected) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
    }
  }

  allVisibleSelected(ids: readonly string[]): boolean {
    return ids.length > 0 && ids.every((id) => this.selectedIds.has(id));
  }

  prune(validIds: readonly string[]): void {
    const valid = new Set(validIds);
    for (const id of this.selectedIds) {
      if (!valid.has(id)) this.selectedIds.delete(id);
    }
  }
}
