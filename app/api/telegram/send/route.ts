import { NextResponse } from 'next/server';
import { appendTelegramPortalFooter } from '../../../../lib/telegram';

export const dynamic = 'force-dynamic';

type TelegramSendRequest = {
  message?: string;
  chatId?: string;
  enabled?: boolean;
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as TelegramSendRequest;
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = String(body.chatId ?? '').trim();
    const message = typeof body.message === 'string' ? body.message : '';

    if (!botToken) {
      return NextResponse.json({ ok: false, status: 'missing_bot_token' }, { status: 500 });
    }

    if (body.enabled === false || !chatId || !message.trim()) {
      return NextResponse.json({ ok: false, status: 'disabled_or_missing_chat_id' }, { status: 400 });
    }

    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: appendTelegramPortalFooter(message),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const payload = await telegramResponse.json();
    return NextResponse.json(payload, { status: telegramResponse.ok ? 200 : 502 });
  } catch (error) {
    console.error('Telegram send route failed:', error);
    return NextResponse.json({ ok: false, status: 'telegram_send_failed' }, { status: 500 });
  }
}
