import nodemailer from 'nodemailer';
import { HttpError } from '../http.js';

function emailConfig() {
  const user = process.env.EMAIL_USER?.trim() || '';
  const pass = process.env.EMAIL_PASS?.trim() || '';
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  return {
    host: process.env.EMAIL_HOST?.trim() || 'smtp.gmail.com',
    port,
    user,
    pass,
    from: process.env.EMAIL_FROM?.trim() || user,
    enabled: Boolean(user && pass),
  };
}

export function mailEnabled(): boolean {
  return emailConfig().enabled;
}

export async function sendPasswordCode(to: string, code: string): Promise<void> {
  const email = emailConfig();
  if (!email.enabled) {
    throw new HttpError(503, 'El envío de correo no está configurado en el servidor.');
  }
  const transporter = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.port === 465,
    auth: { user: email.user, pass: email.pass },
  });
  try {
    await transporter.sendMail({
      from: `"Balance" <${email.from}>`,
      to,
      subject: 'Código para cambiar la contraseña de Balance',
      text: `Tu código de Balance es ${code}.\n\nCaduca en 10 minutos. Si no has pedido cambiar la contraseña, ignora este mensaje.`,
      html: `<p style="font-family:sans-serif;color:#0f172a">Tu código de Balance es</p><p style="font-family:monospace;font-size:32px;font-weight:800;letter-spacing:6px;color:#0f172a">${code}</p><p style="font-family:sans-serif;color:#64748b;font-size:14px">Caduca en 10 minutos. Si no has pedido cambiar la contraseña, ignora este mensaje.</p>`,
    });
  } catch (error) {
    console.error('[EMAIL] No se ha podido enviar el código.');
    throw new HttpError(502, 'No se ha podido enviar el código. Inténtalo de nuevo.');
  }
}
