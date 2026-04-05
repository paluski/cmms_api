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
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use("/uploads", express.static("uploads"));

/* ==============================
   AUX
============================== */

function normalizarTexto(v) {
  return v ? String(v).trim() : "";
}

function normalizarNumero(v) {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function garantirUploads() {
  if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
}

garantirUploads();

/* ==============================
   DB
============================== */

const db = new sqlite3.Database("database.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      email TEXT,
      senha TEXT,
      tipo TEXT,
      ativo INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usinas(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      cidade TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ordens_servico(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usina_id INTEGER,
      tecnico_id INTEGER,
      descricao TEXT,
      status TEXT,
      data_abertura TEXT,
      data_inicio TEXT,
      data_fim TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS fotos(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ordem_id INTEGER,
      caminho TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS relatorios(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ordem_id INTEGER,
      arquivo TEXT
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO usuarios(id,nome,email,senha,tipo)
    VALUES(1,'Admin','admin@email.com','123456','admin')
  `);
});

/* ==============================
   AUTH
============================== */

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ erro: "Sem token" });

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: "Token inválido" });
  }
}

/* ==============================
   LOGIN
============================== */

app.post("/login", (req, res) => {
  const { email, senha } = req.body;

  db.get(
    "SELECT * FROM usuarios WHERE email=? AND senha=?",
    [email, senha],
    (err, user) => {
      if (!user) return res.status(401).json({ erro: "Login inválido" });

      const token = jwt.sign(user, SECRET);
      res.json({ ...user, token });
    }
  );
});

/* ==============================
   ORDENS
============================== */

app.get("/ordens", auth, (req, res) => {
  db.all("SELECT * FROM ordens_servico", (err, rows) => {
    res.json(rows);
  });
});

app.post("/ordens", auth, (req, res) => {
  const { descricao } = req.body;

  db.run(
    `
    INSERT INTO ordens_servico(descricao,status,data_abertura)
    VALUES(?, 'aberta', datetime('now'))
  `,
    [descricao],
    function () {
      res.json({ id: this.lastID });
    }
  );
});

app.put("/ordens/:id/start", auth, (req, res) => {
  db.run(
    `
    UPDATE ordens_servico
    SET status='em_execucao', data_inicio=datetime('now')
    WHERE id=?
  `,
    [req.params.id],
    () => res.json({ ok: true })
  );
});

app.put("/ordens/:id/concluir", auth, (req, res) => {
  db.run(
    `
    UPDATE ordens_servico
    SET status='para_verificacao', data_fim=datetime('now')
    WHERE id=?
  `,
    [req.params.id],
    () => res.json({ ok: true })
  );
});

/* ==============================
   UPLOAD
============================== */

const storage = multer.diskStorage({
  destination: "uploads",
  filename: (req, file, cb) => {
    cb(null, Date.now() + "_" + file.originalname);
  },
});

const upload = multer({ storage });

app.post("/upload/:ordem", auth, upload.single("foto"), (req, res) => {
  db.run(
    `
    INSERT INTO fotos(ordem_id,caminho)
    VALUES(?,?)
  `,
    [req.params.ordem, req.file.filename],
    () => res.json({ ok: true })
  );
});

/* ==============================
   GERAR PDF
============================== */

function gerarRelatorio(id) {
  db.get(
    `
    SELECT * FROM ordens_servico WHERE id=?
  `,
    [id],
    (err, ordem) => {
      if (!ordem) return;

      const nome = `uploads/relatorio_${id}.pdf`;
      const doc = new PDFDocument();

      doc.pipe(fs.createWriteStream(nome));

      doc.fontSize(18).text("RELATÓRIO OS", { align: "center" });
      doc.moveDown();
      doc.text(`OS: ${ordem.id}`);
      doc.text(`Descrição: ${ordem.descricao}`);
      doc.text(`Status: ${ordem.status}`);

      doc.end();

      db.run(
        `
        INSERT INTO relatorios(ordem_id,arquivo)
        VALUES(?,?)
      `,
        [id, nome]
      );
    }
  );
}

app.post("/relatorio/:id", auth, (req, res) => {
  gerarRelatorio(req.params.id);
  res.json({ ok: true });
});

app.get("/relatorio/:id", auth, (req, res) => {
  db.get(
    `
    SELECT * FROM relatorios WHERE ordem_id=? ORDER BY id DESC LIMIT 1
  `,
    [req.params.id],
    (err, row) => {
      if (!row) return res.status(404).send("Não encontrado");

      res.sendFile(path.resolve(row.arquivo));
    }
  );
});

/* ==============================
   SERVER
============================== */

const PORT = 3000;

app.listen(PORT, () => {
  console.log("Rodando na porta", PORT);
});