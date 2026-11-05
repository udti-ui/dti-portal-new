import { NextResponse } from 'next/server';
import { appendTelegramPortalFooter, escapeTelegramHtml } from '../../../lib/telegram';

export const dynamic = 'force-dynamic';

type TelegramMessage = {
  text?: unknown;
  chat?: { id?: unknown };
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export async function POST(request: Request) {
  try {
    const update = await request.json() as TelegramUpdate;
    const message = update.message ?? update.edited_message;
    const chatId = message?.chat?.id;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

    if (!token) {
      console.error('Telegram webhook rejected: TELEGRAM_BOT_TOKEN is not configured.');
      return NextResponse.json({ ok: false, error: 'Telegram bot token is not configured' }, { status: 500 });
    }

    if (typeof chatId !== 'number' && typeof chatId !== 'string') {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const isStartCommand = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text);
    const responseText = isStartCommand
      ? `👋 <b>أهلاً بك في بوابة المعهد!</b>\n\n🆔 <b>معرف المحادثة (Chat ID):</b>\n<code>${escapeTelegramHtml(chatId)}</code>\n\nانسخ هذا الرقم والصقه في إعدادات حسابك لربط تيليجرام.`
      : `✅ <b>تم استلام رسالتك بنجاح.</b>\n\n🆔 <b>معرف المحادثة (Chat ID):</b>\n<code>${escapeTelegramHtml(chatId)}</code>`;

    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: appendTelegramPortalFooter(responseText),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const payload = await telegramResponse.json() as { ok?: boolean; description?: string };
    if (!telegramResponse.ok || payload.ok !== true) {
      console.error('Telegram webhook reply failed:', {
        status: telegramResponse.status,
        description: payload.description,
      });
      return NextResponse.json({ ok: false, error: 'Telegram reply failed' }, { status: 502 });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Error handling telegram webhook:', error);
    return NextResponse.json({ ok: false, error: 'Telegram webhook failed' }, { status: 500 });
  }
}
