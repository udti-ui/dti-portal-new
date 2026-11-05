import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeStudentYear } from './studentData';
import { appendTelegramPortalFooter, escapeTelegramHtml } from './telegram';

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

export async function notifyStudentsAboutAnnouncement(
  supabase: SupabaseClient,
  announcement: AnnouncementNotification
): Promise<TelegramSendResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return { sent: 0, failed: 0, status: 'missing_bot_token' };

  const { data, error } = await supabase.from('students').select('*');
  if (error) {
    console.error('ANNOUNCEMENT_TELEGRAM_RECIPIENTS_LOOKUP_FAILED:', error.message);
    return { sent: 0, failed: 1, status: 'sent' };
  }

  const chatIds = [...new Set((data ?? []).flatMap((row) => {
    const student = row as Record<string, unknown>;
    const year = normalizeStudentYear(
      student['السنه الدراسية'] ?? student['السنة الدراسية'] ?? student.year ?? student.student_year
    );
    const enabled = student.telegram_notifications_enabled ?? student['telegram_notifications_enabled'];
    const enabledValue = enabled === true || ['true', '1', 'yes'].includes(String(enabled ?? '').toLowerCase());
    const chatId = String(student.telegram_chat_id ?? student['telegram_chat_id'] ?? '').trim();
    return (!announcement.student_year || year === announcement.student_year) && enabledValue && chatId ? [chatId] : [];
  }))];

  if (!chatIds.length) return { sent: 0, failed: 0, status: 'no_subscribers' };

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

  for (let offset = 0; offset < chatIds.length; offset += 20) {
    const batch = chatIds.slice(offset, offset + 20);
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
