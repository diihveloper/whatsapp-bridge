# whatsapp-bridge

Serviço local que mantém uma sessão do WhatsApp Web autenticada e expõe uma API HTTP enxuta. Acompanha uma skill do Claude Code (`whatsapp-read`) que permite ao Claude ler suas mensagens sob demanda.

Construído sobre [Baileys](https://github.com/WhiskeySockets/Baileys). **Não oficial** — vale os mesmos trade-offs de qualquer automação do WhatsApp Web (use uma conta não crítica, risco baixo mas existente de banimento, o protocolo pode mudar e exigir `npm update`).

## O que você ganha

- Serviço Node que conecta no WhatsApp Web, persiste mensagens em SQLite e expõe tudo em `http://127.0.0.1:4477` com token Bearer.
- Skill do Claude Code que ensina o Claude a consultar esse serviço. Dispara sempre que o usuário pergunta algo sobre WhatsApp.
- Somente leitura por padrão. Envio só funciona se `ENABLE_SEND=true`.

## Pré-requisitos

- Node.js 20 ou mais novo.
- Windows / macOS / Linux. No Windows, o `better-sqlite3` já vem com binários compilados — sem necessidade do MSVC toolchain.

## Instalação

```bash
# 1. instalar dependências
npm install

# 2. opcional: copiar .env.example pra .env e ajustar
cp .env.example .env

# 3. instalar a skill do Claude Code (copia skill/ pra ~/.claude/skills/)
npm run install-skill

# 4. subir o serviço (fica em foreground)
npm start
```

Faça o `install-skill` antes do `start` — `npm start` segura o terminal, então depois disso só dá pra rodar outros comandos parando o serviço ou abrindo outra aba.

Na primeira execução do `npm start`, o serviço:
1. Gera um token de API e grava em `~/.whatsapp-bridge/config.json` (chmod 600).
2. Imprime um QR code no terminal — escaneie no celular: **Configurações → Aparelhos conectados → Conectar um aparelho**.
3. Começa a escutar em `127.0.0.1:4477`.

O estado de autenticação fica persistido em `./auth_data/`, então o QR só precisa ser escaneado uma vez. As mensagens ficam em `./data/messages.db`.

## Usando a skill

Depois do `install-skill`, inicie uma sessão nova do Claude Code e pergunte coisas como:

- "quais mensagens do WhatsApp eu tenho não lidas?"
- "me mostra as últimas 20 mensagens do grupo do time"
- "procura 'proposta' no WhatsApp"

Se você instalou a skill com o Claude Code já aberto, feche e reabra pra ele detectar.

## Configuração

Variáveis de ambiente (no `.env` ou no shell):

| Variável            | Padrão        | Função                                                       |
|---------------------|---------------|--------------------------------------------------------------|
| `PORT`              | `4477`        | Porta HTTP                                                   |
| `HOST`              | `127.0.0.1`   | Endereço de bind. Mantenha em loopback a menos que precise expor pra LAN. |
| `BRIDGE_MODE`       | `baileys`     | `baileys` (socket embutido) ou `extension` (conexão vive numa aba do Chrome via extensão — ver abaixo). |
| `ENABLE_SEND`       | `false`       | Defina `true` pra liberar `POST /chats/:id/messages`.        |
| `BAILEYS_LOG_LEVEL` | `warn`        | Verbosidade interna do Baileys. Suba pra `info`/`debug` só quando estiver investigando problema na conexão WA. |

## Modo extensão (menor risco de banimento)

O modo `baileys` registra um **aparelho conectado** reimplementando o protocolo — é o que pode levantar flag na Meta. O modo `extension` evita isso: a conexão com o WhatsApp continua sendo a sua sessão **oficial** do WhatsApp Web, aberta numa aba do Chrome/Chromium, e uma extensão observa as mensagens e alimenta este serviço. Nenhum aparelho novo é criado.

Trade-off: precisa de uma aba do WhatsApp Web **aberta** pra funcionar — não roda 24/7 headless como o Baileys.

### Setup

```bash
# 1. baixar/atualizar o bundle do wa-js para dentro da extensão
npm run build-extension

# 2. subir o serviço em modo extensão
BRIDGE_MODE=extension ENABLE_SEND=true npm start   # PowerShell: $env:BRIDGE_MODE='extension'; ...
```

3. No Chrome/Chromium: `chrome://extensions` → ativar **Modo do desenvolvedor** → **Carregar sem compactação** → selecionar a pasta `extension/`.
4. Clicar em **Detalhes → Opções da extensão** e colar o `apiToken` de `~/.whatsapp-bridge/config.json` (e a URL do serviço, se mudou a porta).
5. Abrir/recarregar `https://web.whatsapp.com` (logado). O console da aba mostra `[wab] connected to WPP, streaming messages to the bridge`.

A partir daí as mensagens novas caem no `data/messages.db` e os envios enfileirados pelo `POST /chats/:id/messages` são executados pela aba. Detalhes em [`extension/README.md`](extension/README.md).

Depois de uma atualização do WhatsApp Web que quebre a captura, rode `npm update @wppconnect/wa-js && npm run build-extension` e recarregue a extensão.

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
| GET    | `/send/whitelist`                    | Lista os chats atualmente permitidos   |
| POST   | `/chats/:id/messages`                | `{ "text": "..." }` — exige `ENABLE_SEND` **e** chat na whitelist |

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

**A skill não dispara** — Verifique se você rodou `npm run install-skill` e abriu uma sessão nova do Claude Code. Confirme que o arquivo `~/.claude/skills/whatsapp-read/SKILL.md` está lá.

## Compartilhando com o time

O repo está estruturado pra ser clonado direto. Cada pessoa:
1. Clona o repo.
2. Roda `npm install`.
3. Roda `npm run install-skill`.
4. Roda `npm start` e escaneia o QR com o próprio WhatsApp.

Cada pessoa tem sessão, token e banco de mensagens próprios, locais — sem estado compartilhado.

## Licença / aviso

Pra uso interno. O Baileys é licenciado em MIT, mas os Termos de Serviço do WhatsApp não permitem oficialmente clientes não oficiais. Use por sua conta e risco, em contas que você mesmo controla.
