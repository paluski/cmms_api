const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const app = express();
const SECRET = "segredo_super";

/* ==============================
   MIDDLEWARE
============================== */

app.use(cors());

app.use(express.json({
  limit: "20mb",
  type: "application/json",
}));

app.use(express.urlencoded({
  extended: true,
  limit: "20mb",
}));

app.use((req, res, next) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use("/uploads", express.static("uploads"));

/* ==============================
   FUNÇÕES AUXILIARES
============================== */

function normalizarTexto(valor) {
  if (valor === null || valor === undefined) return "";
  return String(valor).trim();
}

function normalizarNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  return Number.isNaN(numero) ? null : numero;
}

function garantirPastaUploads() {
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }
}

function agoraSql() {
  return "datetime('now','localtime')";
}

function gerarNomeArquivoSeguro(nomeOriginal) {
  const ext = path.extname(nomeOriginal || "").toLowerCase();
  const base = path
    .basename(nomeOriginal || "arquivo", ext)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_");

  return `${Date.now()}_${base}${ext}`;
}

garantirPastaUploads();

/* ==============================
   BANCO
============================== */

const db = new sqlite3.Database("database.db");

function ensureColumn(table, column, definition) {
  db.all(`PRAGMA table_info(${table})`, (err, columns) => {
    if (err || !columns) return;

    const exists = columns.some((c) => c.name === column);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  });
}

function registrarHistorico(ordemId, statusAnterior, statusNovo, usuarioId, observacao = "") {
  db.run(
    `
    INSERT INTO historico_os(
      ordem_id,
      status_anterior,
      status_novo,
      usuario_id,
      observacao,
      data
    )
    VALUES(?,?,?,?,?,datetime('now','localtime'))
    `,
    [ordemId, statusAnterior || "", statusNovo || "", usuarioId || null, normalizarTexto(observacao)]
  );
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'tecnico',
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usinas(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      potencia_kwp REAL,
      cidade TEXT,
      cliente TEXT,
      ativa INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tipos_falha(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      categoria TEXT,
      descricao TEXT,
      prioridade_padrao TEXT DEFAULT 'media',
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ordens_servico(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usina_id INTEGER,
      tecnico_id INTEGER,
      tipo TEXT,
      descricao TEXT,
      status TEXT,
      prioridade TEXT,
      data_abertura TEXT,
      data_inicio TEXT,
      data_fim TEXT,
      observacoes TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS fotos(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ordem_id INTEGER,
      tipo TEXT,
      caminho TEXT,
      data TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS relatorios(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ordem_id INTEGER,
      arquivo TEXT,
      data TEXT
    )
  `);
  
db.run(`
  CREATE TABLE IF NOT EXISTS comentarios_os(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ordem_id INTEGER NOT NULL,
    usuario_id INTEGER,
    comentario TEXT NOT NULL,
    data TEXT
  )
`);
  db.run(`
    CREATE TABLE IF NOT EXISTS historico_os(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ordem_id INTEGER NOT NULL,
      status_anterior TEXT,
      status_novo TEXT,
      usuario_id INTEGER,
      observacao TEXT,
      data TEXT
    )
  `);

  /* ========= MIGRAÇÕES ========= */

  ensureColumn("usuarios", "ativo", "INTEGER NOT NULL DEFAULT 1");

  ensureColumn("usinas", "ativa", "INTEGER NOT NULL DEFAULT 1");

  ensureColumn("ordens_servico", "prioridade", "TEXT DEFAULT 'media'");
  ensureColumn("ordens_servico", "tipo_falha_id", "INTEGER");
  ensureColumn("ordens_servico", "solicitante", "TEXT");
  ensureColumn("ordens_servico", "local", "TEXT");
  ensureColumn("ordens_servico", "equipamento", "TEXT");
  ensureColumn("ordens_servico", "programado_por", "INTEGER");
  ensureColumn("ordens_servico", "verificador_id", "INTEGER");
  ensureColumn("ordens_servico", "aprovador_id", "INTEGER");
  ensureColumn("ordens_servico", "data_programacao", "TEXT");
  ensureColumn("ordens_servico", "data_envio_verificacao", "TEXT");
  ensureColumn("ordens_servico", "data_verificacao", "TEXT");
  ensureColumn("ordens_servico", "data_aprovacao", "TEXT");
  ensureColumn("ordens_servico", "parecer_verificacao", "TEXT");
  ensureColumn("ordens_servico", "parecer_aprovacao", "TEXT");
  ensureColumn("ordens_servico", "motivo_reprovacao", "TEXT");

  /* ========= DADOS INICIAIS ========= */

  db.run(`
    INSERT OR IGNORE INTO usuarios(id,nome,email,senha,tipo,ativo)
    VALUES(1,'Administrador','admin@email.com','123456','admin',1)
  `);

  db.run(`
    INSERT OR IGNORE INTO usuarios(id,nome,email,senha,tipo,ativo)
    VALUES(2,'Tecnico','tecnico@email.com','123456','tecnico',1)
  `);
});

/* ==============================
   AUTH
============================== */

function auth(req, res, next) {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ erro: "Token ausente" });
  }

  const partes = header.split(" ");

  if (partes.length < 2 || partes[0] !== "Bearer") {
    return res.status(401).json({ erro: "Token inválido" });
  }

  const token = partes[1];

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ erro: "Token inválido" });
  }
}

function permitirTipos(...tiposPermitidos) {
  return (req, res, next) => {
    if (!req.user || !tiposPermitidos.includes(req.user.tipo)) {
      return res.status(403).json({ erro: "Sem permissão para esta ação" });
    }
    next();
  };
}

/* ==============================
   LOGIN
============================== */

app.post("/login", (req, res) => {
  const email = normalizarTexto(req.body.email);
  const senha = normalizarTexto(req.body.senha);

  db.get(
    "SELECT * FROM usuarios WHERE email=? AND senha=? AND ativo=1",
    [email, senha],
    (err, user) => {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao realizar login",
          detalhe: err.message,
        });
      }

      if (!user) {
        return res.status(401).json({ erro: "Login inválido" });
      }

      const token = jwt.sign(
        {
          id: user.id,
          nome: user.nome,
          email: user.email,
          tipo: user.tipo,
        },
        SECRET,
        { expiresIn: "8h" }
      );

      return res.json({
        id: user.id,
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        token,
      });
    }
  );
});

/* ==============================
   USUÁRIOS
============================== */

app.get("/usuarios", auth, (req, res) => {
  db.all(
    `SELECT id, nome, email, tipo, ativo FROM usuarios ORDER BY nome ASC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao buscar usuários",
          detalhe: err.message,
        });
      }

      return res.json(rows);
    }
  );
});

