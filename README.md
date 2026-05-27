# whatsapp-bridge

Programa que roda **no seu próprio computador**, fica conectado ao seu WhatsApp e guarda as mensagens num banco de dados local. Vem junto com uma skill do Claude Code (`whatsapp-assistant`) que deixa o Claude **ler, buscar e (se você liberar) enviar** mensagens pra você — por exemplo: "me faz um resumo do que rolou no grupo hoje".

Nada é enviado para servidor externo: token, mensagens e sessão ficam todos na sua máquina.

## Escolha o modo de conexão

Existem dois jeitos de conectar no WhatsApp. Você escolhe **um**:

| Modo | Como conecta | Prós e contras |
|------|--------------|----------------|
| **`extension`** *(recomendado)* | Usa a sua sessão **oficial** do WhatsApp Web, numa aba do Chrome, com uma extensão que repassa as mensagens. **Não cria aparelho conectado novo.** | ✅ Risco bem menor de banimento. ⚠️ Precisa manter uma aba do navegador aberta. |
| **`baileys`** | Um cliente embutido que conecta direto no WhatsApp (via [Baileys](https://github.com/WhiskeySockets/Baileys)). | ✅ Roda sozinho, sem navegador. ⚠️ É **não oficial** — risco maior de a Meta sinalizar/banir a conta. |

> Na dúvida, use o **modo extensão**. Em qualquer caso, prefira testar com uma conta de WhatsApp que não seja crítica.

## Instalação (vale para os dois modos)

> **Pré-requisito:** [Node.js](https://nodejs.org) versão 20 ou mais nova. No Windows não precisa instalar mais nada — o banco de dados já vem pronto.

Abra um terminal **na pasta do projeto** (a pasta onde você baixou estes arquivos) e rode, nesta ordem:

```bash
npm install            # baixa as dependências do projeto
npm run install-skill  # instala a skill do Claude Code
```

Agora crie o arquivo de configuração `.env`. Ele é só um arquivo de texto, com uma opção por linha (`CHAVE=valor`). Copie o modelo pronto:

```bash
cp .env.example .env                 # no Windows (PowerShell): Copy-Item .env.example .env
```

No próximo passo você abre esse `.env` num editor de texto e ajusta conforme o modo escolhido.

> 💡 O serviço cria um **token de acesso** automaticamente na primeira vez que sobe, e o guarda em `~/.whatsapp-bridge/config.json`. O `~` é a sua pasta de usuário (no Windows, `C:\Users\seu-usuario`). As mensagens ficam dentro do projeto, em `data/messages.db`.

## Como rodar — modo extensão (recomendado)

**1. Gere a extensão** (isso copia o "leitor" do WhatsApp Web para dentro dela):

```bash
npm run build-extension
```

**2. Edite o `.env`** num editor de texto e deixe estas duas linhas assim:

```
BRIDGE_MODE=extension
ENABLE_SEND=true
```

> Deixe `ENABLE_SEND=false` se você quer que o Claude **só leia** suas mensagens, sem poder enviar nada.

**3. Suba o serviço:**

```bash
npm start
```

Deixe esse terminal aberto — é nele que o serviço fica rodando. (Para parar, aperte `Ctrl+C`.)

**4. Carregue a extensão no navegador:**

- Abra `chrome://extensions` no Chrome/Chromium
- Ligue o **Modo do desenvolvedor** (interruptor no canto superior direito)
- Clique em **Carregar sem compactação** e selecione a pasta `extension` que está dentro do projeto

**5. Cole o token na extensão:**

- Na extensão que acabou de aparecer, clique em **Detalhes → Opções da extensão**
- Abra o arquivo `~/.whatsapp-bridge/config.json`, copie o valor que está em `apiToken` e cole no campo. Clique em **Save**.

**6. Abra o WhatsApp Web:**

- Acesse [`https://web.whatsapp.com`](https://web.whatsapp.com) e faça login (mesma conta do celular)
- **Mantenha essa aba aberta** — é por ela que as mensagens chegam ao serviço
- Para confirmar que deu certo: aperte `F12`, vá na aba **Console** e procure a linha `[wab] connected to WPP, streaming messages to the bridge`

Pronto! Agora é só pedir ao Claude (veja ["Usando a skill"](#usando-a-skill)). Detalhes técnicos da extensão em [`extension/README.md`](extension/README.md).

## Como rodar — modo Baileys

**1. Edite o `.env`** e deixe:

```
BRIDGE_MODE=baileys
```

**2. Suba o serviço:**

```bash
npm start
```

Na primeira vez, o terminal mostra um **QR code**. No celular: **WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho** e escaneie o código. O login fica salvo em `auth_data/`, então o QR só aparece uma vez. Deixe o terminal aberto enquanto quiser usar o serviço.

## Usando a skill

Depois do `install-skill`, inicie uma sessão nova do Claude Code e pergunte coisas como:

- "quais mensagens do WhatsApp eu tenho não lidas?"
- "me mostra as últimas 20 mensagens do grupo do time"
- "procura 'proposta' no WhatsApp"

Se você instalou a skill com o Claude Code já aberto, feche e reabra pra ele detectar.

## CLI `wa` no terminal (opcional)

Dentro do projeto, você já pode rodar `npm run wa -- <comando>` (ex.: `npm run wa -- health`). Se quiser usar o comando `wa` direto, de qualquer pasta, basta rodar **uma vez**, na raiz do projeto:

```bash
npm link
```

Isso registra o `wa` como comando global no seu usuário (o `npm` cria o atalho automaticamente):

- **Windows**: gera `wa.cmd` em `%APPDATA%\npm\`, que o instalador do Node já deixa no PATH.
- **macOS/Linux**: cria um symlink em `$(npm prefix -g)/bin/wa`. Se você instalou o Node via gerenciador de versão (nvm, asdf, fnm), nenhuma permissão extra é preciso. Se for um Node de sistema (Homebrew/apt), o `npm link` pode pedir `sudo`.

Depois disso, é só usar normalmente em qualquer terminal:

```bash
wa health
wa read "Fulano" --days 7
wa send "Fulano" "oi" --no-prefix
wa digest
```

Pra desfazer (remover o comando global): `npm unlink -g whatsapp-bridge`.

> O `wa` lê o mesmo `~/.whatsapp-bridge/config.json` que o serviço gera, então **não precisa** configurar token de novo. Você pode também sobrescrever via env (`WA_BRIDGE_URL`, `WA_BRIDGE_TOKEN`).

## Configuração

Todas as opções ficam no arquivo `.env`, uma por linha no formato `CHAVE=valor`. Exemplo de um `.env` de modo extensão com envio liberado:

```
BRIDGE_MODE=extension
ENABLE_SEND=true
PORT=4477
HOST=127.0.0.1
```

Opções disponíveis:

| Variável            | Padrão        | Função                                                       |
|---------------------|---------------|--------------------------------------------------------------|
| `PORT`              | `4477`        | Porta HTTP                                                   |
| `HOST`              | `127.0.0.1`   | Endereço de bind. Mantenha em loopback a menos que precise expor pra LAN. |
| `BRIDGE_MODE`       | `extension`   | Como conectar: `extension` (padrão) ou `baileys`. Veja as seções "Como rodar" acima. |
| `ENABLE_SEND`       | `false`       | Defina `true` pra liberar `POST /chats/:id/messages`.        |
| `SEND_AGENT_PREFIX` | *(vazio)*     | Marcador opcional prefixado às mensagens enviadas (ex.: `[Agente]`, `🤖`), pra deixar claro que veio de agente/skill/automação. Espaço é inserido automaticamente. Vazio = desligado. Cada envio pode sobrescrever com `--prefix "..."` ou `--no-prefix` no `wa send`. |
| `BAILEYS_LOG_LEVEL` | `warn`        | Verbosidade interna do Baileys. Suba pra `info`/`debug` só quando estiver investigando problema na conexão WA. |
| `TRANSCRIBE_PROVIDER` | `off`       | Transcrição de áudio: `off` \| `groq` \| `openai` \| `whisper-local`. Veja "Mídia" abaixo. |
| `OCR_PROVIDER`      | `off`         | OCR/descrição de imagem: `off` \| `claude` \| `groq` \| `tesseract`. |
| `STORE_MEDIA`       | `off`         | Guardar arquivos em `data/media/` p/ download: `off` \| `processed` \| `documents` \| `all`. |
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Chave do provedor escolhido (só a que você usa). |
| `MEDIA_MAX_BYTES`   | `20971520`    | Tamanho máximo (bytes) de mídia baixada/processada (20 MB). |
| `TRANSCRIBE_LANGUAGE` | `pt`        | Dica de idioma (ISO-639-1) pra transcrição; `""` = automático. |

## Mídia: transcrição de áudio e OCR de imagem

Por padrão, áudios e imagens entram no banco só como `[audio]` / `[image]`. Você pode ligar **transcrição de voz** e **OCR/descrição de imagem** — tudo opcional, escolhido no `.env`, e **nada sai da máquina** até você ativar e colocar a chave. O texto resultante é "dobrado" na própria mensagem (aparece no `wa read` como `🎙️ <transcrição>` / `🖼️ <texto>`) e entra na **busca full-text**.

**Transcrição de áudio** (`TRANSCRIBE_PROVIDER`):

| Valor | O que usa | Observações |
|-------|-----------|-------------|
| `off` | — | padrão |
| `groq` | Groq Whisper (nuvem) | rápido, free tier; precisa de `GROQ_API_KEY` |
| `openai` | OpenAI Whisper (nuvem) | ~US$0,006/min; precisa de `OPENAI_API_KEY` |
| `whisper-local` | whisper.cpp offline | privado, sem chave; precisa de `ffmpeg` no PATH e `npm i nodejs-whisper && npx nodejs-whisper download` |

**OCR / descrição de imagem** (`OCR_PROVIDER`):

| Valor | O que usa | Observações |
|-------|-----------|-------------|
| `off` | — | padrão |
| `claude` | Anthropic (visão) | OCR + descrição num call só, ótimo p/ boleto/comprovante; precisa de `ANTHROPIC_API_KEY` |
| `groq` | Groq (visão Llama) | mesma `GROQ_API_KEY` do áudio |
| `tesseract` | Tesseract local | offline, só extrai texto; `npm i tesseract.js` |

Exemplo de `.env` (Groq pro áudio, Claude pra imagem, guardando os processados):

```
TRANSCRIBE_PROVIDER=groq
OCR_PROVIDER=claude
STORE_MEDIA=processed
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
```

Notas:

- **Só mensagens novas** são processadas — o backfill de histórico *não* baixa mídia de propósito (evita transcrever milhares de áudios antigos e gastar à toa).
- Provedores de nuvem (groq/openai/claude) não exigem dependência extra (usam `fetch`). Os locais (`tesseract`/`whisper-local`) você instala só se for usá-los.
- `STORE_MEDIA` controla se o arquivo bruto é guardado em `data/media/` (pra baixar via `GET /chats/:id/messages/:msgId/media`). Com `off`, a transcrição/OCR ainda funciona — o arquivo é descartado depois.
- Confira o estado atual com `npm run wa -- health` (linha `media:`).
- **Baixar/analisar um arquivo recebido:** mesmo com `STORE_MEDIA=off`, você pode re-baixar uma mídia antiga do WhatsApp sob demanda: `npm run wa -- media <msgId> --out arquivo.ext` (pegue o `msgId` com `wa read <nome> --json`). Precisa da aba do WhatsApp Web aberta e que a mídia ainda exista no WhatsApp.

## Resumo diário, pendentes e alertas

Três recursos pro dia-a-dia, em cima do que a ponte já guarda:

- **Resumo de não-lidas** — `npm run wa -- digest` agrupa as conversas com mensagens não lidas. Por padrão devolve os dados estruturados e **quem lê resume** (ex.: você pedindo "resume meu WhatsApp" pro Claude, ou um agente agendado via `/schedule` às 8h). Se quiser o resumo gerado pelo próprio serviço, ligue `SUMMARY_PROVIDER` (`groq`/`openai`/`claude`) no `.env` e use `wa digest --summarize`.
- **Quem está esperando resposta** — `npm run wa -- pending [--hours N] [--dm]` lista os chats cuja última mensagem é deles (não sua) e está sem resposta há mais de N horas (padrão 3), do que espera há mais tempo pro mais recente. Bom pra não perder cliente.
- **Watchlist de palavras-chave** — coloque termos em `watchlist.txt` (copie de `watchlist.example.txt`); quando uma mensagem recebida bate um termo, a ponte registra (veja `wa alerts`) e dispara os canais configurados no `.env`:
  - `ALERT_WHATSAPP_TO` — manda o alerta como mensagem de WhatsApp pra esse número/JID (ex.: você mesmo). Reusa o envio → exige `ENABLE_SEND=true` **e** o número na `send_whitelist.txt`.
  - `ALERT_WEBHOOK_URL` — faz `POST` de um JSON pra essa URL (compatível com ntfy.sh, webhook de Discord/Slack, ou seu serviço).

  Sem nenhum canal, os hits ficam só registrados (úteis em `wa alerts` e no digest). Só mensagens recentes disparam alerta (mensagens antigas vindas de backfill são ignoradas).

## Enviar mídia, responder citando e @menções

- **Responder citando** uma mensagem específica: `npm run wa -- send <nome> "texto" --reply <msgId>` (pegue o `msgId` com `wa read <nome> --json`). Funciona no modo extensão; no modo baileys envia sem a citação.
- **Enviar arquivo** (imagem, PDF, etc.): `npm run wa -- send <nome> --file <caminho-ou-url> [--caption "legenda"]`. O caminho pode ser um arquivo local **ou** uma URL — o serviço lê/baixa (respeitando `MEDIA_MAX_BYTES`) e envia. Mesmo gate de envio (`ENABLE_SEND` + whitelist).
- **@menções a você** em grupos: `npm run wa -- mentions` lista onde te marcaram. (A extensão precisa estar atualizada/recarregada pra capturar isso nas mensagens novas.)

## Exportar conversa para documento

`npm run wa -- export <nome> [--days N] [--out conversa.md]` gera um Markdown limpo da conversa (cabeçalho + mensagens com horário). Para um documento no padrão visual da Loja Interativa, exporte e depois peça ao Claude pra montar o `.docx`/PDF com a skill `edicao-documentos-loja-interativa` usando esse conteúdo.

## Mantendo a extensão atualizada

De vez em quando o WhatsApp Web muda por dentro e a captura pode parar de funcionar. Quando isso acontecer, atualize o leitor e gere a extensão de novo:

```bash
npm update @wppconnect/wa-js && npm run build-extension
```

Depois, em `chrome://extensions`, clique no ícone de recarregar (↻) da extensão e atualize a aba do WhatsApp Web.

## Whitelist de envio

Quando `ENABLE_SEND=true`, o serviço **só** envia para os chats listados em `send_whitelist.txt` (na raiz do projeto). Arquivo vazio ou inexistente significa que *nenhum envio é permitido* — é opt-in por design.

Comece a partir do exemplo que vai no repo:

```bash
cp send_whitelist.example.txt send_whitelist.txt
```

### Jeito mais fácil: `npm run wl`

Picker interativo — mostra todos os chats que o serviço já viu, com checkbox pré-marcado para os que já estão na whitelist. Marca/desmarca com espaço, confirma com enter. Preserva entradas manuais (ex.: números de contatos que ainda não mandaram mensagem pra ponte).

```bash
npm run wl
```

Requer que o serviço já tenha rodado pelo menos uma vez e registrado alguns chats. O picker lê o SQLite local; não precisa do serviço estar rodando enquanto você escolhe.

### Manualmente

Edite o arquivo — uma entrada por linha. Formatos aceitos:

- Número de telefone (só dígitos): `5511999999999`
- JID de DM: `5511999999999@s.whatsapp.net`
- JID de grupo: `120363xxxxxxxxxxxx@g.us`

Linhas começando com `#` são comentários; comentário inline `# ...` depois da entrada também vale. O serviço observa o arquivo e recarrega ao salvar — sem necessidade de restart.

Para inspecionar a lista ativa:

```bash
TOKEN=$(jq -r .apiToken ~/.whatsapp-bridge/config.json)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4477/send/whitelist
```

`send_whitelist.txt` está no `.gitignore` — cada pessoa do time mantém o seu.

## API HTTP

Todos os endpoints exceto `/health` exigem `Authorization: Bearer <apiToken>` (token está em `~/.whatsapp-bridge/config.json`).

| Método | Caminho                              | Descrição                              |
|--------|--------------------------------------|----------------------------------------|
| GET    | `/health`                            | `{ connected, hasQR, sendEnabled, ... }` |
| GET    | `/qr`                                | String bruta do QR se ainda não pareou |
| GET    | `/chats?limit=20&unread=true`        | Mais recentes primeiro                 |
| GET    | `/chats/:id/messages?limit=50&since=<ms>` | Mais antigas primeiro dentro da página |
| POST   | `/chats/:id/read`                    | Zera flag de não lidas                 |
| GET    | `/search?q=<texto>&limit=20`         | Busca FTS5 no corpo das mensagens      |
| GET    | `/digest?limit=30&summarize=true`    | Não-lidas agrupadas; `summarize=true` resume server-side (se `SUMMARY_PROVIDER`) |
| GET    | `/pending?hours=3&limit=50`          | Chats esperando sua resposta há mais de N horas |
| GET    | `/alerts?limit=30`                   | Últimos hits da watchlist de palavras-chave |
| GET    | `/mentions?limit=30&days=N`          | Mensagens em que você foi @-mencionado |
| GET    | `/send/whitelist`                    | Lista os chats atualmente permitidos   |
| POST   | `/chats/:id/messages`                | `{ text }`, reply `{ text, quotedMsgId }` ou mídia `{ media:{path\|url}, caption?, quotedMsgId? }` — exige `ENABLE_SEND` **e** chat na whitelist |
| GET    | `/chats/:id/messages/:msgId/media`   | Baixa o arquivo de mídia guardado (se `STORE_MEDIA` o mantiver) |
| POST   | `/messages/:msgId/fetch-media`       | Re-baixa a mídia de uma mensagem antiga do WhatsApp e guarda (força persistência) |
| GET    | `/messages/:msgId/media`             | Baixa o arquivo de mídia guardado, pelo id da mensagem |

Exemplo:

```bash
TOKEN=$(jq -r .apiToken ~/.whatsapp-bridge/config.json)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4477/health
```

## Notas de segurança

- O serviço escuta em `127.0.0.1` por padrão. Qualquer processo com acesso ao shell da máquina pode ler o token e usar a API — mesmo nível de confiança do seu terminal.
- **Nunca** comite `auth_data/`, `data/`, nem `~/.whatsapp-bridge/config.json`. O `.gitignore` já bloqueia os dois primeiros.
- Ativar `ENABLE_SEND` significa que qualquer coisa com acesso ao token (incluindo a skill rodando na sua sessão do Claude Code) pode enviar mensagens em nome da sua conta. Trate como credencial.
- Use uma conta de WhatsApp não crítica pra testar.

## Solução de problemas

**`unexpected error in 'init queries'` (`statusCode: 408`)** — Ruído inofensivo do Baileys durante inicialização. A lib consulta o servidor do WhatsApp por configs de cliente logo após conectar; ocasionalmente uma dessas consultas dá timeout. O socket continua aberto e mensagens continuam chegando — confirme via `GET /health` (os contadores `messages` e `chats` sobem conforme o tráfego entra).

**`failed to decrypt message` / `MessageCounterError: Key used already or never filled`** — Mismatch de contador do Signal Protocol em mensagens re-entregues, geralmente depois de um restart. Mensagens novas decriptam normalmente; o ruído é mensagem antiga sendo reempurrada pelo servidor do WhatsApp. Setar `BAILEYS_LOG_LEVEL=fatal` (ou `silent`) no `.env` esconde isso.

**`Logged out` no terminal** — Apague `auth_data/` e reinicie para parear de novo.

**Conexão cai, fica em loop de reconnect** — Geralmente é blip de rede ou mudança no protocolo do WhatsApp. Tente primeiro `npm update @whiskeysockets/baileys`. Se persistir, dá uma olhada nas issues abertas no repo do Baileys.

**A skill diz que não consegue alcançar o serviço** — Confirme que `npm start` está rodando e `~/.whatsapp-bridge/config.json` existe. A skill lê `baseUrl` e `apiToken` desse arquivo.

**A skill não dispara** — Verifique se você rodou `npm run install-skill` e abriu uma sessão nova do Claude Code. Confirme que o arquivo `~/.claude/skills/whatsapp-assistant/SKILL.md` está lá.

**(Modo extensão) As mensagens não aparecem / o Claude diz que não tem nada novo** — A aba do `web.whatsapp.com` precisa estar **aberta**. Confirme no console da aba (`F12` → Console) a linha `[wab] connected to WPP, streaming...`. Lembre que o serviço só captura mensagens recebidas **enquanto** estava rodando — ele não importa o histórico antigo.

**(Modo extensão) `Failed to fetch` no console da aba** — O serviço não está no ar ou está em outra porta. Confirme que o `npm start` está rodando e que a URL nas opções da extensão bate com a do serviço.

## Compartilhando com o time

O repo está estruturado pra ser clonado direto. Cada pessoa:
1. Clona o repo e roda `npm install`.
2. Roda `npm run install-skill`.
3. Cria o `.env` (`cp .env.example .env`) e escolhe o modo (veja "Como rodar").
4. Sobe com `npm start` e conecta o próprio WhatsApp (extensão + token, ou QR no modo Baileys).

Cada pessoa tem sessão, token e banco de mensagens próprios, locais — sem estado compartilhado.

## Licença / aviso

Pra uso interno. O Baileys é licenciado em MIT, mas os Termos de Serviço do WhatsApp não permitem oficialmente clientes não oficiais. Use por sua conta e risco, em contas que você mesmo controla.
