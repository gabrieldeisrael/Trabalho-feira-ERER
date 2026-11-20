const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv);

const SENHA = process.env.MOD_SENHA || 'troque-isso';
const BLOQUEADAS = []; // palavrões óbvios: preencha, serão rejeitados na hora
const TOTAL_PERGUNTAS = 10; // quantidade de perguntas do QUIZ em public/index.html
const MIN_MS = 1000;                 // abaixo de 1s: tempo inválido
const MAX_MS = 2 * 60 * 60 * 1000;   // acima de 2h: aba dormiu / relógio maluco
const TOL_MS = 5 * 60 * 1000;        // tolerância entre relógio do navegador e do servidor

const url = process.env.DATABASE_URL;
const db = new Pool({
  connectionString: url,
  ssl: url && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : false,
});

app.use(express.json());
app.use(express.static('public'));

const auth = (q, r, next) => (q.get('x-senha') === SENHA ? next() : r.sendStatus(401));
const avisar = () => { io.emit('atualizar'); io.emit('stats'); };

app.get('/health', (q, r) => r.send('ok'));

// Páginas
app.get('/nuvem', (q, r) => r.sendFile(path.join(__dirname, 'nuvemdepalavrantes.html')));
app.get('/estatisticas', (q, r) => r.sendFile(path.join(__dirname, 'public', 'estatisticas.html')));

// Cada pessoa que abre o quiz recebe um número sequencial
app.post('/api/participantes', async (q, r) => {
  const { rows } = await db.query('insert into participantes default values returning numero');
  avisar();
  r.json({ numero: rows[0].numero });
});

// Resposta de cada pergunta, ligada ao número da pessoa
app.post('/api/respostas', async (q, r) => {
  const numero = Number(q.body.numero);
  const pergunta = Number(q.body.pergunta);
  if (!Number.isInteger(numero) || !Number.isInteger(pergunta) || pergunta < 0) {
    return r.status(400).json({ erro: 'dados inválidos' });
  }
  const { rowCount } = await db.query(
    `insert into respostas (participante, pergunta, acertou)
     select $1, $2, $3 where exists (select 1 from participantes where numero = $1)
     on conflict (participante, pergunta) do update set acertou = excluded.acertou`,
    [numero, pergunta, !!q.body.acertou]
  );
  if (!rowCount) return r.sendStatus(404);
  avisar();
  r.json({ ok: true });
});

// Nuvem: palavras aprovadas + contagem
app.get('/api/nuvem', async (q, r) => {
  const { rows } = await db.query(
    "select texto, count(*)::int as n from palavras where status='aprovada' group by texto"
  );
  r.json(rows);
});

// Usuário envia palavra (uma vez por número) junto com a duração do quiz
app.post('/api/palavras', async (q, r) => {
  const t = String(q.body.texto || '').trim().toLowerCase().slice(0, 30);
  if (!t) return r.status(400).json({ erro: 'vazio' });
  const numero = Number(q.body.numero);
  if (!Number.isInteger(numero) || numero <= 0) return r.status(400).json({ erro: 'número inválido' });

  const agora = Date.now();
  const started = Number(q.body.startedAt);
  const finished = Number(q.body.finishedAt);
  const informado = Number(q.body.duracao_ms);
  const duracao = finished - started;
  const tempoOk =
    Number.isFinite(started) && started > 0 &&
    Number.isFinite(finished) && finished > 0 &&
    duracao >= MIN_MS && duracao <= MAX_MS &&
    Math.abs(informado - duracao) <= 1000 &&
    finished <= agora + TOL_MS &&
    started >= agora - MAX_MS - TOL_MS;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('select criado, enviado from participantes where numero=$1 for update', [numero]);
    if (!p.rows.length) { await client.query('ROLLBACK'); return r.sendStatus(404); }
    if (p.rows[0].enviado) { await client.query('ROLLBACK'); return r.status(409).json({ erro: 'já enviado' }); }

    // Tempo impossível (aba dormiu, relógio ajustado, valor zerado/negativo) fica sem tempo
    // e não entra no speedrun. As respostas e a palavra continuam salvas normalmente.
    let startedAt = null, finishedAt = null, duracaoMs = null;
    if (tempoOk && started >= new Date(p.rows[0].criado).getTime() - TOL_MS) {
      startedAt = started;
      finishedAt = finished;
      duracaoMs = Math.round(duracao);
    }

    await client.query(
      `update participantes set started_at=to_timestamp($2::double precision/1000.0),
         finished_at=to_timestamp($3::double precision/1000.0), duracao_ms=$4, enviado=true
       where numero=$1`, [numero, startedAt, finishedAt, duracaoMs]);

    let status = 'pendente';
    if (BLOQUEADAS.includes(t)) {
      status = 'rejeitada';
    } else {
      // se a palavra já foi decidida antes, herda a decisão (excluídas também ficam fora)
      const { rows } = await client.query(
        "select status from palavras where texto=$1 and status in ('aprovada','rejeitada','excluida') limit 1", [t]);
      if (rows.length) status = rows[0].status;
    }
    await client.query('insert into palavras (texto, status, participante) values ($1,$2,$3)', [t, status, numero]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return r.status(500).json({ erro: 'falha ao salvar' });
  } finally {
    client.release();
  }
  avisar();
  r.json({ ok: true });
});

// Moderação
app.get('/api/pendentes', auth, async (q, r) => {
  const { rows } = await db.query(
    "select texto, count(*)::int as n from palavras where status='pendente' group by texto order by min(id)"
  );
  r.json(rows);
});