app.post("/usuarios", auth, permitirTipos("admin"), (req, res) => {
  const nome = normalizarTexto(req.body.nome);
  const email = normalizarTexto(req.body.email);
  const senha = normalizarTexto(req.body.senha || "123456");
  const tipo = normalizarTexto(req.body.tipo || "tecnico");
  const ativo = req.body.ativo === 0 ? 0 : 1;

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: "Nome, e-mail e senha são obrigatórios" });
  }

  db.run(
    `
    INSERT INTO usuarios(nome,email,senha,tipo,ativo)
    VALUES(?,?,?,?,?)
    `,
    [nome, email, senha, tipo, ativo],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao criar usuário",
          detalhe: err.message,
        });
      }

      return res.json({ id: this.lastID });
    }
  );
});

app.put("/usuarios/:id", auth, permitirTipos("admin"), (req, res) => {
  const id = req.params.id;
  const nome = normalizarTexto(req.body.nome);
  const email = normalizarTexto(req.body.email);
  const tipo = normalizarTexto(req.body.tipo || "tecnico");
  const ativo = req.body.ativo === 0 ? 0 : 1;

  db.run(
    `
    UPDATE usuarios
    SET nome=?,
        email=?,
        tipo=?,
        ativo=?
    WHERE id=?
    `,
    [nome, email, tipo, ativo, id],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao atualizar usuário",
          detalhe: err.message,
        });
      }

      return res.json({ ok: true, alterados: this.changes });
    }
  );
});

/* ==============================
   USINAS
============================== */

app.get("/usinas", auth, (req, res) => {
  db.all("SELECT * FROM usinas ORDER BY id DESC", (err, rows) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao buscar usinas",
        detalhe: err.message,
      });
    }

    return res.json(rows);
  });
});

app.post("/usinas", auth, (req, res) => {
  const nome = normalizarTexto(req.body.nome);
  const potencia_kwp = normalizarNumero(req.body.potencia_kwp);
  const cidade = normalizarTexto(req.body.cidade);
  const cliente = normalizarTexto(req.body.cliente);
  const ativa = req.body.ativa === 0 ? 0 : 1;

  if (!nome) {
    return res.status(400).json({ erro: "Nome da usina é obrigatório" });
  }

  db.run(
    `
    INSERT INTO usinas(nome,potencia_kwp,cidade,cliente,ativa)
    VALUES(?,?,?,?,?)
    `,
    [nome, potencia_kwp, cidade, cliente, ativa],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao criar usina",
          detalhe: err.message,
        });
      }

      return res.json({ id: this.lastID });
    }
  );
});

app.put("/usinas/:id", auth, (req, res) => {
  const id = req.params.id;
  const nome = normalizarTexto(req.body.nome);
  const potencia_kwp = normalizarNumero(req.body.potencia_kwp);
  const cidade = normalizarTexto(req.body.cidade);
  const cliente = normalizarTexto(req.body.cliente);
  const ativa = req.body.ativa === 0 ? 0 : 1;

  if (!nome) {
    return res.status(400).json({ erro: "Nome da usina é obrigatório" });
  }

  db.run(
    `
    UPDATE usinas
    SET nome=?,
        potencia_kwp=?,
        cidade=?,
        cliente=?,
        ativa=?
    WHERE id=?
    `,
    [nome, potencia_kwp, cidade, cliente, ativa, id],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao atualizar usina",
          detalhe: err.message,
        });
      }

      return res.json({ ok: true, alterados: this.changes });
    }
  );
});

/* ==============================
   TIPOS DE FALHA
============================== */

app.get("/tipos-falha", auth, (req, res) => {
  db.all(
    `SELECT * FROM tipos_falha ORDER BY nome ASC`,
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao buscar tipos de falha",
          detalhe: err.message,
        });
      }

      return res.json(rows);
    }
  );
});

app.post("/tipos-falha", auth, (req, res) => {
  const nome = normalizarTexto(req.body.nome);
  const categoria = normalizarTexto(req.body.categoria);
  const descricao = normalizarTexto(req.body.descricao);
  const prioridade_padrao = normalizarTexto(req.body.prioridade_padrao || "media");
  const ativo = req.body.ativo === 0 ? 0 : 1;

  if (!nome) {
    return res.status(400).json({ erro: "Nome do tipo de falha é obrigatório" });
  }

  db.run(
    `
    INSERT INTO tipos_falha(nome,categoria,descricao,prioridade_padrao,ativo)
    VALUES(?,?,?,?,?)
    `,
    [nome, categoria, descricao, prioridade_padrao, ativo],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao criar tipo de falha",
          detalhe: err.message,
        });
      }

      return res.json({ id: this.lastID });
    }
  );
});

