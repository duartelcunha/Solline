# Decisões

## 2026-10-11: versões do M0

- **electron-vite 5.0.0 com Vite 7.3.7 fixo**, em vez do electron-vite 6 (ainda beta e com
  beta nova a 10/10). O 5 é estável e aceita Vite 5 a 7; o 6 só faz falta para o Vite 8.
  Por isso `@vitejs/plugin-react` fica no 5.2 (o 6 exige Vite 8).
- **TypeScript 5.9.3**: o typescript-eslint 8 só aceita TS abaixo de 6.1.
- **pnpm 10.34.6** (via corepack) em vez do 12, publicado há dois dias.
- **node_modules plano** (`nodeLinker: hoisted`): o electron-builder empacota melhor assim.
- **Electron 44.7.0**, **electron-builder 26.15.3** (NSIS por utilizador, sem assinatura,
  sem auto-update), **Agent SDK 0.3.296** (traz o claude.exe 2.1.296).
- Revisão: 2026-11-11, ou antes se o electron-vite 6 sair estável (subir para Vite 8 e
  plugin-react 6).
