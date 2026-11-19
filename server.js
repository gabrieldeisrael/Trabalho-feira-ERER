const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const app = express();
const srv = http.createServer(app);
const io = new Server(srv);

const SENHA = process.env.MOD_SENHA || 'troque-isso';
const BLOQUEADAS = []; // palavrões óbvios: preencha, serão rejeitados na hora

const url = process.env.DATABASE_URL;
const db = new Pool({
  connectionString: url,
  ssl: url && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : false,
});

app.use(express.json());
app.use(express.static('public'));

const auth = (q, r, next) => (q.get('x-senha') === SENHA ? next() : r.sendStatus(401));

app.get('/health', (q, r) => r.send('ok'));

// TV: palavras aprovadas + contagem
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

  let status = 'pendente';
  if (BLOQUEADAS.includes(t)) {
    status = 'rejeitada';
  } else {
    // se a palavra já foi decidida antes, herda a decisão
    const { rows } = await db.query(
      "select status from palavras where texto=$1 and status in ('aprovada','rejeitada') limit 1",
      [t]
    );
    if (rows.length) status = rows[0].status;
  }
  await db.query('insert into palavras (texto, status) values ($1,$2)', [t, status]);
  io.emit('atualizar');
  r.json({ ok: true });
});

// Moderação
app.get('/api/pendentes', auth, async (q, r) => {
  const { rows } = await db.query(
    "select texto, count(*)::int as n from palavras where status='pendente' group by texto order by min(id)"
  );
  r.json(rows);
});

app.post('/api/moderar', auth, async (q, r) => {
  const { texto, aprovar } = q.body;
  await db.query("update palavras set status=$2 where texto=$1 and status='pendente'", [
    texto,
    aprovar ? 'aprovada' : 'rejeitada',
  ]);
  io.emit('atualizar');
  r.json({ ok: true });
});

// heartbeat da /tv (mantém o serviço acordado no Render grátis)
io.on('connection', (s) => s.on('hb', () => {}));

(async () => {
  await db.query(`create table if not exists palavras (
    id serial primary key,
    texto text not null,
    status text not null default 'pendente',
    criado timestamptz default now()
  )`);
  srv.listen(process.env.PORT || 3000, () => console.log('no ar'));
})();
