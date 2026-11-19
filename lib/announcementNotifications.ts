import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeStudentYear } from './studentData';
import { appendTelegramPortalFooter, escapeTelegramHtml } from './telegram';
import { sendEmail } from './email';

type AnnouncementNotification = {
  title: string;
  content: string;
  subject: string | null;
  student_year: string | null;
  author_type: 'admin' | 'teacher';
  author_name: string;
  attachment_name?: string | null;
  notification_type?: 'announcement' | 'lecture';
};

type TelegramSendResult = {
  sent: number;
  failed: number;
  status: 'sent' | 'no_subscribers' | 'missing_bot_token';
};

type NotificationChannel = 'telegram' | 'email';
type ChannelResult = {
  sent: number;
  failed: number;
  status: 'sent' | 'no_subscribers' | 'missing_bot_token' | 'missing_smtp' | 'failed';
};

const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function notifyStudentsByTelegram(
  supabase: SupabaseClient,
  announcement: AnnouncementNotification
): Promise<TelegramSendResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return { sent: 0, failed: 0, status: 'missing_bot_token' };

  const chatIds = new Set<string>();
  for (let offset = 0; offset < 100000; offset += 500) {
    let query = supabase.from('students')
      .select('telegram_chat_id, "السنه الدراسية"')
      .eq('telegram_notifications_enabled', true)
      .not('telegram_chat_id', 'is', null)
      .order('الرقم الجامعي', { ascending: true })
      .range(offset, offset + 499);
    if (announcement.student_year) query = query.eq('السنه الدراسية', announcement.student_year);
    const { data, error } = await query;
    if (error) {
      console.error('ANNOUNCEMENT_TELEGRAM_RECIPIENTS_LOOKUP_FAILED:', error.message);
      return { sent: 0, failed: 1, status: 'sent' };
    }

    for (const row of data ?? []) {
      const student = row as Record<string, unknown>;
      const year = normalizeStudentYear(student['السنه الدراسية']);
      const chatId = String(student.telegram_chat_id ?? '').trim();
      if ((!announcement.student_year || year === announcement.student_year) && chatId) chatIds.add(chatId);
    }
    if ((data ?? []).length < 500) break;
  }

  if (!chatIds.size) return { sent: 0, failed: 0, status: 'no_subscribers' };

  const author = announcement.author_type === 'admin'
    ? 'الإدارة'
    : `المدرس ${announcement.author_name}`;
  const message = [
    `${announcement.notification_type === 'lecture' ? '📚 <b>محاضرة جديدة</b>' : '📢 <b>إعلان جديد</b>'}`,
    '━━━━━━━━━━━━━━━━━━',
    `👤 <b>بواسطة:</b> ${escapeTelegramHtml(author)}`,
    `🎯 <b>الفئة المستهدفة:</b> ${escapeTelegramHtml(announcement.student_year ? `السنة ${announcement.student_year}` : 'كل السنوات')}`,
    ...(announcement.subject ? [`📖 <b>المادة:</b> ${escapeTelegramHtml(announcement.subject)}`] : []),
    `📝 <b>${announcement.notification_type === 'lecture' ? 'عنوان المحاضرة' : 'العنوان'}:</b> ${escapeTelegramHtml(announcement.title)}`,
    ...(announcement.attachment_name ? [`📎 <b>المرفق:</b> ${escapeTelegramHtml(announcement.attachment_name)} (متاح في صفحة الطالب)`] : []),
    '━━━━━━━━━━━━━━━━━━',
    '',
    `<b>التفاصيل:</b>\n${escapeTelegramHtml(announcement.content.slice(0, 3200))}${announcement.content.length > 3200 ? '…' : ''}`,
  ].join('\n');
  let sent = 0;
  let failed = 0;

  const recipients = [...chatIds];
  for (let offset = 0; offset < recipients.length; offset += 20) {
    const batch = recipients.slice(offset, offset + 20);
    const results = await Promise.all(batch.map(async (chatId) => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: appendTelegramPortalFooter(message),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
        });
        const payload = await response.json() as { ok?: boolean; description?: string };
        if (response.ok && payload.ok) return 'sent';
        console.error('ANNOUNCEMENT_TELEGRAM_SEND_FAILED:', {
          chatId,
          status: response.status,
          description: payload.description,
        });
      } catch (error) {
        console.error('ANNOUNCEMENT_TELEGRAM_REQUEST_FAILED:', error);
      }
      return 'failed';
    }));
    sent += results.filter((result) => result === 'sent').length;
    failed += results.filter((result) => result === 'failed').length;
  }

  return { sent, failed, status: 'sent' };
}