app.get('/api/aprovadas', auth, async (q, r) => {
  const { rows } = await db.query(
    "select texto, count(*)::int as n from palavras where status='aprovada' group by texto order by min(id) desc"
  );
  r.json(rows);
});

app.post('/api/moderar', auth, async (q, r) => {
  const { texto, aprovar } = q.body;
  await db.query("update palavras set status=$2 where texto=$1 and status='pendente'", [
    texto,
    aprovar ? 'aprovada' : 'rejeitada',
  ]);
  avisar();
  r.json({ ok: true });
});

// Apagar uma palavra aprovada: some da nuvem, mas a resposta da pessoa fica salva
app.post('/api/excluir', auth, async (q, r) => {
  const texto = String(q.body.texto || '').trim().toLowerCase().slice(0, 30);
  await db.query("update palavras set status='excluida' where texto=$1 and status='aprovada'", [texto]);
  avisar();
  r.json({ ok: true });
});

// Zerar tudo antes da feira (os números voltam a começar em 1)
app.post('/api/limpar', auth, async (q, r) => {
  await db.query('truncate table respostas, palavras, participantes restart identity');
  avisar();
  r.json({ ok: true });
});

// Estatísticas (públicas, ficam abertas na TV/computador da feira)
app.get('/api/stats', async (q, r) => {
  const [perguntas, ranking, totais, speedrun] = await Promise.all([
    db.query(`select pergunta, count(*) filter (where acertou)::int as acertos,
                     count(*)::int as respondidas
              from respostas where pergunta between 1 and $1 group by pergunta order by pergunta`, [TOTAL_PERGUNTAS]),
    db.query(`select p.numero, count(r.id) filter (where r.acertou)::int as acertos,
                     count(r.id)::int as respondidas
              from participantes p left join respostas r
                on r.participante = p.numero and r.pergunta between 1 and $1
              group by p.numero order by acertos desc, p.numero asc limit 30`, [TOTAL_PERGUNTAS]),
    db.query(`select (select count(*) from participantes)::int as participantes,
                     (select count(*) from palavras)::int as palavras,
                     (select count(*) from palavras where status='aprovada')::int as aprovadas`),
    // Pool do speedrun: pontuação primeiro, menor tempo desempata; sem tempo vai por último
    db.query(`select p.numero, count(r.id) filter (where r.acertou)::int as acertos,
                     p.duracao_ms, p.finished_at
              from participantes p left join respostas r
                on r.participante = p.numero and r.pergunta between 1 and $1
              where p.enviado
              group by p.numero, p.duracao_ms, p.finished_at
              order by acertos desc, p.duracao_ms asc nulls last, p.numero asc
              limit 30`, [TOTAL_PERGUNTAS]),
  ]);
  r.json({
    perguntas: perguntas.rows,
    ranking: ranking.rows,
    totais: totais.rows[0],
    speedrun: speedrun.rows,
    totalPerguntas: TOTAL_PERGUNTAS,
  });
});

app.get('/api/participantes/:numero', async (q, r) => {
  const numero = Number(q.params.numero);
  if (!Number.isInteger(numero) || numero <= 0) return r.status(400).json({ erro: 'número inválido' });
  const [p, respostas, palavra] = await Promise.all([
    db.query('select numero, criado from participantes where numero=$1', [numero]),
    db.query('select pergunta, acertou from respostas where participante=$1 and pergunta between 1 and $2 order by pergunta', [numero, TOTAL_PERGUNTAS]),
    db.query('select texto, status from palavras where participante=$1 order by id desc limit 1', [numero]),
  ]);
  if (!p.rows.length) return r.sendStatus(404);
  r.json({
    numero: p.rows[0].numero,
    criado: p.rows[0].criado,
    respostas: respostas.rows,
    palavra: palavra.rows[0] || null,
  });
});

// heartbeat da /tv (mantém o serviço acordado no Render grátis)
io.on('connection', (s) => s.on('hb', () => {}));

(async () => {
  await db.query(`create table if not exists participantes (
    numero serial primary key,
    criado timestamptz default now()
  )`);
  await db.query(`create table if not exists respostas (
    id serial primary key,
    participante int not null references participantes(numero),
    pergunta int not null,
    acertou boolean not null,
    unique (participante, pergunta)
  )`);
  await db.query(`create table if not exists palavras (
    id serial primary key,
    texto text not null,
    status text not null default 'pendente',
    criado timestamptz default now()
  )`);
  await db.query('alter table palavras add column if not exists participante int references participantes(numero)');
  await db.query('alter table participantes add column if not exists started_at timestamptz');
  await db.query('alter table participantes add column if not exists finished_at timestamptz');
  await db.query('alter table participantes add column if not exists duracao_ms int');
  await db.query('alter table participantes add column if not exists enviado boolean not null default false');

  // Render grátis dorme/acorda: a sequence do serial já sobrevive ao restart, mas
  // garantimos que ela nunca fique atrás do maior número usado — e nunca volta a #1 sozinha.
  const { rows: seq } = await db.query('select count(*)::int as n, coalesce(max(numero), 0) as max from participantes');
  if (seq[0].n > 0) {
    await db.query(`select setval(
      pg_get_serial_sequence('participantes','numero'),
      greatest($1, coalesce(pg_sequence_last_value(pg_get_serial_sequence('participantes','numero')), 0)))`,
      [seq[0].max]);
  }
  srv.listen(process.env.PORT || 3000, () => console.log('no ar'));
})();
