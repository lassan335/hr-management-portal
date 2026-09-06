import nodemailer, { Transporter } from "nodemailer";
import { NotificationType } from "@hr/shared";
import { env } from "./env";
import { prisma } from "./prisma";

let transporter: Transporter | null = null;
function getTransporter(): Transporter | null {
  if (!env.smtpHost) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPass } : undefined,
    });
  }
  return transporter;
}

/** In-app notification, fired on submit/approve/reject. Emails if SMTP is
 * configured; otherwise logs to console so nothing is silently lost in dev. */
export async function notify(params: {
  staffId: string;
  type: NotificationType;
  message: string;
  email?: string;
}) {
  await prisma.notification.create({
    data: { staffId: params.staffId, type: params.type, message: params.message },
  });

  const mailer = getTransporter();
  if (mailer && params.email) {
    await mailer.sendMail({
      from: env.smtpFrom,
      to: params.email,
      subject: `HR Portal: ${params.type.replace(/_/g, " ").toLowerCase()}`,
      text: params.message,
    });
  } else if (!mailer) {
    console.log(`[notify:${params.type}] staff=${params.staffId} ${params.message}`);
  }
}
