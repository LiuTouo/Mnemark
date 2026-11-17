# Repository Guidelines

## Project Structure & Module Organization

Mnemark is a Tauri 2 desktop application with a TypeScript frontend and Rust backend. Frontend entry points live in `src/`: `main.ts` drives the clipboard panel, while `settings.ts` and `about.ts` support their matching root-level HTML pages. Shared styling and localization are also in `src/`; static images belong in `src/assets/`. Native code is under `src-tauri/src/`, split by responsibility (`clipboard.rs`, `history.rs`, `persistence.rs`, and `update.rs`). Tauri configuration, capabilities, and application icons live under `src-tauri/`. Architecture decisions are recorded in `docs/adr/`.

## Build, Test, and Development Commands

- `npm ci`: install the exact JavaScript dependencies from `package-lock.json`.
- `npm run tauri dev`: launch Vite and the native app with hot reload.
- `npm run build`: type-check TypeScript and build frontend assets into `dist/`.
- `npm run build:app`: create a release-mode native binary with embedded assets.
- `cargo check --manifest-path src-tauri/Cargo.toml`: quickly validate Rust changes.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run the Rust test suite.

Release builds must enable Tauri's `custom-protocol` feature; use `npm run build:app` rather than an unqualified release build.

## Release Procedure

`src-tauri/Cargo.toml` is the single version source; CI rejects any tag that doesn't match it. Before any release tooling that runs `npm version`/creates a tag, run `npm run bump -- <version>`, fill in the CHANGELOG skeleton, sync `Cargo.lock` via `cargo check`, and commit as `chore(release): <version>`. Then create and push the tag.

## Coding Style & Naming Conventions

Follow existing formatting: two-space indentation and double quotes in TypeScript; standard `rustfmt` output in Rust. Keep TypeScript strict and free of unused declarations. Use `camelCase` for TypeScript variables/functions, `PascalCase` for types, and Rust `snake_case` for modules/functions. Prefer small modules organized by behavior. Run `cargo fmt --manifest-path src-tauri/Cargo.toml` before submitting Rust changes.

## Testing Guidelines

Rust tests use the built-in `#[test]` framework in colocated `#[cfg(test)]` modules. Name tests after observable behavior, for example `double_copy_inside_window_is_dropped`. Add regression tests beside the affected module. Frontend tests use Vitest (`vitest.config.ts`, colocated `src/*.test.ts`); run them with `npm test` (watch) or `npx vitest --run` (single pass). `npm run test:all` runs the Vitest suite followed by the Rust suite. There is no browser-based test runner; `npm run build` remains the required frontend build validation. No numeric coverage threshold is enforced.

## Commit & Pull Request Guidelines

History follows Conventional Commit-style subjects such as `fix: ...`, `refactor: ...`, and `chore(release): ...`. Keep commits focused and use an imperative, concise subject. Pull requests should explain the problem and solution, list validation commands, and link related issues. Include screenshots or recordings for visible UI changes. Call out changes to capabilities, persistence formats, updater behavior, or release configuration explicitly.

## Security & Configuration

Keep permissions scoped in `src-tauri/capabilities/default.json`. Never commit signing keys or passwords. Use the project data-directory helpers rather than hardcoding installed or portable storage paths.
