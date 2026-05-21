# WhatsApp Bridge Feeder (extensão)

Extensão MV3 que observa o WhatsApp Web aberto na aba e alimenta o serviço local `whatsapp-bridge`, em vez de o serviço manter uma conexão Baileys própria. Como usa a sua sessão **oficial** do WhatsApp Web, não cria nenhum aparelho conectado novo — o que reduz bastante o risco de banimento comparado ao modo `baileys`.

## Como funciona

Dois content scripts no `web.whatsapp.com`:

- **`inject.js`** (mundo `MAIN`) — roda no contexto da página, usa [`@wppconnect/wa-js`](https://github.com/wppconnect-team/wa-js) (`window.WPP`) que expõe o Store interno do WhatsApp Web como API estável. Escuta `chat.new_message`, normaliza o JID (`@c.us` → `@s.whatsapp.net`) e executa os envios via `WPP.chat.sendTextMessage`. Não faz HTTP.
- **`bridge.js`** (mundo `ISOLATED`) — faz o HTTP com o serviço: dá `POST /ingest` com as mensagens, e mantém uma conexão **SSE** aberta em `GET /outbound/stream` por onde o servidor *empurra* os envios enfileirados, repassa pro `inject.js` e reporta o resultado em `POST /outbound/:id/result`.

Os dois se falam por `window.postMessage`. O token e a URL do serviço ficam em `chrome.storage.local` (página de opções).

```
WhatsApp Web (aba)
  ├─ inject.js (MAIN)  ──WPP──> Store interno do WA
  │      │ postMessage
  │      ▼
  └─ bridge.js (ISOLATED) ──HTTP──> http://127.0.0.1:4477  (whatsapp-bridge)
                                      POST /ingest
                                      SSE  /outbound/stream  → POST /outbound/:id/result
```

Por que SSE em vez de polling: o Chrome reduz drasticamente os timers de abas em segundo plano (até ~1x/min), o que travaria um `setInterval`. Mas a aba continua reagindo a eventos de rede — então o push por SSE (e o flush do ingest disparado no próprio evento da mensagem) mantém tudo funcionando com a aba escondida, sem som nenhum. Timers lentos ficam só de backstop.

## Instalação

1. Da raiz do repo, vendore o bundle do wa-js (gera `extension/vendor/wppconnect-wa.js`, ignorado no git):
   ```bash
   npm run build-extension
   ```
2. Suba o serviço (modo extensão é o padrão; veja o README principal pra configurar o `.env`):
   ```bash
   npm start
   ```
3. `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem compactação** → pasta `extension/`.
4. **Detalhes → Opções da extensão** → cole o `apiToken` de `~/.whatsapp-bridge/config.json`. Salve.
5. Abra/recarregue `https://web.whatsapp.com` logado. No DevTools da aba deve aparecer:
   - `[wab] bridge link active -> http://127.0.0.1:4477`
   - `[wab] outbound stream connected`
   - `[wab] connected to WPP, streaming messages to the bridge`

## Atualização do WhatsApp Web

Se a captura parar depois de uma atualização do WhatsApp Web, o wa-js geralmente já tem o ajuste:

```bash
npm update @wppconnect/wa-js && npm run build-extension
```

Depois recarregue a extensão em `chrome://extensions` e a aba do WhatsApp Web.

## Notas

- A aba do WhatsApp Web precisa ficar **aberta** — sem aba, nada é capturado e os envios ficam enfileirados até a aba voltar.
- **Aba em segundo plano funciona:** graças ao push por SSE e ao flush orientado a evento (ver "Como funciona"), envio e captura continuam rápidos mesmo com a aba escondida ou o navegador minimizado — sem nenhum truque de áudio.
- O envio continua com o duplo opt-in do serviço (`ENABLE_SEND=true` **e** chat em `send_whitelist.txt`); a extensão só executa o que o serviço já autorizou e enfileirou.
- O `vendor/wppconnect-wa.js` é artefato gerado — não é commitado.
