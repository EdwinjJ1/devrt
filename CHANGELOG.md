# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-02

### Added

- Core CLI runtime: `init`, `task create/show`, `actions list/validate`, `scenarios list`, `doctor`, `run`, `verify`, `verify scenario`, `status`, `replay last`.
- Agent entrypoints: `devrt init --agent` and `devrt agent install` manage `.devrt/instructions.md` plus managed blocks in `AGENTS.md` / `CLAUDE.md` (existing content preserved).
- Manifest with tools, actions (JSON-schema-validated input), verify checks, and multi-step scenarios with assertions, `${step.path}` templating, and cleanup steps.
- JSON traces for every action/verification and trace-based replay.
- Task preservation: user's original task stored verbatim with sha256.
- `install.sh` one-liner installer; global install via `npm install -g github:EdwinjJ1/devrt`.

[Unreleased]: https://github.com/EdwinjJ1/devrt/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EdwinjJ1/devrt/releases/tag/v0.1.0
