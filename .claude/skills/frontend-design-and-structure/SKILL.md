# Frontend Design & Project Structure Skill

## Purpose
Keep UI updates consistent with the existing brutalist style while preserving a clean React + TypeScript structure.

## Rules
1. Prefer small, composable components in `src/components`.
2. Keep route-level orchestration in `src/pages`.
3. Put reusable logic in `src/hooks` and pure helpers in `src/lib`.
4. Reuse existing `shadcn/ui` primitives before adding new dependencies.
5. Preserve accessibility basics (semantic elements, color contrast, keyboard focus).

## UI Language
- High-contrast blocks
- Bold labels and uppercase headings
- Clear status feedback for live transcription and fact-checking

## Implementation Checklist
- Is state owned by the nearest page/container?
- Is logic extracted from presentation where possible?
- Are styles using existing utility/token patterns?
