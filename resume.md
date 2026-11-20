# Resumo do projeto — Quiz + Nuvem de Palavras (ERER)

Aplicação para a feira: um Chromebook faz o quiz e envia uma palavra, outro modera, outro mostra estatísticas públicas e a TV mostra a nuvem de palavras ao vivo.

- **Produção:** https://trabalho-feira-erer.onrender.com
- **Local:** `npm start` → http://localhost:3000 (porta configurável por `PORT`)
- **Stack:** Node >= 20, Express 5, PostgreSQL (`pg`), Socket.IO. Arquivos estáticos em `public/`.

---

## 1. URLs e telas

| URL | Arquivo | Quem usa | O que faz |
|---|---|---|---|
| `/` | `public/index.html` | Chromebook 1 (participante) | Quiz + envio da palavra |
| `/moderar.html` | `public/moderar.html` | Chromebook 2 (moderadores) | Aprovar/rejeitar e apagar palavras (com senha) |
| `/estatisticas` | `public/estatisticas.html` | Chromebook 3 (público) | Estatísticas e busca pelo número — **sem senha** |
| `/tv.html` | `public/tv.html` | TV | Nuvem minimalista (fundo preto, `wordcloud2.js`) |
| `/nuvem` | `nuvemdepalavrantes.html` (raiz) | TV (opcional) | Nuvem com o visual original do projeto |
| `/health` | — | Render/monitoramento | Retorna `ok` |
| `/perguntas.js` | `public/perguntas.js` | quiz e estatísticas | Enunciados das 10 perguntas (fonte única) |

> `/estatisticas.html` e `/tv.html` também funcionam pelo `express.static`, mas as rotas oficiais são as da tabela.

---

## 2. Senhas e autenticação

- A moderação pede a senha **dentro da própria página** (campo `type=password`, sem `prompt()`).
- A senha é enviada em todas as chamadas protegidas no header **`x-senha`**.
- No servidor: `const SENHA = process.env.MOD_SENHA || 'troque-isso'`.
  - **Importante:** se `MOD_SENHA` não estiver configurada no Render, a senha ativa é `troque-isso`.
  - A senha placeholder usada no desenvolvimento, conforme `AGENTS.md`, é **`erer2026`** (a trocar em 25/11).
  - O HTML **não** contém senha fixa: ele apenas repete o que foi digitado.
- A senha fica em `sessionStorage.senha` enquanto a aba estiver aberta. Se vier `401`, a página volta ao login.
- **Todas as rotas públicas** (quiz, nuvem, estatísticas, `/api/stats`, `/api/nuvem`, `/api/participantes`, `/api/participantes/:numero`) não exigem senha.

### Rotas protegidas

`GET /api/pendentes`, `GET /api/aprovadas`, `POST /api/moderar`, `POST /api/excluir`, `POST /api/limpar`.

---

## 3. Endpoints da API

### GET

| Rota | Retorno | Observações |
|---|---|---|
| `/api/nuvem` | `[{ texto, n }]` | Só palavras com `status='aprovada'`, agrupadas e contadas |
| `/api/pendentes` | `[{ texto, n }]` | Requer `x-senha`; ordenado pela mais antiga |
| `/api/aprovadas` | `[{ texto, n }]` | Requer `x-senha`; ordenado pela mais recente |
| `/api/stats` | `{ perguntas, ranking, totais, totalPerguntas }` | Público; ignora perguntas fora de 1–10; ranking limitado a 30 |
| `/api/participantes/:numero` | `{ numero, criado, respostas, palavra }` | Público; usado pela busca do `/estatisticas` |

### POST

| Rota | Corpo (JSON) | Auth | Efeito |
|---|---|---|---|
| `/api/participantes` | — | não | Cria participante, devolve `{ numero }` sequencial (`serial`) e avisa o Socket.IO |
| `/api/respostas` | `{ numero, pergunta, acertou }` | não | Salva/acatualiza a resposta (`unique (participante, pergunta)`); `pergunta` é o ID fixo 1–10; `acertou` é booleano |
| `/api/palavras` | `{ texto, numero }` | não | Insere palavra em minúsculas (até 30 caracteres) como `pendente`; se o texto já tiver sido decidido, herda o status (inclusive `excluida`) |
| `/api/moderar` | `{ texto, aprovar }` | **sim** | `aprovada` ou `rejeitada` para todas as pendentes com aquele texto |
| `/api/excluir` | `{ texto }` | **sim** | Muda aprovadas para `excluida` — some da nuvem, mas as respostas permanecem |
| `/api/limpar` | — | **sim** | `TRUNCATE ... RESTART IDENTITY`: apaga tudo e os números voltam a começar em 1 |

Todas as rotas que alteram dados emitem `atualizar` e `stats` via Socket.IO.

---

## 4. Socket.IO

- Eventos emitidos pelo servidor:
  - **`atualizar`** → recarrega a nuvem (`/nuvem`, `/tv.html`) e a moderação.
  - **`stats`** → recarrega o `/estatisticas`.
- Evento enviado pelos clientes: **`hb`** a cada **240000 ms (4 min)** nas páginas da TV, nuvem e estatísticas — heartbeat para manter o serviço acordado no Render gratuito.