async function notifyStudentsByEmail(
  supabase: SupabaseClient,
  announcement: AnnouncementNotification
): Promise<ChannelResult> {
  if (!(process.env.SMTP_PASS?.trim() || process.env.GMAIL_PASS?.trim())) {
    return { sent: 0, failed: 0, status: 'missing_smtp' };
  }

  const recipients = new Map<string, string>();
  for (let offset = 0; offset < 100000; offset += 500) {
    const { data, error } = await supabase.from('students')
      .select('"البريد الإلكتروني", "السنه الدراسية"')
      .not('البريد الإلكتروني', 'is', null)
      .order('الرقم الجامعي', { ascending: true })
      .range(offset, offset + 499);
    if (error) {
      console.error('ANNOUNCEMENT_EMAIL_RECIPIENTS_LOOKUP_FAILED:', error.message);
      return { sent: 0, failed: 1, status: 'failed' };
    }

    for (const row of data ?? []) {
      const student = row as Record<string, unknown>;
      const year = normalizeStudentYear(student['السنه الدراسية']);
      const email = String(student['البريد الإلكتروني'] ?? '').trim();
      if ((!announcement.student_year || year === announcement.student_year)
        && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        recipients.set(email.toLocaleLowerCase(), email);
      }
    }
    if ((data ?? []).length < 500) break;
  }

  if (!recipients.size) return { sent: 0, failed: 0, status: 'no_subscribers' };

  const announcementType = announcement.notification_type === 'lecture' ? 'محاضرة جديدة' : 'إعلان جديد';
  const subjectTitle = announcement.title.replace(/[\r\n]+/g, ' ').trim();
  const details = escapeHtml(announcement.content).replace(/\r?\n/g, '<br>');
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Tahoma,sans-serif;color:#1e293b">
    <main style="max-width:620px;margin:0 auto;padding:24px;background:#fff;border-radius:12px">
      <h2 style="margin-top:0;color:#0f766e">${announcementType}</h2>
      <p><strong>العنوان:</strong> ${escapeHtml(announcement.title)}</p>
      ${announcement.subject ? `<p><strong>المادة:</strong> ${escapeHtml(announcement.subject)}</p>` : ''}
      ${announcement.attachment_name ? `<p><strong>المرفق:</strong> ${escapeHtml(announcement.attachment_name)} (متاح في صفحة الطالب)</p>` : ''}
      <hr style="border:0;border-top:1px solid #e2e8f0">
      <p style="line-height:1.9">${details}</p>
      <p><a href="https://my-dti.netlify.app/">فتح بوابة الطالب</a></p>
    </main>
  </body>
</html>`;
  const addresses = [...recipients.values()];
  let sent = 0;
  let failed = 0;
  for (let offset = 0; offset < addresses.length; offset += 10) {
    const batch = addresses.slice(offset, offset + 10);
    const results = await Promise.all(batch.map((to) => sendEmail({
      to,
      subject: `${announcementType}: ${subjectTitle}`,
      html,
    })));
    sent += results.filter((result) => result.success).length;
    failed += results.filter((result) => !result.success).length;
  }

  return { sent, failed, status: failed ? 'failed' : 'sent' };
}

export async function notifyStudentsAboutAnnouncement(
  supabase: SupabaseClient,
  announcement: AnnouncementNotification,
  channels: NotificationChannel[] = ['telegram']
) {
  const results: Partial<Record<NotificationChannel, ChannelResult>> = {};
  if (channels.includes('telegram')) {
    results.telegram = await notifyStudentsByTelegram(supabase, announcement);
  }
  if (channels.includes('email')) {
    results.email = await notifyStudentsByEmail(supabase, announcement);
  }

  const selectedResults = Object.values(results);
  const sent = selectedResults.reduce((total, result) => total + (result?.sent ?? 0), 0);
  const failed = selectedResults.reduce((total, result) => total + (result?.failed ?? 0), 0);
  const status = results.telegram?.status ?? results.email?.status ?? 'sent';
  return { sent, failed, status, channels: results };
}