app.put("/tipos-falha/:id", auth, (req, res) => {
  const id = req.params.id;
  const nome = normalizarTexto(req.body.nome);
  const categoria = normalizarTexto(req.body.categoria);
  const descricao = normalizarTexto(req.body.descricao);
  const prioridade_padrao = normalizarTexto(req.body.prioridade_padrao || "media");
  const ativo = req.body.ativo === 0 ? 0 : 1;

  if (!nome) {
    return res.status(400).json({ erro: "Nome do tipo de falha é obrigatório" });
  }

  db.run(
    `
    UPDATE tipos_falha
    SET nome=?,
        categoria=?,
        descricao=?,
        prioridade_padrao=?,
        ativo=?
    WHERE id=?
    `,
    [nome, categoria, descricao, prioridade_padrao, ativo, id],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao atualizar tipo de falha",
          detalhe: err.message,
        });
      }

      return res.json({ ok: true, alterados: this.changes });
    }
  );
});

/* ==============================
   ORDENS
============================== */

app.get("/ordens", auth, (req, res) => {
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;

  let sql = `
    SELECT 
      ordens_servico.*,
      usinas.nome as usina,
      usuarios.nome as tecnico_nome
    FROM ordens_servico
    LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
    LEFT JOIN usuarios ON usuarios.id = ordens_servico.tecnico_id
  `;

  let params = [];

  // Se for técnico, só vê as OS dele
  if (usuarioTipo === "tecnico") {
    sql += ` WHERE ordens_servico.tecnico_id = ? `;
    params.push(usuarioId);
  }

  // Se for admin, vê todas
  sql += ` ORDER BY ordens_servico.id DESC `;

  db.all(sql, params, (err, rows) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao buscar ordens",
        detalhe: err.message,
      });
    }

    return res.json(rows);
  });
});

app.get("/kanban", auth, (req, res) => {
  db.all(
    `
    SELECT 
      ordens_servico.*,
      usinas.nome as usina,
      usuarios.nome as tecnico_nome,
      tipos_falha.nome as tipo_falha_nome
    FROM ordens_servico
    LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
    LEFT JOIN usuarios ON usuarios.id = ordens_servico.tecnico_id
    LEFT JOIN tipos_falha ON tipos_falha.id = ordens_servico.tipo_falha_id
    WHERE ordens_servico.status IN ('aberta','em_execucao','para_verificacao','para_aprovacao')
    ORDER BY ordens_servico.id DESC
    `,
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao buscar kanban",
          detalhe: err.message,
        });
      }

      return res.json({
  abertas: rows.filter((r) => r.status === "aberta"),
  em_execucao: rows.filter((r) => r.status === "em_execucao"),
  para_verificacao: rows.filter((r) => r.status === "para_verificacao"),
  para_aprovacao: rows.filter((r) => r.status === "para_aprovacao"),
});
    }
  );
});

app.get("/ordens/:id", auth, (req, res) => {
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;
  const ordemId = req.params.id;

  let sql = `
    SELECT 
      ordens_servico.*,
      usinas.nome as usina,
      usuarios.nome as tecnico_nome,
      tipos_falha.nome as tipo_falha_nome
    FROM ordens_servico
    LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
    LEFT JOIN usuarios ON usuarios.id = ordens_servico.tecnico_id
    LEFT JOIN tipos_falha ON tipos_falha.id = ordens_servico.tipo_falha_id
    WHERE ordens_servico.id = ?
  `;

  let params = [ordemId];

  if (usuarioTipo === "tecnico") {
    sql += ` AND ordens_servico.tecnico_id = ? `;
    params.push(usuarioId);
  }

  db.get(sql, params, (err, row) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao buscar ordem",
        detalhe: err.message,
      });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    db.all(
      `
      SELECT * FROM fotos
      WHERE ordem_id = ?
      ORDER BY id DESC
      `,
      [ordemId],
      (errFotos, fotos) => {
        if (errFotos) {
          return res.status(500).json({
            erro: "Erro ao buscar fotos da ordem",
            detalhe: errFotos.message,
          });
        }

        db.all(
          `
          SELECT 
            h.*,
            u.nome as usuario_nome
          FROM historico_os h
          LEFT JOIN usuarios u ON u.id = h.usuario_id
          WHERE h.ordem_id = ?
          ORDER BY h.id DESC
          `,
          [ordemId],
          (errHistorico, historico) => {
            if (errHistorico) {
              return res.status(500).json({
                erro: "Erro ao buscar histórico da ordem",
                detalhe: errHistorico.message,
              });
            }

            db.all(
              `
              SELECT 
                c.*,
                u.nome as usuario_nome
              FROM comentarios_os c
              LEFT JOIN usuarios u ON u.id = c.usuario_id
              WHERE c.ordem_id = ?
              ORDER BY c.id DESC
              `,
              [ordemId],
              (errComentarios, comentarios) => {
                if (errComentarios) {
                  return res.status(500).json({
                    erro: "Erro ao buscar comentários da ordem",
                    detalhe: errComentarios.message,
                  });
                }

                return res.json({
                  ...row,
                  fotos: fotos || [],
                  historico: historico || [],
                  comentarios: comentarios || [],
                });
              }
            );
          }
        );
      }
    );
  });
});


app.post("/ordens/:id/comentarios", auth, (req, res) => {
  const ordemId = req.params.id;
  const comentario = normalizarTexto(req.body.comentario);

  if (!comentario) {
    return res.status(400).json({ erro: "Comentário é obrigatório" });
  }

  db.run(
    `
    INSERT INTO comentarios_os(ordem_id, usuario_id, comentario, data)
    VALUES(?,?,?,datetime('now','localtime'))
    `,
    [ordemId, req.user.id, comentario],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao salvar comentário",
          detalhe: err.message,
        });
      }

      return res.json({ ok: true, id: this.lastID });
    }
  );
});

