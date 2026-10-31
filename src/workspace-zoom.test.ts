// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import nativeSource from "../src-tauri/src/lib.rs?raw";
import { fitCoefficient, waitForWorkspaceViewport, WorkspaceLayoutCoordinator } from "./workspace-layout";
import { decideWorkspaceLayout } from "./workspace-state";

// Static native wiring checks complement the simulated viewport tests below;
// these do not replace a WebView2 mixed-monitor integration test.
for (const name of ["apply_main_workspace_layout", "center_on_cursor_monitor", "resync_workspace_after_dpi_move"]) {
  it(`${name} applies the calculated zoom before sizing the workspace`, () => {
    const start = nativeSource.indexOf(`fn ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const body = nativeSource.slice(start, nativeSource.indexOf("\nfn ", start + 1));
    const zoom = body.search(/window\s*\.set_zoom\(zoom\)/);
    expect(zoom).toBeGreaterThan(-1);
    expect(zoom).toBeLessThan(body.indexOf("set_workspace_bounds("));
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("acknowledges synchronized FHD/4K viewports across OS and UI scaling combinations", async () => {
  vi.useFakeTimers();
  // Includes fractional custom scaling, not just Windows' 25% presets.
  const scales = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5];
  const monitors = [[1920, 1040], [3840, 2100]];
  const scalePairs = scales.flatMap((source) => scales.map((target) => [source, target]));
  for (const uiZoom of [0.75, 1, 1.25, 1.5, 2]) {
    for (const [sourceScale, targetScale] of scalePairs) {
      // Reverse the order too: the coordinator must discard its prior geometry.
      for (const direction of [monitors, [...monitors].reverse()]) {
        let scale = sourceScale;
        const commit = vi.fn();
        let physicalWidth = 0;
        let physicalHeight = 0;
        let zoom = 1;
        const coordinator = new WorkspaceLayoutCoordinator({
          stage: () => {},
          resize: async () => ({
            cssWidth: physicalWidth / (scale * zoom),
            cssHeight: physicalHeight / (scale * zoom),
          }),
          waitForViewport: waitForWorkspaceViewport,
          commit,
          finish: async () => {},
          report: (error) => { throw error; },
        });
        for (const [index, [width, height]] of direction.entries()) {
          scale = index === 0 ? sourceScale : targetScale;
          zoom = uiZoom * fitCoefficient(Math.floor(width / scale), Math.floor(height / scale));
          const factor = scale * zoom;
          physicalWidth = Math.min(Math.round(1216 * factor), width);
          physicalHeight = Math.min(Math.round(620 * factor), height);
          vi.stubGlobal("innerWidth", Math.round(physicalWidth / factor));
          vi.stubGlobal("innerHeight", Math.round(physicalHeight / factor));
          vi.stubGlobal("devicePixelRatio", factor);
          for (const tab of ["drawer", "preview"] as const) {
            const layout = decideWorkspaceLayout(width / factor, true, true, tab);
            const pending = coordinator.request(layout, `${width}/${scale}/${zoom}`);
            await vi.advanceTimersByTimeAsync(32);
            await pending;
            expect(commit).toHaveBeenLastCalledWith(layout);
            expect(tab === "drawer" ? layout.drawerVisible : layout.previewVisible).toBe(true);
          }
        }
      }
    }
  }
  expect(vi.getTimerCount()).toBe(0);
});
