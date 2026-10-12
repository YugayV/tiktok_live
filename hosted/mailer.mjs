// Transactional e-mail through Resend's HTTP API (https://resend.com). No SDK, no SMTP.
// Without RESEND_API_KEY the mailer is disabled; in dev it can print messages to the log instead.

export function createMailer({ apiKey = '', from = '', fetchImpl = globalThis.fetch, log = console.log, devLog = false } = {}) {
  const enabled = Boolean(apiKey && from) || devLog;
  async function send({ to, subject, text, html }) {
    if (!apiKey || !from) {
      if (devLog) log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
      return;
    }
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return { enabled, send };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function resetEmail(link) {
  const text = `Вы запросили сброс пароля TikLive Studio.\n\nНовый пароль можно задать по ссылке (действует 1 час):\n${link}\n\nЕсли вы не запрашивали сброс — просто проигнорируйте это письмо, пароль останется прежним.`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#1b1d27">
<h2 style="margin:0 0 12px">Сброс пароля TikLive Studio</h2>
<p>Вы запросили сброс пароля. Ссылка действует 1 час.</p>
<p style="margin:24px 0"><a href="${esc(link)}" style="background:#fe2c55;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700">Задать новый пароль</a></p>
<p style="color:#666;font-size:13px">Если кнопка не работает, откройте ссылку: <br>${esc(link)}</p>
<p style="color:#666;font-size:13px">Если вы не запрашивали сброс — просто проигнорируйте письмо, пароль останется прежним.</p></div>`;
  return { subject: 'Сброс пароля TikLive Studio', text, html };
}