app.post("/ordens", auth, (req, res) => {
  const usina_id = req.body.usina_id || null;
  const tecnico_id = req.body.tecnico_id || null;
  const tipo = normalizarTexto(req.body.tipo);
  const tipo_falha_id = req.body.tipo_falha_id || null;
  const descricao = normalizarTexto(req.body.descricao);
  const prioridade = normalizarTexto(req.body.prioridade || "media");
  const solicitante = normalizarTexto(req.body.solicitante);
  const local = normalizarTexto(req.body.local);
  const equipamento = normalizarTexto(req.body.equipamento);
  const status = normalizarTexto(req.body.status || "aberta");

  if (!descricao) {
    return res.status(400).json({ erro: "Descrição da OS é obrigatória" });
  }

  db.run(
  `
  INSERT INTO ordens_servico(
    usina_id,
    tecnico_id,
    tipo,
    tipo_falha_id,
    descricao,
    status,
    prioridade,
    solicitante,
    local,
    equipamento,
    data_abertura,
    data_programacao,
    programado_por
  )
  VALUES(
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    datetime('now','localtime'),
    NULL,
    ?
  )
  `,
  [
    usina_id,
    tecnico_id,
    tipo,
    tipo_falha_id,
    descricao,
    status,
    prioridade,
    solicitante,
    local,
    equipamento,
    req.user.id,
  ],
  function (err) {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao criar OS",
        detalhe: err.message,
      });
    }

    registrarHistorico(this.lastID, "", status, req.user.id, "OS criada");
    return res.json({ id: this.lastID });
  }
);
});

app.put("/ordens/:id", auth, (req, res) => {
  const id = req.params.id;
  const usina_id = req.body.usina_id || null;
  const tecnico_id = req.body.tecnico_id || null;
  const tipo = normalizarTexto(req.body.tipo);
  const tipo_falha_id = req.body.tipo_falha_id || null;
  const descricao = normalizarTexto(req.body.descricao);
  const prioridade = normalizarTexto(req.body.prioridade || "media");
  const solicitante = normalizarTexto(req.body.solicitante);
  const local = normalizarTexto(req.body.local);
  const equipamento = normalizarTexto(req.body.equipamento);
  const observacoes = normalizarTexto(req.body.observacoes);

  db.run(
    `
    UPDATE ordens_servico
    SET usina_id=?,
        tecnico_id=?,
        tipo=?,
        tipo_falha_id=?,
        descricao=?,
        prioridade=?,
        solicitante=?,
        local=?,
        equipamento=?,
        observacoes=?
    WHERE id=?
    `,
    [
      usina_id,
      tecnico_id,
      tipo,
      tipo_falha_id,
      descricao,
      prioridade,
      solicitante,
      local,
      equipamento,
      observacoes,
      id,
    ],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao atualizar OS",
          detalhe: err.message,
        });
      }

      return res.json({ ok: true, alterados: this.changes });
    }
  );
});

/* ==============================
   FLUXO DA OS
============================== */

app.put("/ordens/:id/programar", auth, (req, res) => {
  const id = req.params.id;
  const tecnico_id = req.body.tecnico_id || null;
  const prioridade = normalizarTexto(req.body.prioridade || "media");
  const observacao = normalizarTexto(req.body.observacao || "OS programada");

  db.get(`SELECT status FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ erro: "Erro ao buscar OS", detalhe: err.message });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    const statusAnterior = row.status || "";

    db.run(
      `
      UPDATE ordens_servico
      SET status='aberta',
          tecnico_id=COALESCE(?, tecnico_id),
          prioridade=?,
          data_programacao=datetime('now','localtime'),
          programado_por=?
      WHERE id=?
      `,
      [tecnico_id, prioridade, req.user.id, id],
      function (errUpdate) {
        if (errUpdate) {
          return res.status(500).json({
            erro: "Erro ao programar OS",
            detalhe: errUpdate.message,
          });
        }

        registrarHistorico(id, statusAnterior, "aberta", req.user.id, observacao);
        return res.json({ ok: true });
      }
    );
  });
});

app.put("/ordens/:id/start", auth, (req, res) => {
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;
  const id = req.params.id;

  let sql = `
    UPDATE ordens_servico
    SET status = ?,
        data_inicio = datetime('now','localtime')
    WHERE id = ?
  `;

  let params = ["em_execucao", id];

  if (usuarioTipo === "tecnico") {
    sql += ` AND tecnico_id = ? `;
    params.push(usuarioId);
  }

  db.run(sql, params, function (err) {
    if (err) {
      console.error("Erro ao iniciar OS:", err.message);
      return res.status(500).json({
        erro: "Erro ao iniciar OS",
        detalhe: err.message,
      });
    }

    if (this.changes === 0) {
      return res.status(403).json({
        erro: "Você não tem permissão para iniciar esta OS",
      });
    }

    return res.json({ ok: true });
  });
});

app.put("/ordens/:id/concluir", auth, (req, res) => {
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;
  const id = req.params.id;
  const observacoes = normalizarTexto(req.body.observacoes);

  let sql = `
    UPDATE ordens_servico
    SET status='concluida',
        data_fim=datetime('now','localtime'),
        observacoes=?
    WHERE id=?
  `;

  let params = [observacoes, id];

  if (usuarioTipo === "tecnico") {
    sql += ` AND tecnico_id = ? `;
    params.push(usuarioId);
  }

  db.run(sql, params, function (err) {
    if (err) {
      console.error("Erro ao concluir OS:", err.message);
      return res.status(500).json({
        erro: "Erro ao concluir OS",
        detalhe: err.message,
      });
    }

    if (this.changes === 0) {
      return res.status(403).json({
        erro: "Você não tem permissão para concluir esta OS",
      });
    }

    res.json({
      ok: true,
      mensagem: "OS finalizada com sucesso",
    });
  });
});

app.put("/ordens/:id/verificar", auth, permitirTipos("admin", "verificador"), (req, res) => {
  const id = req.params.id;
  const parecer = normalizarTexto(req.body.parecer);
  const aprovado = Boolean(req.body.aprovado);
  const statusDestino = aprovado ? "para_aprovacao" : "em_execucao";
  const motivo = aprovado ? "OS verificada e enviada para aprovação" : "OS devolvida para correção";

  db.get(`SELECT status FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao buscar OS",
        detalhe: err.message,
      });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    const statusAnterior = row.status || "";

    db.run(
      `
      UPDATE ordens_servico
      SET status=?,
          verificador_id=?,
          data_verificacao=datetime('now','localtime'),
          parecer_verificacao=?
      WHERE id=?
      `,
      [statusDestino, req.user.id, parecer, id],
      function (errUpdate) {
        if (errUpdate) {
          return res.status(500).json({
            erro: "Erro ao verificar OS",
            detalhe: errUpdate.message,
          });
        }

        registrarHistorico(id, statusAnterior, statusDestino, req.user.id, motivo);
        return res.json({ ok: true, status: statusDestino });
      }
    );
  });
});

