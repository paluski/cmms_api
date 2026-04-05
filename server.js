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

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({
  limit: "20mb",
  type: "application/json",
}));

app.use(express.urlencoded({
  extended: true,
  limit: "20mb",
}));

app.use((req, res, next) => {
  if (
    !req.path.startsWith("/relatorio") &&
    !req.path.startsWith("/uploads")
  ) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
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

function normalizarBoolean(valor, padrao = false) {
  if (valor === null || valor === undefined || valor === "") return padrao;
  if (typeof valor === "boolean") return valor;
  if (typeof valor === "number") return valor === 1;
  const texto = String(valor).trim().toLowerCase();
  return ["true", "1", "sim", "yes"].includes(texto);
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

function formatarDataBR(dataTexto) {
  if (!dataTexto) return "-";
  const d = new Date(dataTexto);
  if (Number.isNaN(d.getTime())) return dataTexto;
  return d.toLocaleDateString("pt-BR");
}

function formatarDataHoraBR(dataTexto) {
  if (!dataTexto) return "-";
  const d = new Date(dataTexto);
  if (Number.isNaN(d.getTime())) return dataTexto;
  return d.toLocaleString("pt-BR");
}

function valorSimNao(condicao) {
  return condicao ? "X" : "";
}

function safeText(valor) {
  return normalizarTexto(valor || "-");
}

function textoSeguro(valor) {
  return normalizarTexto(valor || "-");
}

function txt(v) {
  return normalizarTexto(v || "-");
}

function prioridadeParaCriticidade(prioridade) {
  const p = String(prioridade || "").toLowerCase();
  if (p === "baixa") return "leve";
  if (p === "media") return "moderada";
  if (p === "alta" || p === "critica") return "grave";
  return "";
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

function marcar(doc, x, y, marcado) {
  doc.rect(x, y, 10, 10).stroke();
  if (marcado) {
    doc.font("Helvetica-Bold").fontSize(10).text("X", x + 1.8, y - 0.5);
  }
}

function caixa(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function textoCentro(doc, texto, x, y, w, size = 9, bold = false) {
  doc.font(bold ? "Helvetica-Bold" : "Helvetica")
    .fontSize(size)
    .text(texto, x, y, { width: w, align: "center" });
}

function drawBox(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function drawLabelValue(doc, x, y, w, h, label, value, opts = {}) {
  drawBox(doc, x, y, w, h);

  const labelSize = opts.labelSize || 8;
  const valueSize = opts.valueSize || 9;
  const align = opts.align || "left";

  doc.font("Helvetica-Bold")
    .fontSize(labelSize)
    .text(label, x + 4, y + 4, { width: w - 8, align });

  doc.font("Helvetica")
    .fontSize(valueSize)
    .text(value, x + 4, y + 18, { width: w - 8, align });
}

function drawSectionTitle(doc, y, title) {
  doc.save();
  doc.rect(20, y, 555, 16).fillAndStroke("#f4b400", "#000000");
  doc.fillColor("#000000")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(title, 20, y + 4, { width: 555, align: "center" });
  doc.restore();
}

function drawWrappedField(doc, y, title, content, minHeight = 70) {
  const x = 20;
  const w = 555;
  const innerX = x + 6;
  const innerW = w - 12;

  const linhasTitulo = String(title || "").split("\n").filter(Boolean);
  const alturaTitulo = Math.max(18, linhasTitulo.length * 12 + 8);

  const textHeight = doc.heightOfString(content || "-", {
    width: innerW,
    align: "justify",
  });

  const h = Math.max(minHeight, alturaTitulo + textHeight + 18);

  drawBox(doc, x, y, w, h);

  let yTitulo = y + 5;
  linhasTitulo.forEach((linha) => {
    doc.font("Helvetica-Bold")
      .fontSize(9)
      .text(linha, innerX, yTitulo, { width: innerW });
    yTitulo += 12;
  });

  const yConteudo = y + alturaTitulo + 4;

  doc.font("Helvetica")
    .fontSize(9)
    .text(content || "-", innerX, yConteudo, {
      width: innerW,
      align: "justify",
    });

  return y + h + 8;
}

function drawSimpleTableHeader(doc, y) {
  const cols = [
    { x: 24, w: 36, t: "ATIV." },
    { x: 60, w: 50, t: "QTD" },
    { x: 110, w: 220, t: "DESCRIÇÃO" },
    { x: 330, w: 120, t: "RESPONSÁVEL" },
    { x: 450, w: 121, t: "REFERÊNCIA" },
  ];

  cols.forEach((c) => {
    drawBox(doc, c.x, y, c.w, 18);
    doc.font("Helvetica-Bold")
      .fontSize(8)
      .text(c.t, c.x, y + 5, { width: c.w, align: "center" });
  });

  return y + 18;
}

function drawSimpleTableRow(doc, y, row) {
  const cols = [
    { x: 24, w: 36, v: row.ativ || "" },
    { x: 60, w: 50, v: row.qtd || "" },
    { x: 110, w: 220, v: row.descricao || "" },
    { x: 330, w: 120, v: row.responsavel || "" },
    { x: 450, w: 121, v: row.referencia || "" },
  ];

  const heights = cols.map((c) =>
    Math.max(
      18,
      doc.heightOfString(c.v || "-", {
        width: c.w - 8,
        align: "center",
      }) + 8
    )
  );

  const h = Math.max(...heights);

  cols.forEach((c) => {
    drawBox(doc, c.x, y, c.w, h);
    doc.font("Helvetica")
      .fontSize(8)
      .text(c.v || "-", c.x + 4, y + 5, {
        width: c.w - 8,
        align: "center",
      });
  });

  return y + h;
}

function drawCheckboxLine(doc, x, y, label, checked) {
  doc.rect(x, y, 10, 10).stroke();
  if (checked) {
    doc.font("Helvetica-Bold").fontSize(10).text("X", x + 1.5, y - 0.5);
  }
  doc.font("Helvetica").fontSize(8.5).text(label, x + 16, y - 1);
}

function drawPhotoFrame(doc, x, y, w, h, title, foto) {
  doc.rect(x, y, w, h).stroke();

  doc.font("Helvetica-Bold")
    .fontSize(9)
    .text(title, x, y + 4, { width: w, align: "center" });

  if (!foto || !foto.caminho) {
    doc.font("Helvetica")
      .fontSize(9)
      .text("Sem imagem", x, y + h / 2 - 5, {
        width: w,
        align: "center",
      });
    return;
  }

  const caminhoImagem = path.join(__dirname, "uploads", foto.caminho);

  console.log("Tentando carregar:", caminhoImagem);

  if (!fs.existsSync(caminhoImagem)) {
    console.error("Imagem NÃO encontrada:", caminhoImagem);

    doc.font("Helvetica")
      .fontSize(8)
      .text(`Imagem não encontrada:\n${foto.caminho}`, x + 8, y + h / 2 - 12, {
        width: w - 16,
        align: "center",
      });

    return;
  }

  try {
    doc.image(caminhoImagem, x + 8, y + 20, {
      fit: [w - 16, h - 30],
      align: "center",
      valign: "center",
    });
  } catch (e) {
    console.error("Erro ao renderizar imagem:", e.message);

    doc.font("Helvetica")
      .fontSize(8)
      .text("Erro ao carregar imagem", x, y + h / 2 - 5, {
        width: w,
        align: "center",
      });
  }
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
  const ativo = normalizarBoolean(req.body.ativo, true) ? 1 : 0;

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
  const ativo = normalizarBoolean(req.body.ativo, true) ? 1 : 0;

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
  const ativa = normalizarBoolean(req.body.ativa, true) ? 1 : 0;

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
  const ativa = normalizarBoolean(req.body.ativa, true) ? 1 : 0;

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
  const ativo = normalizarBoolean(req.body.ativo, true) ? 1 : 0;

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
  const ativo = normalizarBoolean(req.body.ativo, true) ? 1 : 0;

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

  if (usuarioTipo === "tecnico") {
    sql += ` WHERE ordens_servico.tecnico_id = ? `;
    params.push(usuarioId);
  }

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

    return res.json({
      ok: true,
      mensagem: "OS finalizada com sucesso",
    });
  });
});

app.put("/ordens/:id/verificar", auth, permitirTipos("admin", "verificador"), (req, res) => {
  const id = req.params.id;
  const parecer = normalizarTexto(req.body.parecer);
  const aprovado = normalizarBoolean(req.body.aprovado, false);
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
  const aprovado = normalizarBoolean(req.body.aprovado, false);
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

function formatarDataHoraBR(dataTexto) {
  if (!dataTexto) return "-";
  const d = new Date(dataTexto);
  if (Number.isNaN(d.getTime())) return dataTexto;
  return d.toLocaleString("pt-BR");
}

function txt(v) {
  return normalizarTexto(v || "-");
}

function drawBox(doc, x, y, w, h) {
  doc.rect(x, y, w, h).stroke();
}

function drawLabelValue(doc, x, y, w, h, label, value, opts = {}) {
  drawBox(doc, x, y, w, h);

  const labelSize = opts.labelSize || 8;
  const valueSize = opts.valueSize || 9;
  const align = opts.align || "left";

  doc.font("Helvetica-Bold")
    .fontSize(labelSize)
    .text(label, x + 4, y + 4, { width: w - 8, align });

  doc.font("Helvetica")
    .fontSize(valueSize)
    .text(value, x + 4, y + 18, { width: w - 8, align });
}

function drawSectionTitle(doc, y, title) {
  doc.save();
  doc.rect(20, y, 555, 16).fillAndStroke("#f4b400", "#000000");
  doc.fillColor("#000000")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(title, 20, y + 4, { width: 555, align: "center" });
  doc.restore();
}

function drawWrappedField(doc, y, title, content, minHeight = 70) {
  const x = 20;
  const w = 555;
  const innerX = x + 6;
  const innerW = w - 12;

  const textHeight = doc.heightOfString(content || "-", {
    width: innerW,
    align: "justify",
  });

  const h = Math.max(minHeight, 24 + textHeight + 8);

  drawBox(doc, x, y, w, h);

  doc.font("Helvetica-Bold")
    .fontSize(9)
    .text(title, innerX, y + 5);

  doc.font("Helvetica")
    .fontSize(9)
    .text(content || "-", innerX, y + 20, {
      width: innerW,
      align: "justify",
    });

  return y + h + 8;
}

function drawSimpleTableHeader(doc, y) {
  const cols = [
    { x: 24, w: 36, t: "ATIV." },
    { x: 60, w: 50, t: "QTD" },
    { x: 110, w: 220, t: "DESCRIÇÃO" },
    { x: 330, w: 120, t: "RESPONSÁVEL" },
    { x: 450, w: 121, t: "REFERÊNCIA" },
  ];

  cols.forEach((c) => {
    drawBox(doc, c.x, y, c.w, 18);
    doc.font("Helvetica-Bold")
      .fontSize(8)
      .text(c.t, c.x, y + 5, { width: c.w, align: "center" });
  });

  return y + 18;
}

function drawSimpleTableRow(doc, y, row) {
  const cols = [
    { x: 24, w: 36, v: row.ativ || "" },
    { x: 60, w: 50, v: row.qtd || "" },
    { x: 110, w: 220, v: row.descricao || "" },
    { x: 330, w: 120, v: row.responsavel || "" },
    { x: 450, w: 121, v: row.referencia || "" },
  ];

  const heights = cols.map((c) =>
    Math.max(
      18,
      doc.heightOfString(c.v || "-", {
        width: c.w - 8,
        align: "center",
      }) + 8
    )
  );

  const h = Math.max(...heights);

  cols.forEach((c) => {
    drawBox(doc, c.x, y, c.w, h);
    doc.font("Helvetica")
      .fontSize(8)
      .text(c.v || "-", c.x + 4, y + 5, {
        width: c.w - 8,
        align: "center",
      });
  });

  return y + h;
}

function drawCheckboxLine(doc, x, y, label, checked) {
  doc.rect(x, y, 10, 10).stroke();
  if (checked) {
    doc.font("Helvetica-Bold").fontSize(10).text("X", x + 1.5, y - 0.5);
  }
  doc.font("Helvetica").fontSize(8.5).text(label, x + 16, y - 1);
}

function drawPhotoFrame(doc, x, y, w, h, title, foto) {
  drawBox(doc, x, y, w, h);

  doc.font("Helvetica-Bold")
    .fontSize(9)
    .text(title, x, y + 4, { width: w, align: "center" });

  const imgX = x + 8;
  const imgY = y + 20;
  const imgW = w - 16;
  const imgH = h - 30;

  if (!foto || !foto.caminho) {
    doc.font("Helvetica")
      .fontSize(9)
      .text("Sem imagem", x, y + h / 2 - 5, { width: w, align: "center" });
    return;
  }

  const caminhoImagem = path.resolve("uploads", foto.caminho);

  if (!fs.existsSync(caminhoImagem)) {
    console.error("Imagem não encontrada no PDF:", caminhoImagem);
    doc.font("Helvetica")
      .fontSize(8)
      .text(`Imagem não encontrada:\n${foto.caminho}`, x + 8, y + h / 2 - 12, {
        width: w - 16,
        align: "center",
      });
    return;
  }

  try {
    doc.image(caminhoImagem, imgX, imgY, {
      fit: [imgW, imgH],
      align: "center",
      valign: "center",
    });
  } catch (e) {
    console.error("Erro ao renderizar imagem no PDF:", caminhoImagem, e.message);
    doc.font("Helvetica")
      .fontSize(8)
      .text(`Erro ao carregar imagem:\n${path.basename(caminhoImagem)}`, x + 8, y + h / 2 - 12, {
        width: w - 16,
        align: "center",
      });
  }
}

function gerarRelatorio(id) {
  db.get(
    `
    SELECT 
      ordens_servico.*,
      usinas.nome as usina,
      usinas.cidade as usina_cidade,
      tecnico.nome as tecnico_nome,
      verificador.nome as verificador_nome,
      aprovador.nome as aprovador_nome,
      tipos_falha.nome as tipo_falha_nome
    FROM ordens_servico
    LEFT JOIN usinas ON usinas.id = ordens_servico.usina_id
    LEFT JOIN usuarios as tecnico ON tecnico.id = ordens_servico.tecnico_id
    LEFT JOIN usuarios as verificador ON verificador.id = ordens_servico.verificador_id
    LEFT JOIN usuarios as aprovador ON aprovador.id = ordens_servico.aprovador_id
    LEFT JOIN tipos_falha ON tipos_falha.id = ordens_servico.tipo_falha_id
    WHERE ordens_servico.id = ?
    `,
    [id],
    (err, os) => {
      if (err || !os) {
        console.error("Erro ao buscar OS para PDF:", err?.message);
        return;
      }

      db.all(
        `
        SELECT * FROM fotos
        WHERE ordem_id = ?
        ORDER BY id ASC
        `,
        [id],
        (errFotos, fotos) => {
          if (errFotos) {
            console.error("Erro ao buscar fotos para PDF:", errFotos.message);
            return;
          }

          const arquivo = path.join("uploads", `relatorio_os_${id}.pdf`);
          const stream = fs.createWriteStream(arquivo);
          const doc = new PDFDocument({ size: "A4", margin: 20 });

          doc.pipe(stream);

          const ticket = `TICKET OS-${os.id}`;
          const projeto = txt(os.usina);
          const localProjeto = txt(os.usina_cidade || os.local);
          const localInterno = txt(os.local || "Usina");
          const tipoTrabalho = txt(os.tipo_falha_nome || os.tipo);
          const descricaoOcorrencia = txt(os.descricao);
          const descricaoAtividade = txt(os.observacoes || os.descricao);
          const respAtividade = txt(os.tecnico_nome);
          const respRealizacao = txt(os.tecnico_nome);
          const respValidacao = txt(os.verificador_nome);
          const respAceite = txt(os.aprovador_nome);
          const dataAbertura = formatarDataBR(os.data_abertura);
          const dataInicio = formatarDataHoraBR(os.data_inicio);
          const dataFim = formatarDataHoraBR(os.data_fim);
          const dataFechamento = formatarDataBR(os.data_fim);

          /* ========= PÁGINA 1 ========= */

          // Cabeçalho
          drawBox(doc, 20, 20, 555, 50);
          drawBox(doc, 20, 20, 120, 50);
          drawBox(doc, 140, 20, 290, 50);
          drawLabelValue(doc, 430, 20, 75, 25, "N°", ticket, { align: "center", valueSize: 8 });
          drawLabelValue(doc, 505, 20, 70, 25, "DATA", dataAbertura, { align: "center", valueSize: 8 });

          doc.font("Helvetica-Bold").fontSize(16).text("ILUMISOL", 20, 37, { width: 120, align: "center" });
          doc.font("Helvetica-Bold").fontSize(13).text("ORDEM DE SERVIÇO", 140, 32, {
            width: 290,
            align: "center",
          });
          doc.font("Helvetica-Bold").fontSize(9).text("RELATÓRIO DE ATIVIDADES EXECUTADAS", 140, 49, {
            width: 290,
            align: "center",
          });

          drawLabelValue(doc, 20, 75, 370, 32, "Projeto", projeto, { align: "center", valueSize: 10 });
          drawLabelValue(doc, 390, 75, 185, 32, "LOCAL", localProjeto, { align: "center", valueSize: 10 });

          drawLabelValue(doc, 20, 111, 180, 30, "LOCAL:", localInterno, { valueSize: 9 });
          drawLabelValue(doc, 200, 111, 150, 30, "DATA INICIO", dataInicio, { align: "center", valueSize: 8.5 });
          drawLabelValue(doc, 350, 111, 225, 30, "DATA FIM / TEMPO DA ATIVIDADE", dataFim, {
            align: "center",
            valueSize: 8.5,
          });

          let y = 146;

          drawSectionTitle(doc, y, "OCORRÊNCIA DA ATIVIDADE");
          y += 22;
          y = drawWrappedField(doc, y, "", descricaoOcorrencia, 90);

          drawSectionTitle(doc, y, "LISTAGEM DE ATIVIDADES");
          y += 22;

          y = drawSimpleTableHeader(doc, y);
          y = drawSimpleTableRow(doc, y, {
            ativ: "1",
            qtd: "1,00",
            descricao: tipoTrabalho,
            responsavel: respAtividade,
            referencia: "-",
          });

          for (let i = 2; i <= 5; i++) {
            y = drawSimpleTableRow(doc, y, {
              ativ: String(i),
              qtd: "",
              descricao: "",
              responsavel: "",
              referencia: "",
            });
          }

          y += 10;

          // Criticidade / Tipo OS
          drawBox(doc, 20, y, 270, 84);
          doc.font("Helvetica-Bold").fontSize(9).text("CRITICIDADE DA ATIVIDADE", 24, y + 5);
          drawCheckboxLine(doc, 26, y + 24, "Leve", String(os.prioridade).toLowerCase() === "baixa");
          drawCheckboxLine(doc, 26, y + 44, "Moderada", String(os.prioridade).toLowerCase() === "media");
          drawCheckboxLine(
            doc,
            26,
            y + 64,
            "Grave",
            ["alta", "critica"].includes(String(os.prioridade).toLowerCase())
          );

          drawBox(doc, 305, y, 270, 84);
          doc.font("Helvetica-Bold").fontSize(9).text("TIPO DE ORDEM DE SERVIÇO", 309, y + 5);
          drawCheckboxLine(doc, 311, y + 24, "PONTUAL", true);
          drawCheckboxLine(doc, 411, y + 24, "RECORRENTE", false);
          drawCheckboxLine(doc, 311, y + 44, "PROGRAMADA", false);
          drawCheckboxLine(doc, 411, y + 44, "NÃO PROGRAMADA", true);

          y += 94;

          // Responsáveis
          drawLabelValue(doc, 20, y, 135, 40, "Responsável Realização", respRealizacao, {
            align: "center",
            valueSize: 8.5,
          });
          drawLabelValue(doc, 155, y, 135, 40, "Responsável Validação", respValidacao, {
            align: "center",
            valueSize: 8.5,
          });
          drawLabelValue(doc, 290, y, 135, 40, "Responsável Aceite", respAceite, {
            align: "center",
            valueSize: 8.5,
          });
          drawLabelValue(doc, 425, y, 150, 40, "Data de Fechamento da OS", dataFechamento, {
            align: "center",
            valueSize: 8.5,
          });

          y += 50;

          drawWrappedField(
            doc,
            y,
            `RESPONSÁVEL DA ATIVIDADE: ${respAtividade}\nATIVIDADE: ${tipoTrabalho}\nDescrição:`,
            descricaoAtividade,
            180
          );

          doc.font("Helvetica").fontSize(8).text(`GERADO POR: ${respAtividade}`, 24, 802);
          doc.text("FORM-138 REV00", 250, 802);
          doc.text(`OS_${id} 1 / 2`, 490, 802);

          /* ========= PÁGINA 2 ========= */

          doc.addPage({ size: "A4", margin: 20 });

          drawBox(doc, 20, 20, 555, 50);
          drawBox(doc, 20, 20, 120, 50);
          drawBox(doc, 140, 20, 290, 50);
          drawLabelValue(doc, 430, 20, 75, 25, "N°", ticket, { align: "center", valueSize: 8 });
          drawLabelValue(doc, 505, 20, 70, 25, "DATA", dataAbertura, { align: "center", valueSize: 8 });

          doc.font("Helvetica-Bold").fontSize(16).text("ILUMISOL", 20, 37, { width: 120, align: "center" });
          doc.font("Helvetica-Bold").fontSize(13).text("ORDEM DE SERVIÇO", 140, 32, {
            width: 290,
            align: "center",
          });
          doc.font("Helvetica-Bold").fontSize(9).text("RELATÓRIO DE ATIVIDADES EXECUTADAS", 140, 49, {
            width: 290,
            align: "center",
          });

          drawLabelValue(doc, 20, 75, 370, 32, "PROJETO", projeto, { align: "center", valueSize: 10 });
          drawLabelValue(doc, 390, 75, 185, 32, "LOCAL", localProjeto, { align: "center", valueSize: 10 });

          drawSectionTitle(doc, 112, "REGISTRO FOTOGRÁFICO");

          const frames = [
            { x: 20, y: 138, w: 268, h: 280, title: "FOTO 1", foto: fotos[0] },
            { x: 307, y: 138, w: 268, h: 280, title: "FOTO 2", foto: fotos[1] },
            { x: 20, y: 438, w: 268, h: 280, title: "FOTO 3", foto: fotos[2] },
            { x: 307, y: 438, w: 268, h: 280, title: "FOTO 4", foto: fotos[3] },
          ];

          frames.forEach((f) => {
            drawPhotoFrame(doc, f.x, f.y, f.w, f.h, f.title, f.foto);
          });

          doc.font("Helvetica").fontSize(8).text("FORM-138 REV00", 24, 802);
          doc.text(`OS_${id} 2 / 2`, 490, 802);

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

  console.log("Iniciando geração de PDF da OS:", id);

  db.get(`SELECT id FROM ordens_servico WHERE id=?`, [id], (err, row) => {
    if (err) {
      console.error("Erro ao consultar OS para PDF:", err.message);
      return res.status(500).json({
        erro: "Erro ao gerar relatório",
        detalhe: err.message,
      });
    }

    if (!row) {
      return res.status(404).json({ erro: "OS não encontrada" });
    }

    try {
      gerarRelatorio(id);

      return res.json({
        ok: true,
        mensagem: "Relatório solicitado com sucesso",
      });
    } catch (e) {
      console.error("Erro ao chamar gerarRelatorio:", e.message);
      return res.status(500).json({
        erro: "Erro ao gerar relatório",
        detalhe: e.message,
      });
    }
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

      res.setHeader("Content-Type", "application/pdf");
      return res.sendFile(path.resolve(row.arquivo));
    }
  );
});

/* ==============================
   ROTAS FINAIS
============================== */

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
  const usuarioId = req.user.id;
  const usuarioTipo = req.user.tipo;
  const fotoId = req.params.id;

  db.get(
    `
    SELECT fotos.*, ordens_servico.tecnico_id
    FROM fotos
    JOIN ordens_servico ON ordens_servico.id = fotos.ordem_id
    WHERE fotos.id = ?
    `,
    [fotoId],
    (err, foto) => {
      if (err) {
        return res.status(500).json({ erro: "Erro ao buscar foto" });
      }

      if (!foto) {
        return res.status(404).json({ erro: "Foto não encontrada" });
      }

      if (usuarioTipo === "tecnico" && foto.tecnico_id !== usuarioId) {
        return res.status(403).json({ erro: "Sem permissão" });
      }

      const caminho = path.join("uploads", foto.caminho);

      db.run(`DELETE FROM fotos WHERE id=?`, [fotoId], function (errDelete) {
        if (errDelete) {
          return res.status(500).json({ erro: "Erro ao apagar foto" });
        }

        if (fs.existsSync(caminho)) {
          fs.unlinkSync(caminho);
        }

        return res.json({ ok: true });
      });
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