const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable de entorno DATABASE_URL (cadena de conexion de Postgres).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (y la mayoria de proveedores gratuitos de Postgres) exigen SSL.
  // rejectUnauthorized:false es lo habitual para conectarse a proveedores
  // gestionados como Neon/Supabase sin instalar su cadena de certificados
  // manualmente. Ponlo en false solo si te conectas a un Postgres local.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS colaboradores (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('colaborador','admin','visualizador','supervisor')),
      ip TEXT,
      registered_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      folio TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL REFERENCES colaboradores(email),
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('Vacaciones','Incidencia','Incapacidad','Asistencia')),
      fecha_inicio TEXT,
      fecha_fin TEXT,
      motivo TEXT,
      adjunto_nombre TEXT,
      adjunto_mime TEXT,
      adjunto_data TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobada','rechazada','registrada')),
      asistencia_hora TEXT,
      asistencia_fecha TEXT,
      asistencia_ip TEXT,
      asistencia_por TEXT,
      asistencia_movimiento TEXT CHECK(asistencia_movimiento IN ('entrada','salida')),
      asistencia_lat DOUBLE PRECISION,
      asistencia_lng DOUBLE PRECISION,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);

  // --- Migraciones ---
  // Estas sentencias permiten que una base de datos creada ANTES de este
  // cambio (con 'Home office' y sin columnas de entrada/salida/ubicacion)
  // se actualice sola la primera vez que el servidor arranca con este
  // codigo. Si la tabla se acaba de crear arriba desde cero, estas
  // sentencias simplemente no encuentran nada que cambiar.
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_movimiento TEXT;`);
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_lat DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_lng DOUBLE PRECISION;`);

  // Se quita primero la restriccion vieja (que no permite 'Incidencia' aun)
  // para poder convertir cualquier solicitud de prueba que haya quedado
  // con el tipo anterior 'Home office', y luego se agrega la restriccion
  // nueva ya con 'Incidencia' permitido.
  await pool.query(`ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS solicitudes_tipo_check;`);
  await pool.query(`UPDATE solicitudes SET tipo = 'Incidencia' WHERE tipo = 'Home office';`);
  await pool.query(`
    ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_tipo_check
    CHECK (tipo IN ('Vacaciones','Incidencia','Incapacidad','Asistencia')) NOT VALID;
  `);

  await pool.query(`ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS solicitudes_asistencia_movimiento_check;`);
  await pool.query(`
    ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_asistencia_movimiento_check
    CHECK (asistencia_movimiento IS NULL OR asistencia_movimiento IN ('entrada','salida')) NOT VALID;
  `);

  // Agrega el rol 'supervisor' (acceso de solo lectura, unicamente al
  // reporte de asistencia de hoy -- sin ver colaboradores, solicitudes
  // ni incidencias). Como solo se agrega una opcion nueva, los datos
  // existentes ya cumplen la restriccion sin necesidad de "NOT VALID".
  await pool.query(`ALTER TABLE colaboradores DROP CONSTRAINT IF EXISTS colaboradores_role_check;`);
  await pool.query(`
    ALTER TABLE colaboradores ADD CONSTRAINT colaboradores_role_check
    CHECK (role IN ('colaborador','admin','visualizador','supervisor'));
  `);

  // Dias de la semana (1=lunes ... 5=viernes) en los que un colaborador
  // trabaja desde casa segun el esquema hibrido. Vacio = siempre presencial.
  await pool.query(`ALTER TABLE colaboradores ADD COLUMN IF NOT EXISTS home_office_dias INTEGER[] NOT NULL DEFAULT '{}';`);

  // --- Roster maestro (la lista de quienes DEBEN usar la plataforma) ---
  // Es independiente de quien ya se registro -- sirve para comparar y
  // avisar en el panel de RH quienes de esta lista aun no tienen cuenta.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roster_esperado (
      id SERIAL PRIMARY KEY,
      nombre_completo TEXT NOT NULL,
      departamento TEXT,
      home_office_dias INTEGER[] NOT NULL DEFAULT '{}',
      created_at BIGINT NOT NULL
    );
  `);

  // Semilla inicial del roster -- solo se inserta la primera vez (si la
  // tabla ya tiene datos, no se toca; asi RH puede editarla libremente
  // despues sin que se reinserte o se resetee en cada reinicio).
  const rosterCount = await pool.query('SELECT COUNT(*)::int AS n FROM roster_esperado');
  if (rosterCount.rows[0].n === 0) {
    const ahora = Date.now();
    const rosterInicial = [
      ['Sandoval Medina Rodrigo Aaron', 'Ventas', [4]],
      ['Arce Gonzalez Gerardo Jacobo', 'Ventas', [2, 3]],
      ['Martinez Beltran Juan Alberto', 'Ventas', [4]],
      ['Godinez Rodriguez Jonnathan Habib', 'Ventas', [2, 4]],
      ['Garcia Garfias Carlos Eduardo', 'Ventas', [1, 2]],
      ['Garcia Ferreira Guillermo', 'Ventas', [1, 4]],
      ['Ruiz Miguel Patricio', 'Ventas', [1, 4]],
      ['Gordillo Mata Katia Viridiana', 'Ventas', [2, 3]],
      ['Sandoval Medina Jesus Eduardo', 'Finanzas', [5]],
      ['Lopez Lopez Karla Andrea', 'Finanzas', [2, 4]],
      ['Suarez Arevalo Manuel Enrique', 'Finanzas', [1, 2, 3, 5]],
      ['Perez Ramirez Isaias Emanuel', 'Finanzas', [5]],
      ['Vera Hernandez Tabatha', 'Finanzas', [1, 3, 4]],
      ['Arreola Navarro Oscar', 'Finanzas', [4, 5]],
      ['Rojas Lindero Mariana', 'Finanzas', [1, 5]],
      ['Rincon Nunez Francisco Roman', 'Finanzas', [5]],
      ['Gomez Perez Edgar Uriel', 'Finanzas', [2, 4, 5]],
      ['Garduno Ortega Sebastian', 'Direccion', [5]],
      ['Ramirez Galindo Diego Josue', 'Direccion', [5]]
    ];
    for (const [nombre, depto, dias] of rosterInicial) {
      await pool.query(
        'INSERT INTO roster_esperado (nombre_completo, departamento, home_office_dias, created_at) VALUES ($1,$2,$3,$4)',
        [nombre, depto, dias, ahora]
      );
    }
  }

  // Intenta aplicar automaticamente los dias de home office del roster a
  // colaboradores ya registrados, cuando el nombre coincide con confianza
  // Y el colaborador aun no tiene dias configurados -- para no pisar un
  // ajuste manual que RH haya hecho despues desde el panel.
  const { nombresCoinciden } = require('./lib/nombres');
  const roster = await pool.query('SELECT nombre_completo, home_office_dias FROM roster_esperado');
  const colabsSinConfigurar = await pool.query(
    `SELECT email, nombre FROM colaboradores WHERE role = 'colaborador' AND home_office_dias = '{}'`
  );
  for (const colab of colabsSinConfigurar.rows) {
    const match = roster.rows.find(r => nombresCoinciden(r.nombre_completo, colab.nombre));
    if (match && match.home_office_dias.length) {
      await pool.query('UPDATE colaboradores SET home_office_dias = $1 WHERE email = $2', [match.home_office_dias, colab.email]);
    }
  }
}

module.exports = { pool, init };
