import { describe, expect, it, vi } from "vitest";
import {
  DrawerViewProjection,
  type DrawerView,
  type DrawerViewSource,
} from "./drawer-view";
import { DrawerViewCoordinator } from "./drawer-view-coordinator";

function drawerView(generation: number): DrawerView {
  return {
    generation,
    open: false,
    selectedCollection: null,
    collections: [],
    activeSnapshots: [],
  };
}

function source(overrides: Partial<DrawerViewSource> = {}): DrawerViewSource {
  return {
    listenInvalidated: async () => {},
    read: async () => drawerView(1),
    toggle: async () => {},
    setOpen: async () => {},
    select: async () => {},
    ...overrides,
  };
}

function coordinator(projection: DrawerViewProjection) {
  const presentation = {
    presentError: vi.fn(),
    presentStale: vi.fn(),
    reportDiagnostic: vi.fn(),
  };
  return {
    coordinator: new DrawerViewCoordinator(projection, presentation),
    presentation,
  };
}

describe("DrawerViewCoordinator", () => {
  it("presents a committed intent refresh failure as stale, not as a rejected action", async () => {
    const refreshFailure = new Error("refresh failed after commit");
    let reads = 0;
    const projection = new DrawerViewProjection(source({
      read: async () => {
        reads += 1;
        if (reads === 1) return drawerView(1);
        throw refreshFailure;
      },
    }), vi.fn());
    const { coordinator: workflow, presentation } = coordinator(projection);
    await projection.startup();

    await expect(workflow.setOpen(true)).resolves.toBe(false);

    expect(presentation.presentStale).toHaveBeenCalledOnce();
    expect(presentation.presentError).not.toHaveBeenCalled();
    expect(presentation.reportDiagnostic).toHaveBeenCalledWith(
      "Drawer open committed but refresh failed",
      refreshFailure,
    );
  });

  it("presents a rejected intent as an action error", async () => {
    const commandFailure = new Error("Drawer unavailable");
    const projection = new DrawerViewProjection(source({
      setOpen: async () => {
        throw commandFailure;
      },
    }), vi.fn());
    const { coordinator: workflow, presentation } = coordinator(projection);
    await projection.startup();

    await expect(workflow.setOpen(true)).resolves.toBe(false);

    expect(presentation.presentError).toHaveBeenCalledWith(commandFailure);
    expect(presentation.presentStale).not.toHaveBeenCalled();
  });

  it("isolates cancellation and Panel renderer failures from the Drawer renderer", async () => {
    const projection = new DrawerViewProjection(source(), vi.fn());
    const { coordinator: workflow, presentation } = coordinator(projection);
    const renderDrawer = vi.fn();
    workflow.subscribe({
      cancelDrag: () => {
        throw new Error("cancel failed");
      },
      renderPanel: () => {
        throw new Error("Panel render failed");
      },
      renderDrawer,
    });

    await projection.startup();

    expect(renderDrawer).toHaveBeenCalledWith(drawerView(1));
    expect(presentation.reportDiagnostic).toHaveBeenCalledTimes(2);
  });
});