app.put("/ordens/:id/aprovar", auth, permitirTipos("admin", "aprovador"), (req, res) => {
  const id = req.params.id;
  const parecer = normalizarTexto(req.body.parecer);
  const aprovado = Boolean(req.body.aprovado);
  const statusDestino = aprovado ? "concluida" : "reprovada";
  const motivo = aprovado ? "OS aprovada e concluída" : "OS reprovada";

  db.get(`SELECT status FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao buscar OS",
        detalhe: err.message,
      });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    const statusAnterior = row.status || "";

    db.run(
      `
      UPDATE ordens_servico
      SET status=?,
          aprovador_id=?,
          data_aprovacao=datetime('now','localtime'),
          parecer_aprovacao=?,
          motivo_reprovacao=CASE WHEN ? = 'reprovada' THEN ? ELSE NULL END
      WHERE id=?
      `,
      [statusDestino, req.user.id, parecer, statusDestino, parecer, id],
      function (errUpdate) {
        if (errUpdate) {
          return res.status(500).json({
            erro: "Erro ao aprovar OS",
            detalhe: errUpdate.message,
          });
        }

        registrarHistorico(id, statusAnterior, statusDestino, req.user.id, motivo);

        if (statusDestino === "concluida") {
          gerarRelatorio(id);
        }

        return res.json({ ok: true, status: statusDestino });
      }
    );
  });
});

app.put("/ordens/:id/cancelar", auth, permitirTipos("admin"), (req, res) => {
  const id = req.params.id;
  const observacao = normalizarTexto(req.body.observacao || "OS cancelada");

  db.get(`SELECT status FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ erro: "Erro ao buscar OS", detalhe: err.message });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    const statusAnterior = row.status || "";

    db.run(
      `
      UPDATE ordens_servico
      SET status='cancelada'
      WHERE id=?
      `,
      [id],
      function (errUpdate) {
        if (errUpdate) {
          return res.status(500).json({
            erro: "Erro ao cancelar OS",
            detalhe: errUpdate.message,
          });
        }

        registrarHistorico(id, statusAnterior, "cancelada", req.user.id, observacao);
        return res.json({ ok: true });
      }
    );
  });
});

/* ==============================
   UPLOAD FOTO
============================== */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads");
  },

  filename: (req, file, cb) => {
    cb(null, gerarNomeArquivoSeguro(file.originalname));
  },
});

const upload = multer({ storage });

app.post("/upload/:ordem/:tipo", auth, upload.single("foto"), (req, res) => {
  const ordem = req.params.ordem;
  const tipo = normalizarTexto(req.params.tipo);

  if (!req.file) {
    return res.status(400).json({ erro: "Arquivo não enviado" });
  }

  db.run(
    `
    INSERT INTO fotos(ordem_id,tipo,caminho,data)
    VALUES(?,?,?,datetime('now','localtime'))
    `,
    [ordem, tipo, req.file.filename],
    function (err) {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao salvar foto",
          detalhe: err.message,
        });
      }

      return res.json({
        arquivo: req.file.filename,
        url: `/uploads/${req.file.filename}`,
      });
    }
  );
});

/* ==============================
   DASHBOARD
============================== */

