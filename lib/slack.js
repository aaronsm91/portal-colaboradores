// Envia un mensaje de texto a Slack usando un "Incoming Webhook".
// Si no hay SLACK_WEBHOOK_URL configurado, solo lo imprime en los logs
// (util mientras pruebas, o si decides no usar Slack).
async function sendSlackMessage(text) {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.log('[DEV] SLACK_WEBHOOK_URL no configurado. Mensaje que se hubiera enviado a Slack:\n' + text);
    return;
  }
  try {
    const res = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      console.error('Slack respondio con error:', res.status, await res.text());
    }
  } catch (e) {
    console.error('No se pudo enviar el mensaje a Slack:', e.message);
  }
}

module.exports = { sendSlackMessage };
