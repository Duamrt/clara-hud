# Clara HUD

PWA do painel da Clara, assistente pessoal do Duam.

- 🌐 Produção: https://clara.dmstack.com.br
- 🤍 Stack: HTML + CSS + JS vanilla, sem dependências
- 📱 Instalável como app no celular/desktop (PWA)

## Estrutura

- `index.html` — HUD com núcleo Jarvis em SVG + wireframe constelação
- `manifest.json` — config PWA (nome, ícones, theme rosé)
- `service-worker.js` — cache-first pra funcionar offline
- `icons/` — 192/512 e apple-touch
- `CNAME` — domínio custom GitHub Pages

## Dev local

```bash
npx serve -s . -l 5557
```

Abre http://localhost:5557
