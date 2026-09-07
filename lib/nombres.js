// Compara un nombre completo (por ejemplo, del roster maestro que da RH)
// contra un nombre registrado en el portal, que puede venir abreviado
// (ej. "Aaron Sandoval" en vez de "Sandoval Medina Rodrigo Aaron").
// No es una comparacion exacta -- es una coincidencia por palabras, para
// tolerar nombres incompletos o con un typo ocasional.

function normalizarNombre(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

function nombresCoinciden(nombreA, nombreB) {
  const a = normalizarNombre(nombreA);
  const b = normalizarNombre(nombreB);
  if (!a.length || !b.length) return false;
  const corto = a.length <= b.length ? a : b;
  const largo = a.length <= b.length ? b : a;
  if (corto.length < 2) return false;
  const setLargo = new Set(largo);
  const coincidencias = corto.filter(w => setLargo.has(w)).length;
  // Al menos 2 palabras compartidas, y al menos la mitad del nombre mas
  // corto debe encontrarse en el nombre mas largo.
  return coincidencias >= 2 && (coincidencias / corto.length) >= 0.5;
}

module.exports = { normalizarNombre, nombresCoinciden };
