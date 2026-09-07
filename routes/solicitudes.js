const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { nombresCoinciden } = require('../lib/nombres');

const router = express.Router();

// Guardamos el adjunto en memoria y lo convertimos a base64 para meterlo en
// la base de datos, en vez de escribirlo en disco. Los planes gratuitos de
// hosting (Render free, etc.) no tienen disco persistente -- cualquier
// archivo escrito ahi se perderia en el siguiente reinicio o despliegue.
// Con archivos limitados a 2 MB esto es perfectamente viable.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (req, file, cb) => {
    const permitido = file.mimetype === 'application/pdf' || file.mimetype.startsWith('image/');
    cb(permitido ? null : new Error('Solo se permiten archivos PDF o imagenes.'), permitido);
  }
});

async function nuevoFolio() {
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM solicitudes');
  const count = result.rows[0].n + 1;
  const year = new Date().getFullYear();
  return `RH-${year}-${String(count).padStart(4, '0')}`;
}

// POST /api/solicitudes
router.post('/', requireAuth, upload.single('adjunto'), async (req, res) => {
  // El rol 'supervisor' es de solo lectura (unicamente el reporte de
  // asistencia de hoy) -- no puede crear solicitudes ni registrar su
  // propia asistencia desde aqui.
  if (req.user.role === 'supervisor') {
    return res.status(403).json({ error: 'Tu acceso es de solo consulta.' });
  }

  const { tipo, fechaInicio, fechaFin, motivo, movimiento, lat, lng } = req.body;
  const tiposValidos = ['Vacaciones', 'Incidencia', 'Incapacidad', 'Asistencia'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({ error: 'Tipo de solicitud invalido.' });
  }

  const folio = await nuevoFolio();
  const createdAt = Date.now();

  // Entrada o salida, con ubicacion. Queda registrada de inmediato, sin
  // pasar por aprobacion (igual que la asistencia autoregistrada de antes).
  if (tipo === 'Asistencia') {
    if (!['entrada', 'salida'].includes(movimiento)) {
      return res.status(400).json({ error: 'Indica si es entrada o salida.' });
    }
    const ahora = new Date();
    const isoFecha = ahora.toISOString().slice(0, 10);
    const latNum = lat !== undefined && lat !== '' ? Number(lat) : null;
    const lngNum = lng !== undefined && lng !== '' ? Number(lng) : null;
    await pool.query(
      `INSERT INTO solicitudes
        (folio, email, nombre, tipo, fecha_inicio, fecha_fin, motivo, estado,
         asistencia_hora, asistencia_fecha, asistencia_ip, asistencia_por,
         asistencia_movimiento, asistencia_lat, asistencia_lng, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, '', 'registrada', $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        folio, req.user.email, req.user.nombre, tipo, isoFecha, isoFecha,
        ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' }),
        ahora.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' }),
        req.ip,
        req.user.nombre,
        movimiento,
        Number.isFinite(latNum) ? latNum : null,
        Number.isFinite(lngNum) ? lngNum : null,
        createdAt
      ]
    );
    return res.status(201).json({ folio });
  }

  // Incidencia: solo motivo y adjunto opcional, sin rango de fechas.
  if (tipo === 'Incidencia') {
    if (!motivo || !motivo.trim()) {
      return res.status(400).json({ error: 'Describe el motivo de la incidencia.' });
    }
    const adjuntoNombre = req.file ? req.file.originalname : null;
    const adjuntoMime = req.file ? req.file.mimetype : null;
    const adjuntoData = req.file ? req.file.buffer.toString('base64') : null;
    await pool.query(
      `INSERT INTO solicitudes
        (folio, email, nombre, tipo, motivo, adjunto_nombre, adjunto_mime, adjunto_data, estado, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente', $9)`,
      [folio, req.user.email, req.user.nombre, tipo, motivo.trim(), adjuntoNombre, adjuntoMime, adjuntoData, createdAt]
    );
    return res.status(201).json({ folio });
  }

  // Vacaciones / Incapacidad: requieren rango de fechas.
  if (!fechaInicio || !fechaFin) {
    return res.status(400).json({ error: 'Selecciona fecha de inicio y fin.' });
  }
  if (fechaFin < fechaInicio) {
    return res.status(400).json({ error: 'La fecha fin no puede ser anterior a la fecha inicio.' });
  }

  const adjuntoNombre = req.file ? req.file.originalname : null;
  const adjuntoMime = req.file ? req.file.mimetype : null;
  const adjuntoData = req.file ? req.file.buffer.toString('base64') : null;

  await pool.query(
    `INSERT INTO solicitudes
      (folio, email, nombre, tipo, fecha_inicio, fecha_fin, motivo, adjunto_nombre, adjunto_mime, adjunto_data, estado, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendiente', $11)`,
    [folio, req.user.email, req.user.nombre, tipo, fechaInicio, fechaFin, motivo || '', adjuntoNombre, adjuntoMime, adjuntoData, createdAt]
  );

  res.status(201).json({ folio });
});

// GET /api/solicitudes  (colaborador: solo las suyas; admin/visualizador: todas)
// No incluye adjunto_data (puede pesar), solo si tiene adjunto o no.
router.get('/', requireAuth, async (req, res) => {
  // El rol 'supervisor' no ve solicitudes (vacaciones, incidencias, etc.),
  // solo el reporte de asistencia via /api/reportes.
  if (req.user.role === 'supervisor') {
    return res.status(403).json({ error: 'Tu acceso es de solo consulta de asistencia.' });
  }
  const cols = `id, folio, email, nombre, tipo, fecha_inicio, fecha_fin, motivo, estado,
                (adjunto_data IS NOT NULL) AS tiene_adjunto, adjunto_nombre,
                asistencia_hora, asistencia_fecha, asistencia_ip, asistencia_por,
                asistencia_movimiento, asistencia_lat, asistencia_lng, created_at`;
  const result = req.user.role === 'colaborador'
    ? await pool.query(`SELECT ${cols} FROM solicitudes WHERE email = $1 ORDER BY created_at DESC`, [req.user.email])
    : await pool.query(`SELECT ${cols} FROM solicitudes ORDER BY created_at DESC`);
  res.json({ solicitudes: result.rows });
});

// GET /api/solicitudes/colaboradores  (admin/visualizador)
router.get('/colaboradores', requireAuth, requireRole('admin', 'visualizador'), async (req, res) => {
  const result = await pool.query(
    'SELECT id, nombre, email, role, ip, registered_at, home_office_dias FROM colaboradores ORDER BY registered_at DESC'
  );
  res.json({ colaboradores: result.rows });
});

// PATCH /api/solicitudes/colaboradores/:email/home-office  (solo admin)
// Body: { dias: [1,3] }  -- 1=lunes ... 5=viernes
router.patch('/colaboradores/:email/home-office', requireAuth, requireRole('admin'), async (req, res) => {
  const dias = Array.isArray(req.body.dias) ? req.body.dias : [];
  const validos = dias.every(d => Number.isInteger(d) && d >= 1 && d <= 5);
  if (!validos) {
    return res.status(400).json({ error: 'Dias invalidos.' });
  }
  const diasUnicos = [...new Set(dias)];
  const result = await pool.query(
    'UPDATE colaboradores SET home_office_dias = $1 WHERE email = $2 RETURNING email',
    [diasUnicos, req.params.email]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Colaborador no encontrado.' });
  res.json({ ok: true });
});

// GET /api/solicitudes/roster-faltantes  (admin/visualizador)
// Compara la lista maestra (roster_esperado) contra quien ya esta
// registrado como colaborador, y devuelve quienes de esa lista todavia
// no tienen cuenta. Se calcula en vivo en cada llamada, para que nunca
// quede desactualizado conforme la gente se va registrando.
router.get('/roster-faltantes', requireAuth, requireRole('admin', 'visualizador'), async (req, res) => {
  const roster = await pool.query(
    'SELECT nombre_completo, departamento FROM roster_esperado ORDER BY departamento, nombre_completo'
  );
  const colaboradores = await pool.query(`SELECT nombre FROM colaboradores WHERE role = 'colaborador'`);
  const faltantes = roster.rows.filter(r =>
    !colaboradores.rows.some(c => nombresCoinciden(r.nombre_completo, c.nombre))
  );
  res.json({ faltantes, totalRoster: roster.rows.length });
});

// PATCH /api/solicitudes/:folio/estado  (solo admin)
router.patch('/:folio/estado', requireAuth, requireRole('admin'), async (req, res) => {
  const { estado } = req.body;
  if (!['aprobada', 'rechazada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado invalido.' });
  }
  const result = await pool.query('UPDATE solicitudes SET estado = $1 WHERE folio = $2 RETURNING folio', [estado, req.params.folio]);
  if (!result.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  res.json({ ok: true });
});

// POST /api/solicitudes/:folio/asistencia  (solo admin -- registra hora local e IP)
router.post('/:folio/asistencia', requireAuth, requireRole('admin'), async (req, res) => {
  const ahora = new Date();
  const result = await pool.query(
    `UPDATE solicitudes
     SET asistencia_hora = $1, asistencia_fecha = $2, asistencia_ip = $3, asistencia_por = $4, estado = 'registrada'
     WHERE folio = $5 RETURNING folio`,
    [
      ahora.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Mexico_City' }),
      ahora.toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' }),
      req.ip,
      req.user.nombre,
      req.params.folio
    ]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  res.json({ ok: true });
});

// GET /api/solicitudes/:folio/adjunto  (dueno de la solicitud, admin o visualizador)
router.get('/:folio/adjunto', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM solicitudes WHERE folio = $1', [req.params.folio]);
  const row = result.rows[0];
  if (!row || !row.adjunto_data) return res.status(404).json({ error: 'No hay adjunto para esta solicitud.' });
  const esDueno = row.email === req.user.email;
  const puedeVer = esDueno || ['admin', 'visualizador'].includes(req.user.role);
  if (!puedeVer) return res.status(403).json({ error: 'No tienes permiso para ver este archivo.' });

  const buffer = Buffer.from(row.adjunto_data, 'base64');
  res.set('Content-Type', row.adjunto_mime || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${row.adjunto_nombre || 'adjunto'}"`);
  res.send(buffer);
});

module.exports = router;