---

## 5. Banco de dados (criado automaticamente no boot)

`DATABASE_URL` — conexão Postgres com SSL quando não é localhost.

| Tabela | Colunas |
|---|---|
| `participantes` | `numero serial PK`, `criado timestamptz default now()` |
| `respostas` | `id serial PK`, `participante` (FK), `pergunta int`, `acertou boolean`, `unique (participante, pergunta)` |
| `palavras` | `id serial PK`, `texto`, `status` (padrão `pendente`), `criado`, `participante` (FK) |

Status possíveis da palavra: **`pendente`**, **`aprovada`**, **`rejeitada`**, **`excluida`**.

No `server.js` existe `TOTAL_PERGUNTAS = 10` (fixo) e o array `BLOQUEADAS` (vazio) para palavrões rejeitados automaticamente.

---

## 6. Como funciona cada dispositivo

### Chromebook 1 — Quiz (`/`)
1. Tela inicial com o tema e o botão **Começar**. Ao clicar, `POST /api/participantes` dá o número do participante.
2. 10 perguntas em **ordem aleatória**, com as **alternativas também embaralhadas**. O ID fixo da pergunta (1–10) é o que vai para as estatísticas.
3. Ao responder: feedback imediato (verde/vermelho + explicação), `POST /api/respostas` e botão **Próxima**.
4. Depois da 10ª: tela da palavra → `POST /api/palavras` → resultado final com o número.
5. **Próxima pessoa** limpa o `sessionStorage` e recarrega, liberando o mesmo aparelho para a pessoa seguinte.
6. Estado salvo em `sessionStorage.estado` (`numero, ordem, i, pts, respostas, escolha, respondeu, enviou`): recarregar no meio continua de onde parou; responder duas vezes não soma ponto duplicado.

**Gabarito do arquivo: A D B A C D A B B C** (a shuffle muda a posição na tela, não a resposta correta). Os 10 enunciados e as explicações vieram do HTML anexado; `public/perguntas.js` guarda os enunciados usados também nas estatísticas.

### Chromebook 2 — Moderação (`/moderar.html`)
- Login na página → listas **Palavras pendentes** (✅ aprovar / ❌ rejeitar) e **Na nuvem** (🗑️ excluir).
- Excluir marca `excluida`: some da nuvem e da moderação, mas a resposta da pessoa fica salva no banco.
- Botão **Limpar dados de teste** com confirmação inline → `POST /api/limpar`.

### Chromebook 3 — Estatísticas (`/estatisticas`)
- Cartões: pessoas, palavras enviadas, palavras na nuvem.
- Barras de acerto por pergunta (usam os enunciados de `perguntas.js`).
- Ranking dos que mais acertaram (top 30).
- Busca pelo número: acertos/erros por pergunta, palavra enviada e status dela (na nuvem / aguardando / rejeitada / removida).

### TV
- `/tv.html` (nuvem pura) ou `/nuvem` (visual original com definições/grupos). Ambos mostram **somente palavras aprovadas** e se atualizam em tempo real.

---

## 7. Roteiro no dia da feira

1. Fazer deploy no Render com `DATABASE_URL` e `MOD_SENHA` configurados.
2. Abrir `/moderar.html`, entrar com a senha e clicar **Limpar dados de teste** → os números voltam a `#1`.
3. Chromebook 1 aberto em `/`, Chromebook 2 em `/moderar.html`, Chromebook 3 em `/estatisticas`, TV em `/tv.html` (ou `/nuvem`).
4. Aprovar/rejeitar palavras na moderação; apagar da nuvem pelo 🗑️ se necessário.
5. A busca do `/estatisticas` usa o número que aparece no quiz.

---

## 8. Ressalvas

- O servidor **confia no `acertou` enviado pelo navegador**; quem souber mexer no console pode inflar o ranking. Se precisar de ranking à prova de "jeitinho", mover o gabarito para o servidor.
- `BLOQUEADAS` está vazio: palavrões só saem pela moderação.
- Nenhum log é escrito no `AI_LOG.md` sem confirmação do usuário, conforme `AGENTS.md`.
- Este ambiente de desenvolvimento não tem Node/Postgres; a validação foi feita no navegador com uma API simulada. Vale um teste rápido no Render após o deploy.

---

## 9. Arquivos principais

| Arquivo | Papel |
|---|---|
| `server.js` | Rotas, autenticação, Socket.IO, criação das tabelas |
| `public/index.html` | Quiz com shuffle, feedback, número e envio da palavra |
| `public/perguntas.js` | Enunciados das 10 perguntas (compartilhado com estatísticas) |
| `public/moderar.html` | Senha, aprovação/rejeição, exclusão e limpeza |
| `public/estatisticas.html` | Painel público de estatísticas e busca |
| `nuvemdepalavrantes.html` | Nuvem com visual original |
| `public/tv.html` | Nuvem minimalista para TV |
| `package.json` | Dependências e script `start` |
| `AGENTS.md` / `AI_LOG.md` | Regras do projeto / histórico de alterações |
