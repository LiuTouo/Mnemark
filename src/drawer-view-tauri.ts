import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  DrawerViewProjection,
  type DrawerView,
  type DrawerViewSource,
} from "./drawer-view";
import type { CollectionSummary, FavoriteItem } from "./types";

interface DrawerViewWire {
  readonly generation: number;
  readonly open: boolean;
  readonly selected_collection: string | null;
  readonly collections: readonly CollectionSummary[];
  readonly active_snapshots: readonly FavoriteItem[];
}

interface DrawerViewInvalidationWire {
  readonly generation: number;
}

export interface TauriDrawerViewDependencies {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(
    event: string,
    listener: (event: { readonly payload: unknown }) => void,
  ): Promise<() => void>;
}

const productionDependencies: TauriDrawerViewDependencies = {
  invoke: (command, args) => invoke(command, args),
  listen: (event, listener) =>
    listen<unknown>(event, ({ payload }) => listener({ payload })),
};

export class TauriDrawerViewSource implements DrawerViewSource {
  constructor(
    private readonly dependencies: TauriDrawerViewDependencies = productionDependencies,
  ) {}

  async listenInvalidated(listener: (generation: number) => void): Promise<void> {
    await this.dependencies.listen("drawer-view-invalidated", ({ payload }) => {
      listener((payload as DrawerViewInvalidationWire).generation);
    });
  }

  async read(): Promise<DrawerView> {
    const wire = (await this.dependencies.invoke("get_drawer_view")) as DrawerViewWire;
    return {
      generation: wire.generation,
      open: wire.open,
      selectedCollection: wire.selected_collection,
      collections: [...wire.collections],
      activeSnapshots: wire.active_snapshots.map((snapshot) => ({
        ...snapshot,
        origin: "favorite" as const,
      })),
    };
  }

  async toggle(): Promise<void> {
    await this.dependencies.invoke("toggle_favorites_sidebar");
  }

  async setOpen(open: boolean): Promise<void> {
    await this.dependencies.invoke("set_favorites_open", { open });
  }

  async select(collectionId: string | null): Promise<void> {
    await this.dependencies.invoke("set_favorites_selected", { collectionId });
  }
}

export const drawerViewProjection = new DrawerViewProjection(
  new TauriDrawerViewSource(),
  (error) => console.error("[Mnemark] Drawer view refresh failed", error),
);
