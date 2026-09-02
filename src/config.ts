// Single frontend owner of the backend AppConfig wire contract and the
// cross-window bootstrap sequence.

import { invoke } from "@tauri-apps/api/core";
import { setLanguage } from "./i18n";
import { applyTheme } from "./theme";

export interface AppConfig {
  text_size_limit_kb: number;
  text_count_limit: number;
  image_count_limit: number;
  image_memory_budget_mb: number;
  image_size_limit_mb: number;
  hotkey: string;
  startup: boolean;
  persist: boolean;
  exclusion_list: string[];
  vim_mode: boolean;
  debounce_ms: number;
  theme: string;
  ui_opacity_percent: number;
  ui_scale_percent: number;
  language: string;
  paste_files_as_files: boolean;
  auto_update: boolean;
  preview_enabled: boolean;
  remember_history_filter: boolean;
  favorites_toggle_shortcut: { codes: string[] };
  tutorial_version: number;
}

export interface ConfigBootstrapDependencies {
  load(): Promise<AppConfig>;
  applyLanguage(language: string): void;
  applyTheme(theme: string): void;
  applyOpacity(opacityPercent: number): void;
}

export function clampOpacityPercent(value: number): number {
  return Math.min(100, Math.max(50, Number.isFinite(value) ? value : 99));
}

export class ConfigBootstrap {
  constructor(private readonly dependencies: ConfigBootstrapDependencies) {}

  async loadAndApply(isCurrent: () => boolean = () => true): Promise<AppConfig> {
    try {
      const config = await this.dependencies.load();
      if (isCurrent()) this.apply(config);
      return config;
    } catch (error) {
      if (isCurrent()) {
        this.dependencies.applyLanguage("zh-TW");
        this.dependencies.applyTheme("system");
        this.dependencies.applyOpacity(99);
      }
      throw error;
    }
  }

  apply(config: AppConfig): void {
    this.dependencies.applyLanguage(config.language || "zh-TW");
    this.dependencies.applyTheme(config.theme || "system");
    this.dependencies.applyOpacity(clampOpacityPercent(config.ui_opacity_percent));
  }
}

export const configBootstrap = new ConfigBootstrap({
  load: () => invoke<AppConfig>("get_config"),
  applyLanguage: setLanguage,
  applyTheme,
  applyOpacity: (opacity) => {
    document.documentElement.style.setProperty("--panel-opacity", String(opacity / 100));
  },
});
