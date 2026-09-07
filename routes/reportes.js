const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendSlackMessage } = require('../lib/slack');

const router = express.Router();

const ZONA = 'America/Mexico_City';
const HORA_ENTRADA_LIMITE = '10:00';
const HORA_SALIDA_LIMITE = '18:00';

function hoyISO() {
  // 'sv-SE' da formato AAAA-MM-DD de forma confiable con cualquier version de Node.
  return new Date().toLocaleDateString('sv-SE', { timeZone: ZONA });
}

function mesActualISO() {
  return hoyISO().slice(0, 7);
}

function horaMexico24(epochMs) {
  return new Date(epochMs).toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', timeZone: ZONA
  });
}

// --- Asistencia de hoy: quien llego tarde, quien salio temprano, quien no marco ---
async function getResumenAsistenciaHoy() {
  const hoy = hoyISO();
  const asistencias = await pool.query(
    `SELECT email, asistencia_movimiento, created_at
     FROM solicitudes
     WHERE tipo = 'Asistencia'
       AND to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE '${ZONA}', 'YYYY-MM-DD') = $1`,
    [hoy]
  );

  const porEmail = {};
  for (const row of asistencias.rows) {
    const email = row.email;
    const hora = horaMexico24(Number(row.created_at));
    if (!porEmail[email]) porEmail[email] = { entrada: null, salida: null };
    if (row.asistencia_movimiento === 'entrada') {
      if (!porEmail[email].entrada || hora < porEmail[email].entrada) porEmail[email].entrada = hora;
    } else if (row.asistencia_movimiento === 'salida') {
      if (!porEmail[email].salida || hora > porEmail[email].salida) porEmail[email].salida = hora;
    }
  }

  const colaboradores = await pool.query(
    `SELECT nombre, email FROM colaboradores WHERE role = 'colaborador' ORDER BY nombre`
  );

  return colaboradores.rows.map(c => {
    const datos = porEmail[c.email] || { entrada: null, salida: null };
    return {
      nombre: c.nombre,
      email: c.email,
      entrada: datos.entrada,
      salida: datos.salida,
      tarde: !!(datos.entrada && datos.entrada > HORA_ENTRADA_LIMITE),
      salidaTemprana: !!(datos.salida && datos.salida < HORA_SALIDA_LIMITE),
      salidaTardia: !!(datos.salida && datos.salida > HORA_SALIDA_LIMITE),
      sinRegistro: !datos.entrada,
      sinSalida: !!(datos.entrada && !datos.salida)
    };
  });
}

// --- Incidencias de un mes dado (formato 'YYYY-MM') ---
async function fetchIncidenciasDelMes(mes) {
  const result = await pool.query(
    `SELECT folio, nombre, email, motivo, created_at
     FROM solicitudes
     WHERE tipo = 'Incidencia'
       AND to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE '${ZONA}', 'YYYY-MM') = $1
     ORDER BY created_at ASC`,
    [mes]
  );
  return result.rows.map(r => ({
    folio: r.folio,
    nombre: r.nombre,
    email: r.email,
    motivo: r.motivo,
    fecha: new Date(Number(r.created_at)).toLocaleDateString('es-MX', { timeZone: ZONA })
  }));
}

async function getResumenIncidenciasPorColaborador(mes) {
  const filas = await fetchIncidenciasDelMes(mes);
  const porEmail = {};
  for (const f of filas) {
    if (!porEmail[f.email]) porEmail[f.email] = { nombre: f.nombre, total: 0, detalle: [] };
    porEmail[f.email].total++;
    porEmail[f.email].detalle.push(f);
  }
  return Object.values(porEmail).sort((a, b) => b.total - a.total);
}

function csvEscape(s) {
  if (s == null) return '';
  return `"${String(s).replace(/"/g, '""')}"`;
}

// ===================== Endpoints para ver en el portal =====================

// GET /api/reportes/asistencia-hoy
// El rol 'supervisor' SOLO tiene acceso a este endpoint de todo /api/reportes
// y de todo /api/solicitudes -- es su unica ventana al sistema.
router.get('/asistencia-hoy', requireAuth, requireRole('admin', 'visualizador', 'supervisor'), async (req, res) => {
  const resumen = await getResumenAsistenciaHoy();
  res.json({ resumen });
});

// GET /api/reportes/incidencias-mensual?mes=YYYY-MM
router.get('/incidencias-mensual', requireAuth, requireRole('admin', 'visualizador'), async (req, res) => {
  const mes = req.query.mes || mesActualISO();
  const resumen = await getResumenIncidenciasPorColaborador(mes);
  res.json({ mes, resumen });
});

