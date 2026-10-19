# ZCode UI source attribution

Source: https://github.com/zai-org/ZCode
Pinned revision: `29628c9acdb81b703bbd4080c207a0e7ce5e276e`.
Copyright 2026 Z.AI Co., Ltd. First-party source: Apache License 2.0 (included as LICENSE).

Included adaptations:

- `src/renderer/src/ui-kit/upstream/desktop-window-frame.tsx`, `button.tsx` and `utils.ts`: actual `packages/ui/src/DesktopWindowFrame.tsx`, `components/ui/button.tsx` and `components/lib/utils.ts` source, with local imports and standalone Radix Slot replacing the monorepo import. The frame has a React default import for the host test JSX transform. Original utility classes and variants remain.
- `src/renderer/src/ui-kit/upstream/styles.css`: original `@theme`, `.theme-zai-light` and `.theme-zai-dark` blocks from `packages/ui/src/styles.css`. Tailwind theme/utilities are compiled in the host renderer. Preflight, the global focus reset and unused document/terminal plugins are excluded. Keyboard focus remains visible.
- `src/renderer/src/ui-kit/upstream/chat-prompt-shell.tsx`: source render markup/classes from ChatPromptEditor. Host-controlled input/actions replace Lexical and service dependencies.

- `src/renderer/src/ui-kit/conversation-data.ts`, and the presentation in `src/renderer/src/personal/conversation.tsx` derived from the former `ui-kit/conversation.tsx` (removed): turn/flow grouping from `v4/conversationTurnFlowItems.ts` / `conversationTurnRenderUnits.ts`, work-history disclosure from `v4/ConversationTurnGroup.tsx`, compact summaries from `ToolCallBlocks/ToolSummaryRow.tsx`, loading and bottom-navigation presentation from `components/ai-elements/chat-loading.tsx` / `v4/ConversationTimeline.tsx`. Adapted to existing Serika display rows and native HTML disclosures. No upstream stores, services, protocol, virtualizer or telemetry is imported. Original row order, full assistant text and local receipt semantics are retained.
- `src/renderer/src/ui-kit/prompt-editor.tsx`: the input-shell and leading/trailing toolbar structure from `prompt-editor/ChatPromptEditor.tsx` and send/stop presentation from `v4/ConversationComposer.tsx`. Existing Serika textarea, IME, per-Thread drafts and Controller submission remain; unsupported attachments, mentions, queues and upstream model settings are not displayed.
- `src/renderer/src/ui-kit/message.tsx` additionally includes the upstream MessageActions container, with a local copy-reply action.

- `src/renderer/src/ui-kit/message.tsx`: Message / MessageContent / MessageActions render markup and utility classes from `packages/ui/src/components/ai-elements/message.tsx`. Original provenance: vercel/ai-elements, Copyright 2023 Vercel, Inc., Apache-2.0. Local export names and safe host Markdown rendering remain; no upstream Markdown plugins or model SDK.
- `src/renderer/src/ui-kit/theme.css`: imports the source theme and bridges semantic tokens to existing Serika panels. Contains local layout/responsive integration and receipt/disclosure styles, not a new theme palette. The opaque sidebar is an intentional host adaptation: this Electron window does not use ZCode's native vibrancy.

No ZCode logo, account service, model gateway, telemetry, updater, remote browser, runtime bundle, font or asset is imported. This is not an official ZCode distribution.

The upstream styles include shadcn-derived material. Its MIT notice is retained below:

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
