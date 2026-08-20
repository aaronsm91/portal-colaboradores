const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' }
});

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8 horas
  };
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, nombre: user.nombre, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res) => {
  const { nombre, email, password, role, codigo } = req.body;

  if (!nombre || !email || !password) {
    return res.status(400).json({ error: 'Completa nombre, correo y contrasena.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
  }
  const rolFinal = ['colaborador', 'admin', 'visualizador'].includes(role) ? role : 'colaborador';
  if (rolFinal !== 'colaborador' && codigo !== process.env.ACCESS_CODE) {
    return res.status(403).json({ error: 'Codigo de acceso incorrecto para ese rol.' });
  }

  const emailLower = email.toLowerCase();
  const existente = await pool.query('SELECT id FROM colaboradores WHERE email = $1', [emailLower]);
  if (existente.rows.length) {
    return res.status(409).json({ error: 'Ese correo ya esta registrado.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const ip = req.ip;
  const registeredAt = Date.now();

  const result = await pool.query(
    `INSERT INTO colaboradores (nombre, email, password_hash, role, ip, registered_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [nombre, emailLower, passwordHash, rolFinal, ip, registeredAt]
  );

  const user = { id: result.rows[0].id, email: emailLower, nombre, role: rolFinal };
  const token = signToken(user);
  res.cookie('session', token, cookieOptions());
  res.status(201).json({ user });
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Ingresa correo y contrasena.' });
  }
  const result = await pool.query('SELECT * FROM colaboradores WHERE email = $1', [email.toLowerCase()]);
  const row = result.rows[0];
  if (!row) {
    return res.status(401).json({ error: 'Correo o contrasena incorrectos.' });
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Correo o contrasena incorrectos.' });
  }
  const user = { id: row.id, email: row.email, nombre: row.nombre, role: row.role };
  const token = signToken(user);
  res.cookie('session', token, cookieOptions());
  res.json({ user });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('session', cookieOptions());
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  // Respuesta generica siempre, exista o no la cuenta -- evita que alguien
  // pueda usar este endpoint para saber que correos estan registrados.
  const generic = { ok: true, message: 'Si el correo esta registrado, recibiras un enlace en unos minutos.' };
  if (!email) return res.json(generic);

  const result = await pool.query('SELECT * FROM colaboradores WHERE email = $1', [email.toLowerCase()]);
  const row = result.rows[0];
  if (!row) return res.json(generic);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hora
  await pool.query('DELETE FROM reset_tokens WHERE email = $1', [row.email]);
  await pool.query('INSERT INTO reset_tokens (token, email, expires_at) VALUES ($1, $2, $3)', [token, row.email, expiresAt]);

  const resetLink = `${process.env.APP_URL}/?token=${token}`;
  const mailer = getMailer();
  if (mailer) {
    try {
      await mailer.sendMail({
        from: process.env.EMAIL_FROM,
        to: row.email,
        subject: 'Restablece tu contrasena',
        text: `Entra a este enlace para restablecer tu contrasena (valido 1 hora): ${resetLink}`,
        html: `<p>Entra a este enlace para restablecer tu contrasena (valido 1 hora):</p><p><a href="${resetLink}">${resetLink}</a></p>`
      });
    } catch (e) {
      console.error('No se pudo enviar el correo de restablecimiento:', e.message);
    }
  } else {
    console.log('[DEV] SMTP no configurado. Enlace de restablecimiento para', row.email, ':', resetLink);
  }

  res.json(generic);
});

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Falta el token o la nueva contrasena.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contrasena debe tener al menos 6 caracteres.' });
  }
  const result = await pool.query('SELECT * FROM reset_tokens WHERE token = $1', [token]);
  const row = result.rows[0];
  if (!row || Number(row.expires_at) < Date.now()) {
    return res.status(400).json({ error: 'El enlace es invalido o ha expirado. Solicita uno nuevo.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE colaboradores SET password_hash = $1 WHERE email = $2', [passwordHash, row.email]);
  await pool.query('DELETE FROM reset_tokens WHERE token = $1', [token]);
  res.json({ ok: true });
});

module.exports = router;
