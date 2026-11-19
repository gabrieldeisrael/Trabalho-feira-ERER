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

// Usuário envia palavra
app.post('/api/palavras', async (q, r) => {
  const t = String(q.body.texto || '').trim().toLowerCase().slice(0, 30);
  if (!t) return r.status(400).json({ erro: 'vazio' });
  const numero = Number(q.body.numero);
  const participante = Number.isInteger(numero) && numero > 0 ? numero : null;

  let status = 'pendente';
  if (BLOQUEADAS.includes(t)) {
    status = 'rejeitada';
  } else {
    // se a palavra já foi decidida antes, herda a decisão (excluídas também ficam fora)
    const { rows } = await db.query(
      "select status from palavras where texto=$1 and status in ('aprovada','rejeitada','excluida') limit 1",
      [t]
    );
    if (rows.length) status = rows[0].status;
  }
  await db.query('insert into palavras (texto, status, participante) values ($1,$2,$3)', [t, status, participante]);
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
  const [perguntas, ranking, totais] = await Promise.all([
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
  ]);
  r.json({
    perguntas: perguntas.rows,
    ranking: ranking.rows,
    totais: totais.rows[0],
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
  srv.listen(process.env.PORT || 3000, () => console.log('no ar'));
})();