app.get("/dashboard", auth, (req, res) => {
  const resposta = {
    cards: {},
    por_status: [],
    por_usina: [],
    por_tipo_falha: [],
    prioridades: [],
    tempos_medios_horas: {},
  };

  db.get(
    `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'aberta' THEN 1 ELSE 0 END) as abertas,
      SUM(CASE WHEN status = 'em_execucao' THEN 1 ELSE 0 END) as em_execucao,
      SUM(CASE WHEN status = 'para_verificacao' THEN 1 ELSE 0 END) as para_verificacao,
      SUM(CASE WHEN status = 'para_aprovacao' THEN 1 ELSE 0 END) as para_aprovacao,
      SUM(CASE WHEN status = 'concluida' THEN 1 ELSE 0 END) as concluidas,
      SUM(CASE WHEN status = 'reprovada' THEN 1 ELSE 0 END) as reprovadas,
      SUM(CASE WHEN status = 'cancelada' THEN 1 ELSE 0 END) as canceladas
    FROM ordens_servico
    `,
    (errCards, cards) => {
      if (errCards) {
        return res.status(500).json({
          erro: "Erro ao gerar dashboard",
          detalhe: errCards.message,
        });
      }

      resposta.cards = cards || {};

      db.all(
        `
        SELECT status, COUNT(*) as total
        FROM ordens_servico
        GROUP BY status
        ORDER BY total DESC
        `,
        (errStatus, porStatus) => {
          if (errStatus) {
            return res.status(500).json({
              erro: "Erro ao gerar dashboard",
              detalhe: errStatus.message,
            });
          }

          resposta.por_status = porStatus || [];

          db.all(
            `
            SELECT 
              COALESCE(usinas.nome, 'Sem usina') as usina,
              COUNT(*) as total
            FROM ordens_servico
            LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
            GROUP BY ordens_servico.usina_id
            ORDER BY total DESC
            `,
            (errUsina, porUsina) => {
              if (errUsina) {
                return res.status(500).json({
                  erro: "Erro ao gerar dashboard",
                  detalhe: errUsina.message,
                });
              }

              resposta.por_usina = porUsina || [];

              db.all(
                `
                SELECT 
                  COALESCE(tipos_falha.nome, COALESCE(ordens_servico.tipo, 'Sem tipo')) as tipo_falha,
                  COUNT(*) as total
                FROM ordens_servico
                LEFT JOIN tipos_falha ON tipos_falha.id = ordens_servico.tipo_falha_id
                GROUP BY COALESCE(tipos_falha.nome, COALESCE(ordens_servico.tipo, 'Sem tipo'))
                ORDER BY total DESC
                `,
                (errFalha, porTipoFalha) => {
                  if (errFalha) {
                    return res.status(500).json({
                      erro: "Erro ao gerar dashboard",
                      detalhe: errFalha.message,
                    });
                  }

                  resposta.por_tipo_falha = porTipoFalha || [];

                  db.all(
                    `
                    SELECT prioridade, COUNT(*) as total
                    FROM ordens_servico
                    GROUP BY prioridade
                    ORDER BY total DESC
                    `,
                    (errPrioridade, prioridades) => {
                      if (errPrioridade) {
                        return res.status(500).json({
                          erro: "Erro ao gerar dashboard",
                          detalhe: errPrioridade.message,
                        });
                      }

                      resposta.prioridades = prioridades || [];

                      db.get(
                        `
                        SELECT
                          ROUND(AVG(
                            CASE 
                              WHEN data_programacao IS NOT NULL AND data_abertura IS NOT NULL
                              THEN (julianday(data_programacao) - julianday(data_abertura)) * 24
                            END
                          ), 2) as tempo_ate_programacao,
                          ROUND(AVG(
                            CASE 
                              WHEN data_inicio IS NOT NULL AND data_programacao IS NOT NULL
                              THEN (julianday(data_inicio) - julianday(data_programacao)) * 24
                            END
                          ), 2) as tempo_ate_inicio,
                          ROUND(AVG(
                            CASE 
                              WHEN data_fim IS NOT NULL AND data_inicio IS NOT NULL
                              THEN (julianday(data_fim) - julianday(data_inicio)) * 24
                            END
                          ), 2) as tempo_em_execucao,
                          ROUND(AVG(
                            CASE 
                              WHEN data_verificacao IS NOT NULL AND data_envio_verificacao IS NOT NULL
                              THEN (julianday(data_verificacao) - julianday(data_envio_verificacao)) * 24
                            END
                          ), 2) as tempo_em_verificacao,
                          ROUND(AVG(
                            CASE 
                              WHEN data_aprovacao IS NOT NULL AND data_verificacao IS NOT NULL
                              THEN (julianday(data_aprovacao) - julianday(data_verificacao)) * 24
                            END
                          ), 2) as tempo_em_aprovacao,
                          ROUND(AVG(
                            CASE 
                              WHEN data_aprovacao IS NOT NULL AND data_abertura IS NOT NULL
                              THEN (julianday(data_aprovacao) - julianday(data_abertura)) * 24
                            END
                          ), 2) as tempo_total
                        FROM ordens_servico
                        `,
                        (errTempos, tempos) => {
                          if (errTempos) {
                            return res.status(500).json({
                              erro: "Erro ao gerar dashboard",
                              detalhe: errTempos.message,
                            });
                          }

                          resposta.tempos_medios_horas = tempos || {};
                          return res.json(resposta);
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

/* ==============================
   GERAR PDF
============================== */

function formatarDataBR(dataTexto) {
  if (!dataTexto) return "-";
  const d = new Date(dataTexto);
  if (Number.isNaN(d.getTime())) return dataTexto;
  return d.toLocaleDateString("pt-BR");
}

function valorSimNao(condicao) {
  return condicao ? "X" : "";
}

function safeText(valor) {
  return normalizarTexto(valor || "-");
}

function desenharCaixa(doc, x, y, w, h, titulo, valor) {
  doc.rect(x, y, w, h).stroke();
  doc.font("Helvetica-Bold").fontSize(8).text(titulo, x + 4, y + 4, {
    width: w - 8,
    align: "center",
  });
  doc.font("Helvetica").fontSize(9).text(valor, x + 4, y + 18, {
    width: w - 8,
    align: "center",
  });
}

function gerarRelatorio(id) {
  db.get(
    `
    SELECT 
      ordens_servico.*,
      usinas.nome as usina,
      usinas.cidade as usina_cidade,
      usuarios.nome as tecnico_nome,
      tipos_falha.nome as tipo_falha_nome
    FROM ordens_servico
    LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
    LEFT JOIN usuarios ON usuarios.id = ordens_servico.tecnico_id
    LEFT JOIN tipos_falha ON tipos_falha.id = ordens_servico.tipo_falha_id
    WHERE ordens_servico.id=?
    `,
    [id],
    (err, os) => {
      if (err || !os) return;

      db.all(
        `
        SELECT * FROM fotos
        WHERE ordem_id = ?
        ORDER BY id ASC
        `,
        [id],
        (errFotos, fotos) => {
          if (errFotos) return;

          const arquivo = path.join("uploads", `relatorio_os_${id}.pdf`);
          const stream = fs.createWriteStream(arquivo);
          const doc = new PDFDocument({ size: "A4", margin: 30 });

          doc.pipe(stream);

          /* =========================
             PÁGINA 1
          ========================= */

          // Moldura topo
          doc.rect(30, 30, 535, 58).stroke();

          // Coluna esquerda logo/nome
          doc.rect(30, 30, 150, 58).stroke();
          doc.font("Helvetica-Bold").fontSize(16).text("ILUMISOL", 55, 48);

          // Coluna central título
          doc.rect(180, 30, 170, 58).stroke();
          doc.font("Helvetica-Bold").fontSize(13).text("ORDEM DE SERVIÇO", 203, 46);
          doc.font("Helvetica-Bold").fontSize(10).text("RELATÓRIO DE ATIVIDADES EXECUTADAS", 188, 62);

          // Coluna direita
          desenharCaixa(doc, 350, 30, 107, 29, "N°", `OS ${os.id}`);
          desenharCaixa(doc, 457, 30, 108, 29, "DATA", formatarDataBR(os.data_abertura));
          desenharCaixa(doc, 350, 59, 107, 29, "PROJETO", safeText(os.usina));
          desenharCaixa(doc, 457, 59, 108, 29, "LOCAL", safeText(os.usina_cidade || os.local));

          // Barra amarela
          doc.rect(30, 96, 535, 15).fillAndStroke("#f4b400", "#000000");
          doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9).text(
            "ORDEM DE SERVIÇO",
            0,
            100,
            { width: 595, align: "center" }
          );

          let y = 122;

          doc.font("Helvetica-Bold").fontSize(10).text("OCORRÊNCIA DA ATIVIDADE", 35, y);
          y += 16;

          doc.font("Helvetica").fontSize(10).text(
            safeText(os.descricao),
            35,
            y,
            { width: 520, align: "justify" }
          );

          y += 70;

          doc.font("Helvetica-Bold").fontSize(10).text("DESCRIÇÃO DA ATIVIDADE", 35, y);
          y += 16;

          doc.font("Helvetica").fontSize(10).text(
            safeText(os.observacoes),
            35,
            y,
            { width: 520, align: "justify" }
          );

          y += 75;

          doc.font("Helvetica-Bold").fontSize(10).text("RESPONSÁVEIS", 35, y);
          y += 18;

          doc.rect(35, y, 170, 36).stroke();
          doc.rect(205, y, 170, 36).stroke();
          doc.rect(375, y, 170, 36).stroke();

          doc.font("Helvetica-Bold").fontSize(8).text("Responsável Realização", 40, y + 5);
          doc.font("Helvetica").fontSize(10).text(safeText(os.tecnico_nome), 40, y + 18);

          doc.font("Helvetica-Bold").fontSize(8).text("Responsável Validação", 210, y + 5);
          doc.font("Helvetica").fontSize(10).text(safeText(os.verificador_id ? `ID ${os.verificador_id}` : "-"), 210, y + 18);

          doc.font("Helvetica-Bold").fontSize(8).text("Responsável Aceite", 380, y + 5);
          doc.font("Helvetica").fontSize(10).text(safeText(os.aprovador_id ? `ID ${os.aprovador_id}` : "-"), 380, y + 18);

          y += 55;

          doc.font("Helvetica-Bold").fontSize(10).text("CLASSIFICAÇÃO", 35, y);
          y += 18;

          doc.rect(35, y, 170, 50).stroke();
          doc.rect(205, y, 170, 50).stroke();
          doc.rect(375, y, 170, 50).stroke();

          doc.font("Helvetica-Bold").fontSize(8).text("CRITICIDADE", 40, y + 5);
          doc.font("Helvetica").fontSize(10).text(safeText(os.prioridade), 40, y + 22);

          doc.font("Helvetica-Bold").fontSize(8).text("TIPO DE ORDEM DE SERVIÇO", 210, y + 5);
          doc.font("Helvetica").fontSize(9).text(`Programada: ${valorSimNao(os.status === "aberta")}`, 210, y + 20);
          doc.text(`Não programada: ${valorSimNao(os.status !== "aberta")}`, 210, y + 33);

          doc.font("Helvetica-Bold").fontSize(8).text("DATAS", 380, y + 5);
          doc.font("Helvetica").fontSize(9).text(`Início: ${safeText(formatarDataBR(os.data_inicio))}`, 380, y + 20);
          doc.text(`Fim: ${safeText(formatarDataBR(os.data_fim))}`, 380, y + 33);

          y += 68;

          doc.font("Helvetica-Bold").fontSize(10).text("DADOS COMPLEMENTARES", 35, y);
          y += 16;

          doc.font("Helvetica").fontSize(10).text(`Tipo de trabalho: ${safeText(os.tipo_falha_nome || os.tipo)}`, 35, y);
          y += 14;
          doc.text(`Solicitante: ${safeText(os.solicitante)}`, 35, y);
          y += 14;
          doc.text(`Local: ${safeText(os.local)}`, 35, y);
          y += 14;
          doc.text(`Equipamento: ${safeText(os.equipamento)}`, 35, y);

          doc.font("Helvetica").fontSize(8).text(
            `GERADO POR: ${safeText(os.tecnico_nome)}`,
            35,
            780
          );
          doc.text(`OS_${id}`, 250, 780);
          doc.text(`1 / 2`, 530, 780);

          /* =========================
             PÁGINA 2
          ========================= */

          doc.addPage({ size: "A4", margin: 30 });

          doc.rect(30, 30, 535, 58).stroke();
          doc.rect(30, 30, 150, 58).stroke();
          doc.rect(180, 30, 170, 58).stroke();
          desenharCaixa(doc, 350, 30, 107, 29, "N°", `OS ${os.id}`);
          desenharCaixa(doc, 457, 30, 108, 29, "DATA", formatarDataBR(os.data_abertura));
          desenharCaixa(doc, 350, 59, 107, 29, "PROJETO", safeText(os.usina));
          desenharCaixa(doc, 457, 59, 108, 29, "LOCAL", safeText(os.usina_cidade || os.local));

          doc.font("Helvetica-Bold").fontSize(16).text("ILUMISOL", 55, 48);
          doc.font("Helvetica-Bold").fontSize(13).text("ORDEM DE SERVIÇO", 203, 46);
          doc.font("Helvetica-Bold").fontSize(10).text("RELATÓRIO DE ATIVIDADES EXECUTADAS", 188, 62);

          doc.rect(30, 96, 535, 15).fillAndStroke("#f4b400", "#000000");
          doc.fillColor("#000000").font("Helvetica-Bold").fontSize(9).text(
            "REGISTRO FOTOGRÁFICO",
            0,
            100,
            { width: 595, align: "center" }
          );

          const caixas = [
            { x: 30, y: 120, w: 262, h: 250, titulo: "FOTO 1" },
            { x: 303, y: 120, w: 262, h: 250, titulo: "FOTO 2" },
            { x: 30, y: 381, w: 262, h: 250, titulo: "FOTO 3" },
            { x: 303, y: 381, w: 262, h: 250, titulo: "FOTO 4" },
          ];

          caixas.forEach((caixa, index) => {
            doc.rect(caixa.x, caixa.y, caixa.w, caixa.h).stroke();

            const foto = fotos[index];
            if (foto) {
              const caminhoImagem = path.join("uploads", foto.caminho);
              if (fs.existsSync(caminhoImagem)) {
                try {
                  doc.image(caminhoImagem, caixa.x + 8, caixa.y + 8, {
                    fit: [caixa.w - 16, caixa.h - 35],
                    align: "center",
                    valign: "center",
                  });
                } catch (e) {
                  doc.font("Helvetica").fontSize(9).text("Erro ao carregar imagem", caixa.x + 10, caixa.y + 100);
                }
              }
            }

            doc.font("Helvetica-Bold").fontSize(9).text(
              caixa.titulo,
              caixa.x,
              caixa.y + caixa.h - 18,
              { width: caixa.w, align: "center" }
            );
          });

          doc.font("Helvetica").fontSize(8).text("FORM-138 REV00", 30, 780);
          doc.text(`OS_${id}`, 250, 780);
          doc.text(`2 / 2`, 530, 780);

          doc.end();

          stream.on("finish", () => {
            db.run(`DELETE FROM relatorios WHERE ordem_id=?`, [id], () => {
              db.run(
                `
                INSERT INTO relatorios(ordem_id,arquivo,data)
                VALUES(?,?,datetime('now','localtime'))
                `,
                [id, arquivo]
              );
            });
          });
        }
      );
    }
  );
}

/* ==============================
   RELATÓRIO
============================== */

app.post("/relatorio/:id/gerar", auth, (req, res) => {
  const id = req.params.id;

  db.get(`SELECT id FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao gerar relatório",
        detalhe: err.message,
      });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    gerarRelatorio(id);

    return res.json({
      ok: true,
      mensagem: "Relatório solicitado com sucesso",
    });
  });
});

app.get("/relatorio/:id", auth, (req, res) => {
  db.get(
    `
    SELECT * FROM relatorios
    WHERE ordem_id=?
    ORDER BY id DESC
    LIMIT 1
    `,
    [req.params.id],
    (err, row) => {
      if (err) {
        return res.status(500).json({
          erro: "Erro ao buscar relatório",
          detalhe: err.message,
        });
      }

      if (!row) {
        return res.status(404).json({ erro: "Relatório não encontrado" });
      }

      return res.sendFile(path.resolve(row.arquivo));
    }
  );
});

/* ==============================
   SERVER
============================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API rodando na porta ${PORT}`);
});

app.delete("/usinas/:id", auth, (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM usinas WHERE id=?`, [id], function (err) {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao excluir usina",
        detalhe: err.message,
      });
    }

    return res.json({ ok: true, removidos: this.changes });
  });
});



app.delete("/tipos-falha/:id", auth, (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM tipos_falha WHERE id=?`, [id], function (err) {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao excluir tipo de falha",
        detalhe: err.message,
      });
    }

    return res.json({ ok: true, removidos: this.changes });
  });
});

app.delete("/tipos-falha/:id", auth, (req, res) => {
  const id = req.params.id;

  db.run(`DELETE FROM tipos_falha WHERE id=?`, [id], function (err) {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao excluir tipo de falha",
        detalhe: err.message,
      });
    }

    return res.json({ ok: true, removidos: this.changes });
  });
});

app.get("/ordens/:id/fotos", auth, (req, res) => {
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;
  const ordemId = req.params.id;

  let sqlPermissao = `
    SELECT id
    FROM ordens_servico
    WHERE id = ?
  `;

  let paramsPermissao = [ordemId];

  if (usuarioTipo === "tecnico") {
    sqlPermissao += ` AND tecnico_id = ? `;
    paramsPermissao.push(usuarioId);
  }

  db.get(sqlPermissao, paramsPermissao, (err, ordem) => {
    if (err) {
      return res.status(500).json({
        erro: "Erro ao verificar ordem",
        detalhe: err.message,
      });
    }

    if (!ordem) {
      return res.status(404).json({
        erro: "OS não encontrada",
      });
    }

    db.all(
      `
      SELECT *
      FROM fotos
      WHERE ordem_id = ?
      ORDER BY id DESC
      `,
      [ordemId],
      (errFotos, rows) => {
        if (errFotos) {
          return res.status(500).json({
            erro: "Erro ao buscar fotos",
            detalhe: errFotos.message,
          });
        }

        return res.json(rows);
      }
    );
  });
});

app.delete("/fotos/:id", auth, (req, res) => {

  const usuarioId = req.user.id
  const usuarioTipo = req.user.tipo
  const fotoId = req.params.id

  db.get(`
    SELECT fotos.*, ordens_servico.tecnico_id
    FROM fotos
    JOIN ordens_servico ON ordens_servico.id = fotos.ordem_id
    WHERE fotos.id = ?
  `,[fotoId],(err,foto)=>{

    if(err){
      return res.status(500).json({erro:"Erro ao buscar foto"})
    }

    if(!foto){
      return res.status(404).json({erro:"Foto não encontrada"})
    }

    if(usuarioTipo === "tecnico" && foto.tecnico_id !== usuarioId){
      return res.status(403).json({erro:"Sem permissão"})
    }

    const caminho = "uploads/" + foto.caminho

    db.run(`DELETE FROM fotos WHERE id=?`,[fotoId],function(err){

      if(err){
        return res.status(500).json({erro:"Erro ao apagar foto"})
      }

      if(fs.existsSync(caminho)){
        fs.unlinkSync(caminho)
      }

      res.json({ok:true})

    })

  })

})