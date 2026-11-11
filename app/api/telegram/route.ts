import { NextResponse } from 'next/server';
import { appendTelegramPortalFooter, escapeTelegramHtml } from '../../../lib/telegram';

export const dynamic = 'force-dynamic';

type TelegramMessage = {
  text?: unknown;
  chat?: { id?: unknown };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export async function POST(request: Request) {
  let update: TelegramUpdate;

  try {
    update = await request.json() as TelegramUpdate;
  } catch (error) {
    console.error('Invalid Telegram webhook payload:', error);
    return NextResponse.json({ ok: false, error: 'Invalid webhook payload' }, { status: 400 });
  }

  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;

  if ((typeof chatId !== 'number' && typeof chatId !== 'string') || !message) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const isStartCommand = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
  const reply = isStartCommand
    ? `👋 <b>أهلاً بك في بوابة المعهد!</b>\n\n🆔 <b>معرف المحادثة (Chat ID):</b>\n<code>${escapeTelegramHtml(chatId)}</code>\n\nانسخ هذا الرقم والصقه في إعدادات حسابك لربط تيليجرام.`
    : `✅ <b>تم استلام رسالتك بنجاح.</b>\n\n🆔 <b>معرف المحادثة (Chat ID):</b>\n<code>${escapeTelegramHtml(chatId)}</code>`;

  return NextResponse.json({
    method: 'sendMessage',
    chat_id: chatId,
    text: appendTelegramPortalFooter(reply),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, { status: 200 });
}
