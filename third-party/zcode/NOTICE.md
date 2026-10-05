# ZCode UI source attribution

Source: https://github.com/zai-org/ZCode
Pinned revision: `29628c9acdb81b703bbd4080c207a0e7ce5e276e`.
Copyright 2026 Z.AI Co., Ltd. First-party source: Apache License 2.0 (included as LICENSE).

Included adaptations:

- `src/renderer/src/zcode/message.tsx`: the small Message / MessageContent containers from `packages/ui/src/components/ai-elements/message.tsx`. Original provenance: vercel/ai-elements, Copyright 2023 Vercel, Inc., Apache-2.0. Runloom replaces Tailwind class construction with scoped CSS and removes all ZCode runtime, service, editor, account and Markdown plugin dependencies. Existing Runloom safe Markdown rendering is retained.
- `src/renderer/src/zcode/theme.css`: selected light theme values from `.theme-zai-light` in `packages/ui/src/styles.css`, and the two message containers' layout rules. Runloom adds scoped layout, navigation, responsive behavior and visible keyboard focus.
- `src/renderer/src/zcode/sidebar.tsx` is Runloom-owned code adapted to local Thread data; it does not copy the upstream workspace/session store or task lifecycle.

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