// GET /api/reportes/incidencias-mensual.csv?mes=YYYY-MM  (se abre directo en Excel)
router.get('/incidencias-mensual.csv', requireAuth, requireRole('admin', 'visualizador'), async (req, res) => {
  const mes = req.query.mes || mesActualISO();
  const filas = await fetchIncidenciasDelMes(mes);
  const encabezado = 'Folio,Colaborador,Correo,Fecha,Motivo\n';
  const cuerpo = filas
    .map(f => [f.folio, csvEscape(f.nombre), csvEscape(f.email), f.fecha, csvEscape(f.motivo)].join(','))
    .join('\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="incidencias-${mes}.csv"`);
  // El caracter al inicio (BOM) es para que Excel muestre bien los acentos.
  res.send('\uFEFF' + encabezado + cuerpo);
});

// ===================== Endpoints para las alertas automaticas =====================
// Estos NO requieren sesion (no los usa el navegador) -- los llama un
// servicio externo de "cron" gratuito, y se protegen con un secreto
// compartido para que nadie mas pueda dispararlos.

function autorizadoParaCron(req) {
  return !!process.env.CRON_SECRET && req.query.secret === process.env.CRON_SECRET;
}

// GET /api/reportes/cron/aviso-tardanzas?secret=...
// Pensado para correr todos los dias a las 10:30 am (hora Mexico).
// Reporta quien ya registro su entrada tarde (despues de las 10:00 am).
router.get('/cron/aviso-tardanzas', async (req, res) => {
  if (!autorizadoParaCron(req)) return res.status(403).json({ error: 'No autorizado.' });

  const resumen = await getResumenAsistenciaHoy();
  const tarde = resumen.filter(r => r.tarde);

  let texto = `*Aviso 10:30 am — entradas tarde de hoy (${hoyISO()})*`;
  texto += tarde.length
    ? `\n\n:warning: *Llegaron despues de las 10:00 am:*\n` + tarde.map(r => `• ${r.nombre} — ${r.entrada}`).join('\n')
    : `\n\n:white_check_mark: Nadie ha llegado tarde hasta ahora.`;

  await sendSlackMessage(texto);
  res.json({ ok: true });
});

// GET /api/reportes/cron/aviso-salidas?secret=...
// Pensado para correr todos los dias a las 6:30 pm (hora Mexico).
// Reporta salida temprana, salida tardia, y quien no marco salida.
router.get('/cron/aviso-salidas', async (req, res) => {
  if (!autorizadoParaCron(req)) return res.status(403).json({ error: 'No autorizado.' });

  const resumen = await getResumenAsistenciaHoy();
  const salidaTemprana = resumen.filter(r => r.salidaTemprana);
  const salidaTardia = resumen.filter(r => r.salidaTardia);
  const sinSalida = resumen.filter(r => r.sinSalida);

  let texto = `*Aviso 6:30 pm — salidas de hoy (${hoyISO()})*`;
  texto += salidaTemprana.length
    ? `\n\n:warning: *Salieron antes de las 6:00 pm:*\n` + salidaTemprana.map(r => `• ${r.nombre} — ${r.salida}`).join('\n')
    : `\n\n:white_check_mark: Nadie salio antes de las 6:00 pm.`;
  texto += salidaTardia.length
    ? `\n\n:clock4: *Salieron despues de las 6:00 pm:*\n` + salidaTardia.map(r => `• ${r.nombre} — ${r.salida}`).join('\n')
    : '';
  texto += sinSalida.length
    ? `\n\n:grey_question: *No han marcado salida:*\n` + sinSalida.map(r => `• ${r.nombre} — entrada ${r.entrada}`).join('\n')
    : '';

  await sendSlackMessage(texto);
  res.json({ ok: true });
});

// GET /api/reportes/cron/reporte-mensual?secret=...
// Por default reporta el MES ANTERIOR (pensado para correr el dia 1 de cada mes).
router.get('/cron/reporte-mensual', async (req, res) => {
  if (!autorizadoParaCron(req)) return res.status(403).json({ error: 'No autorizado.' });

  let mes = req.query.mes;
  if (!mes) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    mes = d.toLocaleDateString('sv-SE', { timeZone: ZONA }).slice(0, 7);
  }

  const resumen = await getResumenIncidenciasPorColaborador(mes);
  let texto = `*Reporte mensual de incidencias — ${mes}*`;
  texto += resumen.length
    ? '\n\n' + resumen.map(r => `• ${r.nombre}: ${r.total} incidencia(s)`).join('\n')
    : '\n\nNo hubo incidencias registradas este mes.';

  await sendSlackMessage(texto);
  res.json({ ok: true });
});

module.exports = router;
