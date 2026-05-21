# whatsapp-bridge

Programa que roda **no seu próprio computador**, fica conectado ao seu WhatsApp e guarda as mensagens num banco de dados local. Vem junto com uma skill do Claude Code (`whatsapp-read`) que deixa o Claude **ler, buscar e (se você liberar) enviar** mensagens pra você — por exemplo: "me faz um resumo do que rolou no grupo hoje".

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
| `BAILEYS_LOG_LEVEL` | `warn`        | Verbosidade interna do Baileys. Suba pra `info`/`debug` só quando estiver investigando problema na conexão WA. |

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
